/**
 * Refusal probes for the funded mainnet run (docs/mainnet-run.md): send one
 * purchase with a plan's session key on purpose outside its limits, and record
 * what the relay or the chain answered. The runner never does this: it checks
 * the cap and the session before sending.
 *
 * Safety: a probe only sends when the purchase is expected to be refused —
 * the amount is above the cap's remaining room, or the session is no longer
 * active onchain. Anything else is refused here before sending.
 */
import { getAddress, type Address, type Hex } from "viem";
import { buildBuyCalls, explainAltanaError, explainExecuteResult, periodId, type ExplainedFailure } from "@autumn/core";
import { decryptSessionKey } from "./crypto.js";
import type { ChainReader, SessionExecutor } from "./ports.js";
import type { Storage } from "./storage/types.js";
import type { RunLogKind } from "./types.js";

export type TryBuyResult = {
  sent: boolean;
  /** Why the probe expected a refusal. */
  expectation: "over_cap" | "session_inactive";
  sessionStatus: string;
  remainingCap: string | null;
  outcome: "refused" | "bought" | "unknown";
  failure?: ExplainedFailure;
  txHash?: Hex;
  callsId?: Hex;
  error?: string;
};

export async function tryBuy(
  deps: { storage: Storage; chain: ChainReader; executor: SessionExecutor; encryptionKey: Buffer; goldBuyer: Address },
  planId: string,
  amountIn: bigint,
): Promise<TryBuyResult> {
  const plan = await deps.storage.getPlan(planId);
  if (!plan?.session) throw new Error("no granted plan with that id");
  const state = await deps.chain.sessionState(plan.walletAddress, plan.sessionPublicKey);
  const remaining = state.usdtCap?.remaining ?? null;
  let expectation: TryBuyResult["expectation"];
  if (state.status !== "active") expectation = "session_inactive";
  else if (remaining !== null && amountIn > remaining) expectation = "over_cap";
  else throw new Error(`refusing to probe: ${amountIn} is within the remaining cap (${remaining}) of an active session, so it could buy`);

  const enc = await deps.storage.getEncryptedSessionKey(plan.id);
  if (!enc) throw new Error("no session key stored for the plan");
  const privateKey = decryptSessionKey(enc, plan.id, deps.encryptionKey);
  const quote = await deps.chain.quote(amountIn);
  const minOut = quote.minOut > 0n ? quote.minOut : 1n;
  const calls = buildBuyCalls(amountIn, minOut, getAddress(deps.goldBuyer));

  const base = { sent: true, expectation, sessionStatus: state.status, remainingCap: remaining?.toString() ?? null };
  let result: TryBuyResult;
  try {
    const r = await deps.executor.execute({ session: plan.session, privateKey, calls });
    const failure = explainExecuteResult(r);
    result = {
      ...base,
      outcome: failure ? (failure.bought === "no" ? "refused" : "unknown") : "bought",
      ...(failure ? { failure } : {}),
      ...(r.transactionHash ? { txHash: r.transactionHash } : {}),
      callsId: r.callsId,
    };
  } catch (err) {
    const failure = explainAltanaError(err);
    result = { ...base, outcome: failure.bought === "no" ? "refused" : "unknown", failure, error: (err as Error).message };
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
          ? "probe: the purchase went through"
          : `probe: outcome unknown (${result.failure?.message ?? ""})`,
    amountIn,
    kind: result.outcome === "bought" ? "weekly" : kind,
    ...(result.txHash ? { txHash: result.txHash } : {}),
  });
  return result;
}
