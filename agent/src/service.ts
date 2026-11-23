/**
 * The server's owner-facing operations, independent of any HTTP framework.
 * The Next.js route handlers in web/ parse a request, call one of these, and
 * send back the result or the HttpError.
 *
 * How a request is tied to a wallet (no extra passkey prompt):
 *
 * - Creating a plan only makes a pending row and a fresh session key whose
 *   private half never leaves the server. It grants nothing: the key can do
 *   nothing until the wallet's admin authorizes it onchain. Pending plans are
 *   rate limited per wallet.
 * - Activating a plan requires the chain to show that the wallet's account
 *   holds exactly this server-generated key, valid in the KeyStore, with the
 *   plan's allowlist, cap, period and expiry. Only the wallet's admin (its
 *   passkey) can authorize a key on its account, so this is the proof that the
 *   owner asked for the plan.
 * - Stopping a plan requires the chain to show the session is no longer
 *   active (revoked or expired). Nobody can stop someone else's plan without
 *   the owner's revoke.
 *
 * The SDK offers no admin-passkey message signature (signOrder signs with a
 * session key), and the account cannot verify ERC-1271 signatures before its
 * first transaction (it is counterfactual until then), so a signed-challenge
 * scheme would not cover a new wallet's first plan anyway.
 */
import { timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import type { SerializedSession } from "@altananetwork/sdk";
import {
  isPlanPeriod,
  planAmountFromUsdt,
  PLAN_DURATION_SECS,
  utcDayOfWeek,
  utcHour,
  type PlanPeriod,
} from "@autumn/core";
import { GrantCheckError, confirmGrant, createPlan, grantOf } from "./plans.js";
import type { ChainReader } from "./ports.js";
import type { Storage } from "./storage/types.js";
import type { PlanRecord, RunLogEntry } from "./types.js";

/**
 * An answer with an HTTP status. `code` is a stable machine-readable reason the
 * app branches on (the message is for people and may change); `extra` is sent
 * with it in the JSON body.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Celo could not be read (RPC or transport failure): the client should try again; nothing was decided. */
const chainUnavailable = (what: string) => new HttpError(503, `Celo could not be read ${what}; try again in a few seconds`, "chain_unavailable");

export type ServiceDeps = {
  storage: Storage;
  chain: ChainReader;
  encryptionKey: Buffer;
  goldBuyer: Address;
  /** Unconfirmed plans a wallet may have within PENDING_PLAN_TTL_SECS. Default 3. */
  maxPendingPerWallet?: number;
  /** Plans a wallet may have in total (all states, after stale pending plans are pruned). Default 100. */
  maxPlansPerWallet?: number;
  /** Per-client (IP) limiter for POST /api/plans; omitted, no per-client limit. */
  createLimiter?: RateLimiter;
};

/**
 * An unconfirmed plan counts against its wallet's limit only this long, so a
 * stranger who creates plans for someone else's wallet blocks it for minutes
 * at most. A grant normally lands within a minute of the plan's creation.
 */
export const PENDING_PLAN_TTL_SECS = 600;
/**
 * Unconfirmed plans older than this are deleted with their session key when
 * the wallet creates a new plan. A key granted onchain after that is no use
 * to the server; the app finds it from the chain and offers to revoke it.
 */
export const PENDING_PLAN_RETENTION_SECS = 3600;

/** A fixed-window counter per key (an IP address), in memory: one per server instance. */
export type RateLimiter = { take(key: string): boolean };

export function createRateLimiter(opts: { limit: number; windowMs: number; clock?: () => number; maxKeys?: number }): RateLimiter {
  const { limit, windowMs, clock = Date.now, maxKeys = 10_000 } = opts;
  const hits = new Map<string, { start: number; n: number }>();
  return {
    take(key: string): boolean {
      const now = clock();
      const h = hits.get(key);
      if (!h || now - h.start >= windowMs) {
        if (hits.size >= maxKeys) {
          for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
          if (hits.size >= maxKeys) hits.clear();
        }
        hits.set(key, { start: now, n: 1 });
        return true;
      }
      if (h.n >= limit) return false;
      h.n++;
      return true;
    },
  };
}

/** How far the expiry the browser showed may be from now + 12 weeks (browser and chain clocks differ). */
export const EXPIRY_TOLERANCE_SECS = 15 * 60;

function obj(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "the request body must be a JSON object");
  return body as Record<string, unknown>;
}

function walletOf(v: unknown): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new HttpError(400, "wallet must be a 20-byte hex address");
  // All-lowercase or all-uppercase hex carries no checksum; mixed case must be a correct EIP-55 checksum (a typo otherwise).
  const body = v.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && !isAddress(v, { strict: true })) {
    throw new HttpError(400, "wallet has a mixed-case address with a wrong checksum");
  }
  return getAddress(v.toLowerCase());
}

function txHashOf(v: unknown, name: string): Hex {
  if (typeof v !== "string" || !isHex(v) || v.length !== 66) throw new HttpError(400, `${name} must be a 32-byte transaction hash`);
  return v.toLowerCase() as Hex;
}

export type CreatePlanResponse = {
  planId: string;
  sessionPublicKey: Hex;
  /** The session the browser must grant, exactly (limits as decimal strings). */
  expected: SerializedSession;
  period: PlanPeriod;
  periodCap: string;
  buysPerPeriod: number;
  feeToken: Address;
  expiry: number;
};

/**
 * POST /api/plans. Body: { wallet, amountUsdt: a JSON number from 1 to 100 with at
 * most 2 decimals (4.5 is 4.50 USD₮), period: "week"|"day", dipBuy: boolean,
 * expiresAt: unix seconds the browser showed }. The amount becomes USD₮ base
 * units with decimal-string maths (planAmountFromUsdt), never `amount * 1e6`.
 */
export async function createPlanRequest(deps: ServiceDeps, body: unknown, client?: { ip?: string | null }): Promise<CreatePlanResponse> {
  if (deps.createLimiter && !deps.createLimiter.take(client?.ip || "unknown")) {
    throw new HttpError(429, "too many plans created from this address; try again in a few minutes");
  }
  const b = obj(body);
  const wallet = walletOf(b.wallet);
  const amount = planAmountFromUsdt(b.amountUsdt);
  if (!amount.ok) throw new HttpError(400, amount.problem);
  const period = b.period ?? "week";
  if (!isPlanPeriod(period)) throw new HttpError(400, 'period must be "week" or "day"');
  if (b.dipBuy !== undefined && typeof b.dipBuy !== "boolean") throw new HttpError(400, "dipBuy must be a boolean");
  const expiresAt = b.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isInteger(expiresAt)) throw new HttpError(400, "expiresAt must be unix seconds");

  const head = await deps.chain.head();
  const now = head.timestamp;
  if (Math.abs(expiresAt - (now + PLAN_DURATION_SECS)) > EXPIRY_TOLERANCE_SECS) {
    throw new HttpError(400, "expiresAt must be 12 weeks from now; reload the plan screen and try again");
  }
  await deps.storage.deletePendingPlansBefore(wallet, now - PENDING_PLAN_RETENTION_SECS);
  const amountPerBuy = amount.value;
  const dipBuy = b.dipBuy === true;

  // A wallet has at most one young plan waiting for its grant. A retry with the same choices gets the same plan and
  // key back (nothing is counted up); different choices replace it, but only when the client says so and the chain
  // shows its key was never granted. A key that is granted onchain means the passkey already paid for it: that plan
  // must be started, never replaced by a second grant.
  const young = (await deps.storage.listPlansForWallet(wallet)).filter(
    (p) => p.status === "pending_grant" && p.createdAt >= now - PENDING_PLAN_TTL_SECS,
  );
  const replace: PlanRecord[] = [];
  for (const p of young) {
    let st;
    try {
      st = await deps.chain.sessionState(p.walletAddress, p.sessionPublicKey);
    } catch {
      throw chainUnavailable("to check this wallet's plan that is waiting to start");
    }
    if (st.onAccount || st.status === "active") {
      throw new HttpError(409, "this wallet already granted the agent key of a plan that is waiting to start; start that plan instead", "pending_plan_granted", {
        planId: p.id,
        sessionPublicKey: p.sessionPublicKey,
        expected: createPlanResponse(p, sessionGrantOf(deps, p, now)).expected,
      });
    }
    if (p.amountPerBuy === amountPerBuy && p.period === period && p.dipBuy === dipBuy && p.expiresAt === expiresAt) {
      return createPlanResponse(p, sessionGrantOf(deps, p, now));
    }
    replace.push(p);
  }
  if (replace.length) {
    if (b.replacePending !== true) {
      throw new HttpError(409, "this wallet has a plan waiting for its passkey approval; finish or replace it", "pending_plan_exists", { planId: replace[0]!.id });
    }
    for (const p of replace) await deps.storage.deletePendingPlan(p.id);
  }
  if ((await deps.storage.countPendingPlans(wallet, now - PENDING_PLAN_TTL_SECS)) >= (deps.maxPendingPerWallet ?? 3)) {
    throw new HttpError(429, "too many unconfirmed plans for this wallet; try again in a few minutes");
  }
  if ((await deps.storage.countPlans(wallet)) >= (deps.maxPlansPerWallet ?? 100)) {
    throw new HttpError(409, "this wallet has reached the number of plans the server keeps");
  }

  // The first purchase is due at once (nextScheduledPurchase); dayOfWeek and hourUtc anchor the later ones:
  // the same weekday (weekly) or hour (daily) as the plan's creation, UTC.
  const { plan, grant } = await createPlan(
    { storage: deps.storage, encryptionKey: deps.encryptionKey, goldBuyer: deps.goldBuyer, now },
    {
      walletAddress: wallet,
      amountPerBuy,
      period,
      expiresAt,
      dayOfWeek: period === "week" ? utcDayOfWeek(now) : 0,
      hourUtc: utcHour(now),
      dipBuy,
      createdBlock: head.number,
    },
  );
  return createPlanResponse(plan, grant);
}

function sessionGrantOf(deps: Pick<ServiceDeps, "goldBuyer">, plan: PlanRecord, now: number) {
  try {
    return grantOf(plan, deps.goldBuyer, now);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

function createPlanResponse(plan: PlanRecord, grant: ReturnType<typeof grantOf>): CreatePlanResponse {
  const sessionPublicKey = plan.sessionPublicKey;
  const expected = {
    walletAddress: plan.walletAddress,
    publicKey: sessionPublicKey,
    permissions: {
      calls: grant.permissions.calls.map((c) => ({ ...c })),
      spend: grant.permissions.spend.map((s) => ({ limit: s.limit.toString(), period: s.period, ...(s.token ? { token: s.token } : {}) })),
    },
    expiry: grant.expiry,
  } satisfies SerializedSession;
  return {
    planId: plan.id,
    sessionPublicKey,
    expected,
    period: grant.period,
    periodCap: grant.periodCap.toString(),
    buysPerPeriod: grant.buysPerPeriod,
    feeToken: grant.feeToken,
    expiry: grant.expiry,
  };
}

function parseReportedSession(v: unknown): SerializedSession {
  const s = obj(v);
  if (typeof s.walletAddress !== "string" || typeof s.publicKey !== "string" || typeof s.expiry !== "number") {
    throw new HttpError(400, "session must be a serialized session");
  }
  const p = obj(s.permissions);
  if (p.calls !== undefined && !Array.isArray(p.calls)) throw new HttpError(400, "session.permissions.calls must be a list");
  if (p.spend !== undefined && !Array.isArray(p.spend)) throw new HttpError(400, "session.permissions.spend must be a list");
  return s as unknown as SerializedSession;
}

/**
 * POST /api/plans/:id/activate. Body: { session: SerializedSession, grantTxHash? }.
 * The grant transaction is optional: a browser that closed during the grant
 * never learned it. The chain's state of the key is the proof either way.
 */
export async function activatePlanRequest(deps: ServiceDeps, planId: string, body: unknown): Promise<PlanView> {
  const b = obj(body);
  const reported = parseReportedSession(b.session);
  const grantTxHash = b.grantTxHash === undefined || b.grantTxHash === null ? undefined : txHashOf(b.grantTxHash, "grantTxHash");
  const plan = await deps.storage.getPlan(planId);
  if (!plan) throw new HttpError(404, "no such plan", "no_such_plan");
  if (plan.status === "active") return planView(plan, deps.goldBuyer);
  if (plan.status !== "pending_grant") throw new HttpError(409, "this plan was stopped", "plan_stopped");
  if (getAddress(reported.walletAddress) !== plan.walletAddress) throw new HttpError(403, "the session is for another wallet");

  if (grantTxHash) {
    let facts;
    try {
      facts = await deps.chain.txFacts(grantTxHash, plan.walletAddress);
    } catch {
      throw chainUnavailable("to check the grant transaction");
    }
    if (!facts) throw new HttpError(409, "the grant transaction is not visible onchain yet; try again in a few seconds", "not_visible");
    if (!facts.succeeded) throw new HttpError(409, "the grant transaction reverted", "grant_reverted");
  }

  // One running plan per wallet. An older plan whose session is no longer
  // active onchain is closed here; one that is still active blocks activation.
  for (const other of await deps.storage.listPlansForWallet(plan.walletAddress)) {
    if (other.id === plan.id || other.status !== "active") continue;
    let st;
    try {
      st = await deps.chain.sessionState(other.walletAddress, other.sessionPublicKey);
    } catch {
      throw chainUnavailable("to check the wallet's other plan");
    }
    if (st.status === "active") throw new HttpError(409, "another plan is still active for this wallet; stop it first", "other_plan_active");
    await deps.storage.stopPlan(other.id, st.status === "expired" ? "the session has expired" : "the owner revoked the session", st.blockTimestamp);
  }

  try {
    return planView(await confirmGrant({ storage: deps.storage, chain: deps.chain, goldBuyer: deps.goldBuyer }, planId, reported, grantTxHash), deps.goldBuyer);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof GrantCheckError) {
      // Only a successful chain read that shows other limits is a mismatch; a key not on the account yet is not.
      if (err.kind === "mismatch") throw new HttpError(409, err.message, "limits_mismatch");
      if (err.kind === "not_visible") throw new HttpError(409, err.message, "not_visible");
      if (err.kind === "expired") throw new HttpError(409, err.message, "session_expired");
      if (err.kind === "report") throw new HttpError(409, err.message, "session_mismatch");
      throw new HttpError(409, err.message, "plan_stopped");
    }
    // Anything else is a failed read (RPC, transport): not an answer about the key.
    throw chainUnavailable("to check the agent's key");
  }
}

/** POST /api/plans/:id/stop. Body: { revokeTxHash? }. Succeeds only once the chain shows the session is not active. */
export async function stopPlanRequest(deps: ServiceDeps, planId: string, body: unknown): Promise<PlanView> {
  const b = obj(body ?? {});
  const revokeTxHash = b.revokeTxHash === undefined ? undefined : txHashOf(b.revokeTxHash, "revokeTxHash");
  const plan = await deps.storage.getPlan(planId);
  if (!plan) throw new HttpError(404, "no such plan");
  if (plan.status === "stopped") return planView(plan, deps.goldBuyer);
  // A key that was never granted also reads as "revoked"; stopping a pending plan
  // would let anyone cancel an owner's grant in progress.
  if (plan.status !== "active") throw new HttpError(409, "this plan was never activated");
  const state = await deps.chain.sessionState(plan.walletAddress, plan.sessionPublicKey);
  if (state.status === "active") throw new HttpError(409, "the session is still active onchain; the plan keeps running");
  let txHash: Hex | undefined;
  if (revokeTxHash) {
    const facts = await deps.chain.txFacts(revokeTxHash, plan.walletAddress);
    if (facts?.succeeded) txHash = revokeTxHash;
  }
  const reason = state.status === "expired" ? "the session has expired" : "the owner revoked the session";
  await deps.storage.stopPlan(plan.id, reason, state.blockTimestamp, txHash);
  return planView((await deps.storage.getPlan(plan.id))!, deps.goldBuyer);
}

/** A plan as the app sees it: no key material, amounts as decimal strings. */
export type PlanView = {
  id: string;
  walletAddress: Address;
  status: PlanRecord["status"];
  period: PlanPeriod;
  amountPerBuy: string;
  feeAllowancePerBuy: string;
  periodCap: string | null;
  dipBuy: boolean;
  dayOfWeek: number;
  hourUtc: number;
  expiresAt: number;
  sessionPublicKey: Hex;
  createdAt: number;
  createdBlock: string | null;
  grantTxHash: Hex | null;
  stopTxHash: Hex | null;
  stoppedAt: number | null;
  stoppedReason: string | null;
};

export function planView(p: PlanRecord, goldBuyer?: Address): PlanView {
  let periodCap: string | null = null;
  if (goldBuyer) {
    try {
      periodCap = grantOf(p, goldBuyer, p.createdAt).periodCap.toString();
    } catch {
      periodCap = null;
    }
  }
  return {
    id: p.id,
    walletAddress: p.walletAddress,
    status: p.status,
    period: p.period,
    amountPerBuy: p.amountPerBuy.toString(),
    feeAllowancePerBuy: p.feeAllowancePerBuy.toString(),
    periodCap,
    dipBuy: p.dipBuy,
    dayOfWeek: p.dayOfWeek,
    hourUtc: p.hourUtc,
    expiresAt: p.expiresAt,
    sessionPublicKey: p.sessionPublicKey,
    createdAt: p.createdAt,
    createdBlock: p.createdBlock?.toString() ?? null,
    grantTxHash: p.grantTxHash ?? null,
    stopTxHash: p.stopTxHash ?? null,
    stoppedAt: p.stoppedAt ?? null,
    stoppedReason: p.stoppedReason ?? null,
  };
}

export type RunLogView = Omit<RunLogEntry, "amountIn" | "out"> & { amountIn?: string; out?: string };

export type WalletView = { plans: PlanView[]; runLog: RunLogView[] };

/**
 * GET /api/wallets/:address. Public by design: plans hold no secret, and the
 * purchases they lead to are public onchain anyway. The run log adds the
 * agent's skips and refusals, which never reach the chain.
 */
export async function walletViewRequest(deps: Pick<ServiceDeps, "storage" | "goldBuyer">, address: string, limit = 100): Promise<WalletView> {
  const wallet = walletOf(address);
  // Pending plans are not listed: their ids are known only to the browser that created them.
  const plans = (await deps.storage.listPlansForWallet(wallet)).filter((p) => p.status !== "pending_grant");
  const runLog = await deps.storage.listRunLog(
    plans.map((p) => p.id),
    limit,
  );
  return {
    plans: plans.map((p) => planView(p, deps.goldBuyer)),
    // Reasons are the agent's own sentences; a relay's error text can be long or carry request details: first line only.
    runLog: runLog.map(({ amountIn, out, reason, ...e }) => ({
      ...e,
      reason: (reason.split("\n")[0] ?? "").slice(0, 200),
      ...(amountIn !== undefined ? { amountIn: amountIn.toString() } : {}),
      ...(out !== undefined ? { out: out.toString() } : {}),
    })),
  };
}

/**
 * The cron secret check. The Worker's Cron Trigger (web/worker.ts) sends
 * `Authorization: Bearer <CRON_SECRET>`; a manual trigger sends the same header. Constant time; a missing or short
 * secret refuses everything.
 */
export function cronAuthorized(authorization: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !authorization) return false;
  const want = Buffer.from(`Bearer ${secret}`, "utf8");
  const got = Buffer.from(authorization, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** JSON with bigints as decimal strings. */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}
