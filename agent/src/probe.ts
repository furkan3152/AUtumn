/**
 * Refusal probes for the funded mainnet run (docs/mainnet-run.md): send one
 * request with a plan's session key that the chain or the relay must refuse,
 * and record exactly what came back. The runner never does this: it checks
 * the cap and the session before sending.
 *
 * Used by the CLI (`try-buy`) and by the admin route POST /api/admin/probe
 * (`runAdminProbe`), both protected like the cron (CRON_SECRET).
 *
 * Why a probe cannot buy beyond the plan or move funds elsewhere:
 *
 * 1. Nothing in the request chooses a target, calldata or amount. The calls
 *    are built here: a purchase is exactly [USD₮.approve(GoldBuyer, x),
 *    GoldBuyer.buy(x, minOut)] (buildBuyCalls, checked by decodeBuyCalls) with
 *    the configured GoldBuyer, which sends the XAUt0 only to its caller, the
 *    wallet; the allowlist probe is USD₮.transfer(the wallet itself, 0).
 * 2. Before sending, a fresh chain read must show the refusal is certain:
 *    - over the cap: the session is active with exactly the plan's limits
 *      (sessionLimitsMismatch), and the amount is above the WHOLE period cap,
 *      not just what is left of it, so neither another spend nor a period
 *      reset in between can make it fit;
 *    - outside the allowlist: the session is active and its onchain
 *      allowlist is exactly the plan's, which does not include `transfer`;
 *    - after revoke: the key is not active onchain, and the purchase amount
 *      is also above the whole cap.
 *    Anything else is refused here before signing.
 * 3. The chain is the final guard either way: the session key can only call
 *    USD₮.approve and GoldBuyer.buy (plus Altana's Orchestrator, which cannot
 *    move the wallet's funds) and spend at most its USD₮ cap per period,
 *    fees included. Even a wrong gate could at worst buy gold into the
 *    wallet within the onchain cap.
 */
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import {
  USDT,
  buildBuyCalls,
  decodeBuyCalls,
  explainAltanaError,
  explainExecuteResult,
  periodId,
  sessionLimitsMismatch,
  withAttribution,
  type Balances,
  type Call,
  type ExplainedFailure,
  type Purchase,
  type SessionState,
} from "@autumn/core";
import { decryptSessionKey } from "./crypto.js";
import type { ChainReader, SessionExecutor } from "./ports.js";
import { grantForPlan } from "./runner.js";
import { HttpError } from "./service.js";
import type { Storage } from "./storage/types.js";
import type { PlanRecord, RunLogKind } from "./types.js";

export type ProbeDeps = { storage: Storage; chain: ChainReader; executor: SessionExecutor; encryptionKey: Buffer; goldBuyer: Address };

export type TryBuyResult = {
  sent: boolean;
  /** Why the probe expected a refusal. */
  expectation: "over_cap" | "session_inactive" | "outside_allowlist";
  sessionStatus: string;
  remainingCap: string | null;
  outcome: "refused" | "bought" | "unknown";
  failure?: ExplainedFailure;
  txHash?: Hex;
  callsId?: Hex;
  error?: string;
  /** The SDK's AltanaError code and text, or the relay's, as reported (first 2000 characters). */
  sdkError?: { name?: string; code?: string; message: string; relayMessage?: string };
};

const transferAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/** The one call the allowlist probe sends: USD₮.transfer(wallet, 0). Even if it ran, it would move nothing. */
export function outsideAllowlistCall(wallet: Address): Call {
  return {
    to: getAddress(USDT),
    data: withAttribution(encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [getAddress(wallet), 0n] })),
    value: 0n,
  };
}

/** The purchase amount an over-cap probe uses: the whole period cap plus one plan amount, so no period's room can fit it. */
export function overCapAmount(capLimit: bigint, amountPerBuy: bigint): bigint {
  return capLimit + amountPerBuy;
}

function sdkErrorOf(err: unknown): TryBuyResult["sdkError"] {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; relayMessage?: unknown };
  const cut = (s: unknown) => (typeof s === "string" ? s.slice(0, 2000) : undefined);
  return {
    ...(typeof e?.name === "string" ? { name: e.name } : {}),
    ...(typeof e?.code === "string" ? { code: e.code } : {}),
    message: cut(e?.message) ?? String(err).slice(0, 2000),
    ...(typeof e?.relayMessage === "string" ? { relayMessage: cut(e.relayMessage)! } : {}),
  };
}

/** Sends `calls` once with the plan's session key and classifies the answer. Records a run-log entry marked "probe". */
async function sendProbe(
  deps: ProbeDeps,
  plan: PlanRecord,
  calls: readonly Call[],
  base: Pick<TryBuyResult, "expectation" | "sessionStatus" | "remainingCap">,
  amountIn: bigint,
): Promise<TryBuyResult> {
  if (!plan.session) throw new HttpError(409, "the plan has no granted session");
  const enc = await deps.storage.getEncryptedSessionKey(plan.id);
  if (!enc) throw new HttpError(409, "no session key stored for the plan");
  const privateKey = decryptSessionKey(enc, plan.id, deps.encryptionKey);

  let result: TryBuyResult;
  try {
    const r = await deps.executor.execute({ session: plan.session, privateKey, calls });
    const failure = explainExecuteResult(r);
    result = {
      ...base,
      sent: true,
      outcome: failure ? (failure.bought === "no" ? "refused" : "unknown") : "bought",
      ...(failure ? { failure } : {}),
      ...(r.transactionHash ? { txHash: r.transactionHash } : {}),
      callsId: r.callsId,
    };
  } catch (err) {
    const failure = explainAltanaError(err);
    result = {
      ...base,
      sent: true,
      outcome: failure.bought === "no" ? "refused" : "unknown",
      failure,
      error: (err as Error).message,
      sdkError: sdkErrorOf(err),
    };
  }

  const now = (await deps.chain.head()).timestamp;
  const kind: RunLogKind = result.failure?.kind === "session_ended" ? "revoked" : ((result.failure?.kind ?? "unknown") as RunLogKind);
  await deps.storage.appendRunLog({
    planId: plan.id,
    periodId: periodId(now, plan.period),
    at: now,
    outcome: result.outcome === "bought" ? "bought" : result.outcome === "refused" ? "failed" : "ambiguous",
    reason:
      result.outcome === "refused"
        ? `probe: ${result.failure?.message ?? "refused"}`
        : result.outcome === "bought"
          ? "probe: the request went through"
          : `probe: outcome unknown (${result.failure?.message ?? ""})`,
    amountIn,
    kind: result.outcome === "bought" ? "weekly" : kind,
    ...(result.txHash ? { txHash: result.txHash } : {}),
  });
  return result;
}

/**
 * The CLI's probe: one purchase of `amountIn` that must be refused. Sends only
 * when the session is not active onchain, or when `amountIn` is above the
 * whole period cap of an active session with the plan's exact limits.
 */
export async function tryBuy(deps: ProbeDeps, planId: string, amountIn: bigint): Promise<TryBuyResult> {
  const plan = await deps.storage.getPlan(planId);
  if (!plan?.session) throw new Error("no granted plan with that id");
  const state = await deps.chain.sessionState(plan.walletAddress, plan.sessionPublicKey);
  const remaining = state.usdtCap?.remaining ?? null;
  let expectation: TryBuyResult["expectation"];
  if (state.status !== "active") expectation = "session_inactive";
  else {
    const mismatch = limitsMismatch(plan, state, deps.goldBuyer);
    if (mismatch) throw new Error(`refusing to probe: ${mismatch}`);
    const limit = state.usdtCap!.limit;
    if (amountIn <= limit) {
      throw new Error(`refusing to probe: ${amountIn} is not above the session's whole period cap (${limit}), so it could buy after a reset`);
    }
    expectation = "over_cap";
  }
  const quote = await deps.chain.quote(amountIn);
  const calls = buildBuyCalls(amountIn, quote.minOut > 0n ? quote.minOut : 1n, getAddress(deps.goldBuyer));
  decodeBuyCalls(calls, deps.goldBuyer);
  return sendProbe(deps, plan, calls, { expectation, sessionStatus: state.status, remainingCap: remaining?.toString() ?? null }, amountIn);
}

function limitsMismatch(plan: PlanRecord, state: SessionState, goldBuyer: Address): string | undefined {
  let grant;
  try {
    grant = grantForPlan(plan, goldBuyer, plan.createdAt);
  } catch (err) {
    return `the plan is not valid: ${(err as Error).message}`;
  }
  const m = sessionLimitsMismatch(state, grant, goldBuyer);
  if (m) return m;
  if (!state.usdtCap) return "the session has no single USD₮ cap";
  return undefined;
}

// ---------------------------------------------------------------- admin route

export const PROBE_KINDS = ["over-cap", "outside-allowlist", "after-revoke", "status"] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates POST /api/admin/probe's body: exactly { planId: uuid, kind }. Throws HttpError 400 otherwise. */
export function parseProbeRequest(body: unknown): { planId: string; kind: ProbeKind } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "the request body must be a JSON object");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== "planId" && k !== "kind");
  if (extra.length) throw new HttpError(400, `unexpected field(s): ${extra.join(", ")}; the body is { planId, kind }`);
  if (typeof b.planId !== "string" || !UUID.test(b.planId)) throw new HttpError(400, "planId must be a plan id (a UUID)");
  if (typeof b.kind !== "string" || !(PROBE_KINDS as readonly string[]).includes(b.kind)) {
    throw new HttpError(400, `kind must be one of ${PROBE_KINDS.join(", ")}`);
  }
  return { planId: b.planId.toLowerCase(), kind: b.kind as ProbeKind };
}

type BalancesView = { usdt: string; xaut0: string; celo: string; block: string };
const balancesView = (b: Balances): BalancesView => ({ usdt: b.usdt.toString(), xaut0: b.xaut0.toString(), celo: b.celo.toString(), block: b.blockNumber.toString() });

export type SessionView = {
  status: string;
  onAccount: boolean;
  keyStoreValid: boolean;
  limitsMatchPlan: boolean;
  limitsMismatch: string | null;
  cap: { period: string; limit: string; spent: string; remaining: string; resetsAt: number } | null;
  block: string;
};

function sessionView(plan: PlanRecord, s: SessionState, goldBuyer: Address): SessionView {
  const mismatch = s.status === "active" ? (limitsMismatch(plan, s, goldBuyer) ?? null) : null;
  return {
    status: s.status,
    onAccount: s.onAccount,
    keyStoreValid: s.keyStoreValid,
    limitsMatchPlan: s.status === "active" && mismatch === null,
    limitsMismatch: mismatch,
    cap: s.usdtCap
      ? { period: s.usdtCap.period, limit: s.usdtCap.limit.toString(), spent: s.usdtCap.spent.toString(), remaining: s.usdtCap.remaining.toString(), resetsAt: s.usdtCap.resetsAt }
      : null,
    block: s.blockNumber.toString(),
  };
}

export type AdminProbeResult = {
  planId: string;
  kind: ProbeKind;
  wallet: Address;
  planStatus: PlanRecord["status"];
  /** Whether a request was handed to the relay (or direct submitter). Always false for "status". */
  attempted: boolean;
  /** "refused" is the expected result of every sending probe. */
  outcome: "refused" | "bought" | "unknown" | "not_attempted";
  /** What was attempted, built on the server. */
  request: { calls: { to: Address; selector: Hex }[]; amountIn: string | null } | null;
  failure: ExplainedFailure | null;
  sdkError: TryBuyResult["sdkError"] | null;
  /** The relay's or our submitter's transaction, if one exists, with its receipt status and any GoldBuyer purchase by the wallet in it. */
  onchain: {
    txHash: Hex | null;
    receipt: "success" | "reverted" | "none" | null;
    purchasesInTx: { amountIn: string; out: string }[];
    /** Purchases by the wallet made after the probe began. */
    purchasesDuringProbe: { txHash: Hex; amountIn: string; out: string }[];
  };
  sessionBefore: SessionView;
  sessionAfter: SessionView | null;
  balancesBefore: BalancesView;
  balancesAfter: BalancesView | null;
  balancesUnchanged: boolean | null;
};

export type AdminProbeDeps = Omit<ProbeDeps, "executor"> & {
  /** null when the server does not send (AUTUMN_EXECUTION is not "live"): sending probes are refused, "status" works. */
  executor: SessionExecutor | null;
  /** Waits after a send before re-reading balances (the RPC pins reads a few blocks behind the head). Default 6000 ms. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const purchaseView = (p: Purchase) => ({ txHash: p.txHash, amountIn: p.amountIn.toString(), out: p.out.toString() });

/**
 * POST /api/admin/probe, after the caller checked CRON_SECRET. Runs one
 * refusal probe (or a read-only "status") for a plan and reports exactly what
 * happened: the SDK/relay error, any transaction, and balances before and after.
 */
export async function runAdminProbe(deps: AdminProbeDeps, body: unknown): Promise<AdminProbeResult> {
  const { planId, kind } = parseProbeRequest(body);
  const plan = await deps.storage.getPlan(planId);
  if (!plan) throw new HttpError(404, "no such plan");
  if (!plan.session) throw new HttpError(409, "the plan was never granted, so it has no session to probe");
  const goldBuyer = getAddress(deps.goldBuyer);

  const [state, balancesBefore, headBefore] = await Promise.all([
    deps.chain.sessionState(plan.walletAddress, plan.sessionPublicKey),
    deps.chain.balances(plan.walletAddress),
    deps.chain.head(),
  ]);
  const before = sessionView(plan, state, goldBuyer);
  const base = {
    planId: plan.id,
    kind,
    wallet: plan.walletAddress,
    planStatus: plan.status,
    sessionBefore: before,
    balancesBefore: balancesView(balancesBefore),
  };
  if (kind === "status") {
    return {
      ...base, attempted: false, outcome: "not_attempted", request: null, failure: null, sdkError: null,
      onchain: { txHash: null, receipt: null, purchasesInTx: [], purchasesDuringProbe: [] },
      sessionAfter: null, balancesAfter: null, balancesUnchanged: null,
    };
  }
  if (!deps.executor) throw new HttpError(409, "this server is in dry-run mode (AUTUMN_EXECUTION is not live), so it sends no probes");

  // Gates: a refusal must be certain from the chain before anything is signed.
  let calls: readonly Call[];
  let amountIn: bigint | null = null;
  let expectation: TryBuyResult["expectation"];
  if (kind === "over-cap" || kind === "outside-allowlist") {
    if (state.status !== "active") throw new HttpError(409, `the session is not active onchain (${state.status}); use "after-revoke"`);
    if (before.limitsMismatch) throw new HttpError(409, `refusing to probe: ${before.limitsMismatch}`);
    if (kind === "over-cap") {
      amountIn = overCapAmount(state.usdtCap!.limit, plan.amountPerBuy);
      const quote = await deps.chain.quote(amountIn);
      calls = buildBuyCalls(amountIn, quote.minOut > 0n ? quote.minOut : 1n, goldBuyer);
      decodeBuyCalls(calls, goldBuyer);
      expectation = "over_cap";
    } else {
      calls = [outsideAllowlistCall(plan.walletAddress)];
      expectation = "outside_allowlist";
    }
  } else {
    if (state.status === "active") throw new HttpError(409, "the session is still active onchain; revoke it before probing after-revoke");
    // Above any cap the plan could have, so even a key that were still live could not buy with it.
    const grant = grantForPlan(plan, goldBuyer, plan.createdAt);
    amountIn = overCapAmount(grant.periodCap, plan.amountPerBuy);
    const quote = await deps.chain.quote(amountIn);
    calls = buildBuyCalls(amountIn, quote.minOut > 0n ? quote.minOut : 1n, goldBuyer);
    decodeBuyCalls(calls, goldBuyer);
    expectation = "session_inactive";
  }

  const r = await sendProbe(
    { ...deps, executor: deps.executor },
    plan,
    calls,
    { expectation, sessionStatus: state.status, remainingCap: state.usdtCap?.remaining.toString() ?? null },
    amountIn ?? 0n,
  );

  await (deps.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))))(deps.settleMs ?? 6000);
  const [after, balancesAfter, headAfter] = await Promise.all([
    deps.chain.sessionState(plan.walletAddress, plan.sessionPublicKey),
    deps.chain.balances(plan.walletAddress),
    deps.chain.head(),
  ]);
  let receipt: AdminProbeResult["onchain"]["receipt"] = null;
  let inTx: Purchase[] = [];
  if (r.txHash) {
    const facts = await deps.chain.txFacts(r.txHash, plan.walletAddress);
    receipt = facts === null ? "none" : facts.succeeded ? "success" : "reverted";
    inTx = ((await deps.chain.purchasesInTx(r.txHash)) ?? []).filter((p) => p.buyer === plan.walletAddress);
  }
  // Strictly after the probe began: a purchase the plan made just before the probe is not the probe's doing.
  const during = (await deps.chain.purchasesSince(headBefore.timestamp)).filter(
    (p) => p.buyer === plan.walletAddress && p.timestamp > headBefore.timestamp && p.timestamp <= headAfter.timestamp + 60,
  );
  const unchanged = balancesAfter.usdt === balancesBefore.usdt && balancesAfter.xaut0 === balancesBefore.xaut0 && balancesAfter.celo === balancesBefore.celo;
  return {
    ...base,
    attempted: r.sent,
    outcome: r.outcome,
    request: { calls: calls.map((c) => ({ to: c.to, selector: c.data.slice(0, 10) as Hex })), amountIn: amountIn?.toString() ?? null },
    failure: r.failure ?? null,
    sdkError: r.sdkError ?? null,
    onchain: { txHash: r.txHash ?? null, receipt, purchasesInTx: inTx.map((p) => ({ amountIn: p.amountIn.toString(), out: p.out.toString() })), purchasesDuringProbe: during.map(purchaseView) },
    sessionAfter: sessionView(plan, after, goldBuyer),
    balancesAfter: balancesView(balancesAfter),
    balancesUnchanged: unchanged,
  };
}
