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
  PLAN_DURATION_SECS,
  utcDayOfWeek,
  utcHour,
  type PlanPeriod,
} from "@autumn/core";
import { confirmGrant, createPlan, grantOf } from "./plans.js";
import type { ChainReader } from "./ports.js";
import type { Storage } from "./storage/types.js";
import type { PlanRecord, RunLogEntry } from "./types.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export type ServiceDeps = {
  storage: Storage;
  chain: ChainReader;
  encryptionKey: Buffer;
  goldBuyer: Address;
  /** Pending plans a wallet may create per hour. Default 5. */
  maxPendingPerHour?: number;
};

/** The plan amounts the app offers, in whole USD₮. */
export const PLAN_AMOUNTS_USDT = [1, 5, 10] as const;
/** How far the expiry the browser showed may be from now + 12 weeks (browser and chain clocks differ). */
export const EXPIRY_TOLERANCE_SECS = 15 * 60;

const USDT_UNIT = 1_000_000n;

function obj(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "the request body must be a JSON object");
  return body as Record<string, unknown>;
}

function walletOf(v: unknown): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new HttpError(400, "wallet must be a 20-byte hex address");
  return getAddress(v);
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
 * POST /api/plans. Body: { wallet, amountUsdt: 1|5|10, period: "week"|"day",
 * dipBuy: boolean, expiresAt: unix seconds the browser showed }.
 */
export async function createPlanRequest(deps: ServiceDeps, body: unknown): Promise<CreatePlanResponse> {
  const b = obj(body);
  const wallet = walletOf(b.wallet);
  const amount = b.amountUsdt;
  if (typeof amount !== "number" || !(PLAN_AMOUNTS_USDT as readonly number[]).includes(amount)) {
    throw new HttpError(400, `amountUsdt must be one of ${PLAN_AMOUNTS_USDT.join(", ")}`);
  }
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
  const limit = deps.maxPendingPerHour ?? 5;
  if ((await deps.storage.countPendingPlans(wallet, now - 3600)) >= limit) {
    throw new HttpError(429, "too many unconfirmed plans for this wallet in the last hour; try again later");
  }

  // Due at the hour of creation: the first purchase can happen right away,
  // later ones on the same weekday (weekly) or at the same hour (daily), UTC.
  const { plan, sessionPublicKey, grant } = await createPlan(
    { storage: deps.storage, encryptionKey: deps.encryptionKey, goldBuyer: deps.goldBuyer, now },
    {
      walletAddress: wallet,
      amountPerBuy: BigInt(amount) * USDT_UNIT,
      period,
      expiresAt,
      dayOfWeek: period === "week" ? utcDayOfWeek(now) : 0,
      hourUtc: utcHour(now),
      dipBuy: b.dipBuy === true,
      createdBlock: head.number,
    },
  );
  const expected = {
    walletAddress: wallet,
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

/** POST /api/plans/:id/activate. Body: { session: SerializedSession, grantTxHash }. */
export async function activatePlanRequest(deps: ServiceDeps, planId: string, body: unknown): Promise<PlanView> {
  const b = obj(body);
  const reported = parseReportedSession(b.session);
  const grantTxHash = txHashOf(b.grantTxHash, "grantTxHash");
  const plan = await deps.storage.getPlan(planId);
  if (!plan) throw new HttpError(404, "no such plan");
  if (plan.status === "active") return planView(plan, deps.goldBuyer);
  if (plan.status !== "pending_grant") throw new HttpError(409, "this plan was stopped");
  if (getAddress(reported.walletAddress) !== plan.walletAddress) throw new HttpError(403, "the session is for another wallet");

  const facts = await deps.chain.txFacts(grantTxHash, plan.walletAddress);
  if (!facts) throw new HttpError(409, "the grant transaction is not visible onchain yet; try again in a few seconds");
  if (!facts.succeeded) throw new HttpError(409, "the grant transaction reverted");

  // One running plan per wallet. An older plan whose session is no longer
  // active onchain is closed here; one that is still active blocks activation.
  for (const other of await deps.storage.listPlansForWallet(plan.walletAddress)) {
    if (other.id === plan.id || other.status !== "active") continue;
    const st = await deps.chain.sessionState(other.walletAddress, other.sessionPublicKey);
    if (st.status === "active") throw new HttpError(409, "another plan is still active for this wallet; stop it first");
    await deps.storage.stopPlan(other.id, st.status === "expired" ? "the session has expired" : "the owner revoked the session", st.blockTimestamp);
  }

  try {
    return planView(await confirmGrant({ storage: deps.storage, chain: deps.chain, goldBuyer: deps.goldBuyer }, planId, reported, grantTxHash), deps.goldBuyer);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(409, (err as Error).message);
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
    runLog: runLog.map(({ amountIn, out, ...e }) => ({
      ...e,
      ...(amountIn !== undefined ? { amountIn: amountIn.toString() } : {}),
      ...(out !== undefined ? { out: out.toString() } : {}),
    })),
  };
}

/**
 * The cron secret check. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`;
 * a manual trigger sends the same header. Constant time; a missing or short
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
