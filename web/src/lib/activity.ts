/**
 * Pure functions that turn chain facts and the server's run log into what
 * the screens show. Purchases come only from GoldBuyer `Bought` events; the
 * run log adds what never reaches the chain (skips and relay refusals).
 */
import { nextDueTime, periodStart, type PlanPeriod, type Purchase, type SessionStatus, type TxFacts } from "@autumn/core";
import type { PlanView, RunLogView } from "@autumn/agent";
import type { ActivityItem, AgentStatus, RefusalReason, TxHash } from "./autumn";

export type { PlanView, RunLogView };

/** The plan in force at `t`: the newest granted plan created at or before it. */
export function planAt(plans: readonly PlanView[], t: number): PlanView | undefined {
  return plans
    .filter((p) => p.status !== "pending_grant" && p.createdAt <= t)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** Chain purchases as activity. The second purchase in a plan's period is the dip buy. */
export function purchaseItems(purchases: readonly Purchase[], plans: readonly PlanView[]): ActivityItem[] {
  const sorted = [...purchases].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  const seen = new Map<string, number>();
  return sorted.map((p) => {
    const plan = planAt(plans, p.timestamp);
    const period: PlanPeriod = plan?.period ?? "week";
    const key = `${plan?.id ?? "-"}:${periodStart(p.timestamp, period)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return {
      kind: "purchase" as const,
      id: `buy:${p.txHash}:${p.logIndex}`,
      at: new Date(p.timestamp * 1000),
      spent: p.amountIn,
      received: p.out,
      usdtPerOunce: p.priceUsdtPerXaut,
      trigger: n === 0 ? ("scheduled" as const) : ("dip" as const),
      period,
      txHash: p.txHash as TxHash,
    };
  });
}

const SKIP_TEXT: Record<string, { text: string; retries: boolean }> = {
  twap_unavailable: { text: "Price check not available right now, the agent will retry.", retries: true },
  price_out_of_bound: { text: "The price was outside the safe range, so the agent did not buy. It will retry.", retries: true },
  insufficient_balance: { text: "Not enough USD₮ in the wallet for this purchase and its fee.", retries: true },
  cap_exceeded: { text: "This purchase would go over the limit, so the agent did not send it.", retries: false },
  limits_mismatch: { text: "The agent refused to act: the limits onchain differ from the plan.", retries: false },
  too_many_failures: { text: "Several attempts failed, so the agent waits for the next period.", retries: false },
  fee_too_high: { text: "The relay's fee was above this plan's fee allowance, so the agent did not buy. It will retry later in the period.", retries: true },
  quote_expired: { text: "The relay's fee quote expired before sending. The agent will retry.", retries: true },
  relay_failure: { text: "The Altana relay did not answer. The agent checks the chain before trying again.", retries: true },
  reverted: { text: "The purchase transaction reverted onchain, so no gold was bought.", retries: true },
};

const REFUSAL_OF: Record<string, RefusalReason> = {
  cap_exceeded: "cap",
  call_not_permitted: "not-gold",
  session_ended: "revoked",
  revoked: "revoked",
  expired: "expired",
};

/** The agent's run log as activity: refusals and skips only (purchases and stops come from the chain). */
export function runLogItems(runLog: readonly RunLogView[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  runLog.forEach((e, i) => {
    const at = new Date(e.at * 1000);
    const id = `log:${e.planId}:${e.at}:${i}`;
    if (e.outcome === "bought" || e.outcome === "stopped") return;
    if (e.outcome === "failed" && e.kind && REFUSAL_OF[e.kind]) {
      items.push({
        kind: "refused",
        id,
        at,
        attempted: e.amountIn !== undefined ? BigInt(e.amountIn) : null,
        reason: REFUSAL_OF[e.kind]!,
        ...(e.txHash ? { txHash: e.txHash as TxHash } : {}),
      });
      return;
    }
    if (e.outcome === "ambiguous") {
      items.push({ kind: "skipped", id, at, text: "The outcome of a purchase was unclear. The agent checks the chain before trying again.", retries: true });
      return;
    }
    const known = e.kind ? SKIP_TEXT[e.kind] : undefined;
    items.push({
      kind: "skipped",
      id,
      at,
      text: known?.text ?? e.reason,
      retries: known?.retries ?? false,
      ...(e.txHash ? { txHash: e.txHash as TxHash } : {}),
    });
  });
  return items;
}

/** Plan start, first registration and stop, with their transactions' block times when known. */
export function planItems(plans: readonly PlanView[], facts: ReadonlyMap<string, TxFacts | null>): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const p of plans) {
    if (p.status === "pending_grant") continue;
    const grant = p.grantTxHash ? facts.get(p.grantTxHash.toLowerCase()) : undefined;
    const startedAt = new Date((grant?.timestamp ?? p.createdAt) * 1000);
    items.push({
      kind: "plan-started",
      id: `plan:${p.id}`,
      at: startedAt,
      amount: BigInt(p.amountPerBuy),
      period: p.period,
      ...(p.grantTxHash ? { txHash: p.grantTxHash as TxHash } : {}),
    });
    if (grant?.keysRegistered.some((k) => k.isRoot)) {
      items.push({ kind: "registration", id: `reg:${p.id}`, at: new Date(startedAt.getTime() - 1), txHash: p.grantTxHash as TxHash });
    }
    if (p.status === "stopped" && p.stoppedReason !== "the session has expired") {
      const stop = p.stopTxHash ? facts.get(p.stopTxHash.toLowerCase()) : undefined;
      const at = stop?.timestamp ?? p.stoppedAt;
      if (at !== null && at !== undefined) {
        items.push({ kind: "stopped", id: `stop:${p.id}`, at: new Date(at * 1000), ...(p.stopTxHash ? { txHash: p.stopTxHash as TxHash } : {}) });
      }
    }
  }
  return items;
}

export function buildActivity(parts: ActivityItem[][]): ActivityItem[] {
  return parts.flat().sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
}

/**
 * The agent's state, from the chain first. "stopped" only when the chain shows
 * the session revoked; while a revoke is in flight the overlay says "stopping".
 */
export function agentStatusFor(args: {
  plan: PlanView | null;
  chainStatus: SessionStatus | null;
  stopping: { txHash?: TxHash } | null;
  facts: ReadonlyMap<string, TxFacts | null>;
}): AgentStatus {
  const { plan, chainStatus, stopping, facts } = args;
  if (!plan) return { kind: "none" };
  if (chainStatus === "expired") return { kind: "expired", expiredAt: new Date(plan.expiresAt * 1000) };
  if (chainStatus === "revoked") {
    const stop = plan.stopTxHash ? facts.get(plan.stopTxHash.toLowerCase()) : undefined;
    const at = stop?.timestamp ?? plan.stoppedAt;
    return {
      kind: "stopped",
      stoppedAt: at !== null && at !== undefined ? new Date(at * 1000) : null,
      ...(plan.stopTxHash ? { txHash: plan.stopTxHash as TxHash } : stopping?.txHash ? { txHash: stopping.txHash } : {}),
    };
  }
  if (stopping) return { kind: "stopping", ...(stopping.txHash ? { txHash: stopping.txHash } : {}) };
  if (chainStatus === "active") return { kind: "active" };
  // The chain could not be read: fall back to what the server last recorded.
  if (plan.status === "stopped") return { kind: "stopped", stoppedAt: plan.stoppedAt ? new Date(plan.stoppedAt * 1000) : null, ...(plan.stopTxHash ? { txHash: plan.stopTxHash as TxHash } : {}) };
  return { kind: "active" };
}

/** Next scheduled purchase for an active plan, or null when none is scheduled before the plan ends. */
export function nextPurchaseFor(plan: PlanView, purchases: readonly Purchase[], now: number, agent: AgentStatus): Date | null {
  if (agent.kind !== "active") return null;
  const start = periodStart(now, plan.period);
  const bought = purchases.some((p) => p.timestamp >= start && p.timestamp >= plan.createdAt);
  const t = nextDueTime(now, plan.period, plan.dayOfWeek, plan.hourUtc, bought);
  return t < plan.expiresAt ? new Date(t * 1000) : null;
}

/** The plan to show: the newest granted plan (active first). Pending plans are never shown. */
export function currentPlan(plans: readonly PlanView[]): PlanView | null {
  const granted = plans.filter((p) => p.status !== "pending_grant");
  return granted.find((p) => p.status === "active") ?? granted.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}
