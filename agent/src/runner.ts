import { getAddress, type Address, type Hex } from "viem";
import {
  buildBuyCalls,
  decodeBuyCalls,
  dueTimeInPeriod,
  explainAltanaError,
  explainExecuteResult,
  periodId as periodIdOf,
  periodStart,
  periodSecs,
  planToSessionGrant,
  relayFeeVerdict,
  sessionLimitsMismatch,
  weekId as weekIdOf,
  type ExplainedFailure,
  type Purchase,
  type SessionGrant,
} from "@autumn/core";
import type { ChainReader, SessionExecutor } from "./ports.js";
import type { Storage } from "./storage/types.js";
import type { Attempt, AttemptSlot, PlanRecord, RunLogEntry, RunLogKind, RunOutcome } from "./types.js";
import { decryptSessionKey } from "./crypto.js";

export type RunnerOptions = {
  storage: Storage;
  chain: ChainReader;
  /**
   * Sends purchases. `null` is a dry run: the runner decides and quotes but
   * claims nothing and sends nothing (decision `would_buy`).
   */
  executor: SessionExecutor | null;
  /** 32-byte AES key for session keys at rest. */
  encryptionKey: Buffer;
  goldBuyer: Address;
  /** An unresolved attempt blocks its slot this long before the chain's silence counts as "not bought". Default 1800 s. */
  ambiguityHoldSecs?: number;
  /** Chain re-reads after an ambiguous send, and the pause between them. Default 3 × 5 s. */
  recheckAttempts?: number;
  recheckDelayMs?: number;
  /** Failed (not bought) attempts per plan, period and slot before the runner stops trying that period. Default 3. */
  maxFailuresPerPeriod?: number;
  /** Dip rule threshold: buy again when the price is at least this many bps below the period's last purchase. Default 200. */
  dipBps?: number;
  /**
   * Plans processed at the same time. Plans of one wallet always run one
   * after another, so a wallet never has two operations in flight. Default 4.
   */
  concurrency?: number;
  /**
   * Wall-clock budget for one tick, ms. The tick returns before it is spent
   * and leaves the plans it did not reach for the next tick. Default 240 000,
   * well inside a Cloudflare Cron Trigger's 15 min wall-clock limit.
   */
  timeBudgetMs?: number;
  /** A plan is not started with less than this left in the budget, ms. Default 45 000. */
  minPlanMs?: number;
  /** The tick stops waiting for the relay this long before the budget ends, ms. Default 10 000. */
  finishMarginMs?: number;
  /** Wall clock for the budget (not chain time). Default Date.now. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

export type PlanDecision =
  | "not_due"
  | "already_bought"
  | "waiting_on_earlier_attempt"
  | "skipped"
  | "would_buy"
  | "bought"
  | "failed"
  | "ambiguous"
  | "stopped"
  /** Not reached in this tick's time budget; the next tick takes it. */
  | "deferred"
  | "error";

export type PlanReport = {
  planId: string;
  decision: PlanDecision;
  reason?: string;
  kind?: RunLogKind;
  slot?: AttemptSlot;
  txHash?: Hex;
  amountIn?: bigint;
  out?: bigint;
};

export type TickReport = { block: bigint; at: number; weekId: string; plans: PlanReport[] };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Plain words for the app and the run log when the pool cannot price a buy yet. */
export const TWAP_UNAVAILABLE_REASON = "Price check not available right now, the agent will retry.";

export function grantForPlan(plan: PlanRecord, goldBuyer: Address, nowSecs: number): SessionGrant {
  return planToSessionGrant(
    {
      amountPerBuy: plan.amountPerBuy,
      period: plan.period,
      feeAllowancePerBuy: plan.feeAllowancePerBuy,
      dipBuy: plan.dipBuy,
      expiresAt: plan.expiresAt,
    },
    goldBuyer,
    nowSecs,
  );
}

/**
 * USD₮ of cap headroom a purchase needs at send time on top of its amount: a
 * fifth of the fee allowance (0.01 USD₮ by default, twice the ~0.005 relay fee
 * Altana reports). The full allowance is what the grant reserves; requiring
 * all of it at send time would let one reverted transaction's fee block the
 * rest of the period.
 */
export function sendHeadroom(plan: Pick<PlanRecord, "feeAllowancePerBuy">): bigint {
  return plan.feeAllowancePerBuy / 5n;
}

/** Plain words for a relay fee above the plan's per-buy allowance. */
export const FEE_TOO_HIGH_REASON = "The relay's fee is above this plan's fee allowance right now, so the agent did not buy. It will retry later in the period.";

class RelayTimeout extends Error {}

export function createRunner(opts: RunnerOptions) {
  const {
    storage,
    chain,
    executor,
    encryptionKey,
    ambiguityHoldSecs = 1800,
    recheckAttempts = 3,
    recheckDelayMs = 5000,
    maxFailuresPerPeriod = 3,
    dipBps = 200,
    concurrency = 4,
    timeBudgetMs = 240_000,
    minPlanMs = 45_000,
    finishMarginMs = 10_000,
    clock = Date.now,
    sleep = defaultSleep,
    log = () => {},
  } = opts;
  const goldBuyer = getAddress(opts.goldBuyer);

  /** Appends to the run log unless the previous entry for the plan says the same thing this period. */
  async function record(entry: RunLogEntry): Promise<void> {
    if (entry.outcome === "skipped") {
      const last = await storage.lastRunLog(entry.planId);
      if (last && last.periodId === entry.periodId && last.outcome === entry.outcome && last.reason === entry.reason) return;
    }
    await storage.appendRunLog(entry);
  }

  async function stop(plan: PlanRecord, period: string, at: number, kind: "revoked" | "expired"): Promise<PlanReport> {
    const reason = kind === "expired" ? "the session has expired" : "the owner revoked the session";
    await storage.stopPlan(plan.id, reason, at);
    await record({ planId: plan.id, periodId: period, at, outcome: "stopped", reason, kind });
    log("plan stopped", { planId: plan.id, reason });
    return { planId: plan.id, decision: "stopped", reason, kind };
  }

  /** Purchases by `wallet` at or after `since`, not already credited to another attempt. */
  function findPurchase(purchases: Purchase[], wallet: Address, since: number, credited: Set<string>): Purchase | undefined {
    return purchases.find((p) => p.buyer === wallet && p.timestamp >= since && !credited.has(p.txHash.toLowerCase()));
  }

  /**
   * Settles attempts left open by an ambiguous send or a crash, from the chain
   * only. Returns true when an attempt is still unresolved (the plan must wait).
   */
  async function resolveOpenAttempts(plan: PlanRecord, open: Attempt[], scanned: Purchase[], now: number): Promise<boolean> {
    let waiting = false;
    for (const a of open) {
      const credited = await storage.creditedTxHashes(plan.id);
      let landed: Purchase | undefined;
      if (a.txHash) {
        const inTx = await chain.purchasesInTx(a.txHash);
        if (inTx !== null) {
          landed = inTx.find((p) => p.buyer === plan.walletAddress);
          if (!landed) {
            await storage.updateAttempt(a.id, { status: "not_bought", reason: "the transaction landed without a purchase" });
            continue;
          }
        }
      }
      // The tick's scan starts at or before every open attempt (minus a minute), so it holds any purchase one led to.
      landed ??= findPurchase(scanned, plan.walletAddress, a.startedAt - 60, credited);
      if (landed) {
        await storage.updateAttempt(a.id, { status: "bought", txHash: landed.txHash, out: landed.out });
        await record({
          planId: plan.id, periodId: a.periodId, at: now, outcome: "bought", reason: "confirmed onchain after an earlier unclear result",
          txHash: landed.txHash, amountIn: landed.amountIn, out: landed.out, kind: a.slot === "dip" ? "dip" : "weekly",
        });
        continue;
      }
      if (now - a.startedAt >= ambiguityHoldSecs) {
        await storage.updateAttempt(a.id, { status: "not_bought", reason: `no purchase onchain ${ambiguityHoldSecs}s after sending` });
        continue;
      }
      waiting = true;
    }
    return waiting;
  }

  /** After an unclear send: re-read the chain a few times for the purchase. */
  async function recheck(plan: PlanRecord, attempt: Attempt, deadline: number, txHash?: Hex): Promise<Purchase | undefined> {
    for (let i = 0; i < recheckAttempts; i++) {
      if (clock() + recheckDelayMs > deadline - finishMarginMs) break; // no time left: the next tick settles it
      if (i > 0 || !txHash) await sleep(recheckDelayMs);
      if (txHash) {
        const inTx = await chain.purchasesInTx(txHash).catch(() => null);
        const p = inTx?.find((x) => x.buyer === plan.walletAddress);
        if (p) return p;
      }
      const credited = await storage.creditedTxHashes(plan.id);
      const all = await chain.purchasesSince(attempt.startedAt - 60).catch(() => [] as Purchase[]);
      const p = findPurchase(all, plan.walletAddress, attempt.startedAt - 60, credited);
      if (p) return p;
    }
    return undefined;
  }

  async function processPlan(
    plan: PlanRecord,
    ctx: { now: number; scanned: Purchase[]; open: Attempt[]; deadline: number },
  ): Promise<PlanReport> {
    const { now, deadline } = ctx;
    const period = periodIdOf(now, plan.period);
    const base = { planId: plan.id };
    const skip = async (reason: string, kind: RunLogKind, slot?: AttemptSlot): Promise<PlanReport> => {
      await record({ planId: plan.id, periodId: period, at: now, outcome: "skipped", reason, kind });
      return { ...base, decision: "skipped", reason, kind, ...(slot ? { slot } : {}) };
    };

    if (!plan.session) return { ...base, decision: "error", reason: "active plan without a granted session" };
    if (plan.session.expiry <= now) return stop(plan, period, now, "expired");

    // 1. Unresolved earlier attempts are settled from the chain first.
    if (await resolveOpenAttempts(plan, ctx.open, ctx.scanned, now)) {
      return { ...base, decision: "waiting_on_earlier_attempt", reason: "an earlier purchase's outcome is not yet visible onchain" };
    }

    // 2. What did the chain record in this period? (The tick's scan starts at or before this period's start.)
    const start = periodStart(now, plan.period);
    const mine = ctx.scanned.filter(
      (p) => p.buyer === plan.walletAddress && p.timestamp >= start && p.timestamp < start + periodSecs(plan.period),
    );
    let slot: AttemptSlot;
    if (mine.length === 0) {
      if (now < dueTimeInPeriod(now, plan.period, plan.dayOfWeek, plan.hourUtc)) return { ...base, decision: "not_due" };
      slot = "weekly";
    } else if (plan.dipBuy && mine.length === 1) {
      slot = "dip";
    } else {
      return { ...base, decision: "already_bought", txHash: mine[mine.length - 1]!.txHash };
    }

    // 3. Session validity and limits, onchain.
    const state = await chain.sessionState(plan.walletAddress, plan.sessionPublicKey);
    if (state.status === "expired") return stop(plan, period, now, "expired");
    if (state.status === "revoked") return stop(plan, period, now, "revoked");
    let grant: SessionGrant;
    try {
      grant = grantForPlan(plan, goldBuyer, state.blockTimestamp);
    } catch (err) {
      return skip(`refusing to act: the plan is not valid: ${(err as Error).message}`, "limits_mismatch", slot);
    }
    const mismatch = sessionLimitsMismatch(state, grant, goldBuyer);
    if (mismatch) return skip(`refusing to act: ${mismatch}`, "limits_mismatch", slot);

    const remaining = state.usdtCap?.remaining ?? 0n;
    if (remaining < plan.amountPerBuy + sendHeadroom(plan)) {
      return skip(`this purchase would exceed the ${plan.period === "day" ? "daily" : "weekly"} cap`, "cap_exceeded", slot);
    }

    const balances = await chain.balances(plan.walletAddress);
    if (balances.usdt < plan.amountPerBuy + sendHeadroom(plan)) {
      return skip("the wallet does not hold enough USD₮ for the purchase and its fee", "insufficient_balance", slot);
    }

    if ((await storage.countAttempts(plan.id, period, slot, "not_bought")) >= maxFailuresPerPeriod) {
      return skip(`${maxFailuresPerPeriod} attempts failed this ${plan.period}; waiting for the next one`, "too_many_failures", slot);
    }

    // 4. Price. Without a 30-minute TWAP GoldBuyer reverts "OLD": skip, retry on a later tick in this period.
    const quote = await chain.quote(plan.amountPerBuy);
    if (quote.twapTick === null) return skip(TWAP_UNAVAILABLE_REASON, "twap_unavailable", slot);
    if (!quote.withinBound) return skip(`price check failed: ${quote.reason}`, "price_out_of_bound", slot);
    if (slot === "dip") {
      const last = mine[mine.length - 1]!;
      // quote price ≤ last price × (1 − dipBps)
      if (quote.priceUsdtPerXaut * 10_000n > last.priceUsdtPerXaut * BigInt(10_000 - dipBps)) {
        return { ...base, decision: "already_bought", reason: "no dip below the last purchase price", txHash: last.txHash };
      }
    }

    const calls = buildBuyCalls(plan.amountPerBuy, quote.minOut, goldBuyer);
    decodeBuyCalls(calls, goldBuyer); // refuses anything but the exact two-call purchase

    if (!executor) {
      return { ...base, decision: "would_buy", slot, amountIn: plan.amountPerBuy, reason: `dry run; minOut ${quote.minOut}` };
    }

    const enc = await storage.getEncryptedSessionKey(plan.id);
    if (!enc) return { ...base, decision: "error", reason: "no session key stored for the plan" };
    let privateKey: Hex;
    try {
      privateKey = decryptSessionKey(enc, plan.id, encryptionKey);
    } catch {
      return { ...base, decision: "error", reason: "the session key could not be decrypted (wrong AUTUMN_KEY_ENCRYPTION_KEY?)" };
    }

    // 5. The relay's fee for these exact calls, before anything is signed. Over the plan's per-buy allowance: refuse, retry later.
    let feeQuote: { fee: bigint; feeToken: Address };
    try {
      feeQuote = await executor.quote({ session: plan.session, privateKey, calls });
    } catch (err) {
      const f = explainAltanaError(err);
      if (f.kind === "twap_unavailable") return skip(TWAP_UNAVAILABLE_REASON, "twap_unavailable", slot);
      return skip(`the relay could not quote the fee: ${f.message}`, f.kind === "unknown" ? "relay_failure" : f.kind, slot);
    }
    const verdict = relayFeeVerdict(feeQuote, plan.feeAllowancePerBuy);
    if (!verdict.ok) {
      log("fee above allowance", { planId: plan.id, detail: verdict.reason });
      return skip(FEE_TOO_HIGH_REASON, "fee_too_high", slot);
    }
    if (remaining < plan.amountPerBuy + feeQuote.fee) {
      return skip(`this purchase and its fee would exceed the ${plan.period === "day" ? "daily" : "weekly"} cap`, "cap_exceeded", slot);
    }
    if (balances.usdt < plan.amountPerBuy + feeQuote.fee) {
      return skip("the wallet does not hold enough USD₮ for the purchase and its fee", "insufficient_balance", slot);
    }

    // 6. Claim the slot (the cross-process lock), then send once.
    const attempt = await storage.claimAttempt({
      planId: plan.id, periodId: period, slot, startedAt: now, amountIn: plan.amountPerBuy, minOut: quote.minOut,
    });
    if (!attempt) return { ...base, decision: "waiting_on_earlier_attempt", reason: "another run holds this purchase" };

    const boughtKind: RunLogKind = slot === "dip" ? "dip" : "weekly";
    const boughtReason = slot === "dip" ? "dip purchase" : `${plan.period === "day" ? "daily" : "weekly"} purchase`;
    let failure: ExplainedFailure | undefined;
    let txHash: Hex | undefined;
    try {
      // Never wait past the tick's budget: a send still in flight then is left open (ambiguous) and settled from the chain later.
      const waitMs = Math.max(0, deadline - finishMarginMs - clock());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RelayTimeout()), waitMs);
      });
      const r = await Promise.race([executor.execute({ session: plan.session, privateKey, calls }), timeout]).finally(() => clearTimeout(timer));
      txHash = r.transactionHash;
      await storage.updateAttempt(attempt.id, { callsId: r.callsId, ...(txHash ? { txHash } : {}) });
      failure = explainExecuteResult(r);
      if (!failure) {
        const landed = await recheck(plan, attempt, deadline, txHash);
        if (landed) {
          await storage.updateAttempt(attempt.id, { status: "bought", txHash: landed.txHash, out: landed.out });
          await record({ planId: plan.id, periodId: period, at: now, outcome: "bought", reason: boughtReason, txHash: landed.txHash, amountIn: landed.amountIn, out: landed.out, kind: boughtKind });
          log("bought", { planId: plan.id, txHash: landed.txHash, out: String(landed.out) });
          return { ...base, decision: "bought", slot, txHash: landed.txHash, amountIn: landed.amountIn, out: landed.out };
        }
        // Relay said confirmed but the purchase is not readable yet: leave it open for the next tick.
        failure = { kind: "relay_failure", message: "The relay reported the purchase confirmed but it is not visible onchain yet.", bought: "unknown", stopsPlan: false };
      }
    } catch (err) {
      failure =
        err instanceof RelayTimeout
          ? { kind: "relay_failure", message: "The relay had not answered when this run's time ran out. Autumn will check the chain before trying again.", bought: "unknown", stopsPlan: false }
          : explainAltanaError(err);
      log("execute threw", { planId: plan.id, kind: failure.kind, code: failure.code });
    }

    // 6. Not confirmed. Never retry blindly.
    if (failure.bought === "unknown") {
      const landed = await recheck(plan, attempt, deadline, txHash);
      if (landed) {
        await storage.updateAttempt(attempt.id, { status: "bought", txHash: landed.txHash, out: landed.out });
        await record({ planId: plan.id, periodId: period, at: now, outcome: "bought", reason: "confirmed onchain after an unclear relay result", txHash: landed.txHash, amountIn: landed.amountIn, out: landed.out, kind: boughtKind });
        return { ...base, decision: "bought", slot, txHash: landed.txHash, amountIn: landed.amountIn, out: landed.out };
      }
      await storage.updateAttempt(attempt.id, { status: "ambiguous", reason: failure.message });
      await record({ planId: plan.id, periodId: period, at: now, outcome: "ambiguous", reason: failure.message, kind: "relay_failure", ...(txHash ? { txHash } : {}) });
      return { ...base, decision: "ambiguous", slot, reason: failure.message, ...(txHash ? { txHash } : {}) };
    }

    if (failure.kind === "twap_unavailable") {
      // Refused in simulation because the pool's 30-minute average is not available: not a failure.
      await storage.updateAttempt(attempt.id, { status: "deferred", reason: failure.message });
      return skip(TWAP_UNAVAILABLE_REASON, "twap_unavailable", slot);
    }

    await storage.updateAttempt(attempt.id, { status: "not_bought", reason: failure.message });
    if (failure.stopsPlan) {
      // Confirm from the chain before stopping: a relay message is not proof of revocation.
      const after = await chain.sessionState(plan.walletAddress, plan.sessionPublicKey);
      if (after.status !== "active") return stop(plan, period, now, after.status === "expired" ? "expired" : "revoked");
    }
    const kind: RunLogKind = failure.kind === "unknown" && txHash ? "reverted" : failure.kind;
    await record({ planId: plan.id, periodId: period, at: now, outcome: "failed", reason: failure.message, kind, ...(txHash ? { txHash } : {}) });
    return { ...base, decision: "failed", slot, reason: failure.message, kind, ...(txHash ? { txHash } : {}) };
  }

  /**
   * One pass over every active plan. Safe to call any number of times and
   * concurrently: a purchase is decided from the chain's GoldBuyer events for
   * the plan's period and guarded by an attempt lock in storage.
   *
   * Capacity: plans run `concurrency` at a time, a wallet's plans one after
   * another; each plan's failure is its own; and the tick returns before its
   * time budget, reporting the plans it did not reach as "deferred".
   */
  async function tick(): Promise<TickReport> {
    const startedAt = clock();
    const deadline = startedAt + timeBudgetMs;
    const head = await chain.head();
    const now = head.timestamp;
    const plans = await storage.listActivePlans();
    const reports = new Map<string, PlanReport>();

    // One shared purchase scan, from the oldest moment any plan needs: its
    // current period's start, or its oldest open attempt.
    const open = new Map<string, Attempt[]>();
    let since = now;
    for (const plan of plans) {
      try {
        const o = await storage.openAttempts(plan.id);
        open.set(plan.id, o);
        since = Math.min(since, periodStart(now, plan.period), ...o.map((a) => a.startedAt - 60));
      } catch (err) {
        reports.set(plan.id, { planId: plan.id, decision: "error", reason: (err as Error).message });
      }
    }
    let scanned: Purchase[] | null = [];
    let scanError = "";
    if (plans.length > reports.size) {
      try {
        scanned = await chain.purchasesSince(since);
      } catch (err) {
        scanned = null;
        scanError = (err as Error).message;
        log("purchase scan failed", { error: scanError });
      }
    }

    // Group by wallet; groups run in parallel up to `concurrency`, plans within a group in order.
    const groups = new Map<string, PlanRecord[]>();
    for (const plan of plans) {
      if (reports.has(plan.id)) continue;
      const k = plan.walletAddress.toLowerCase();
      groups.set(k, [...(groups.get(k) ?? []), plan]);
    }
    const queue = [...groups.values()];
    const worker = async () => {
      for (let g = queue.shift(); g; g = queue.shift()) {
        for (const plan of g) {
          if (deadline - clock() < minPlanMs) {
            reports.set(plan.id, { planId: plan.id, decision: "deferred", reason: "this run's time budget is used up; the next run takes this plan" });
            continue;
          }
          if (scanned === null) {
            reports.set(plan.id, { planId: plan.id, decision: "error", reason: `the purchase history could not be read: ${scanError}` });
            continue;
          }
          try {
            reports.set(plan.id, await processPlan(plan, { now, scanned, open: open.get(plan.id) ?? [], deadline }));
          } catch (err) {
            log("plan error", { planId: plan.id, error: (err as Error).message });
            reports.set(plan.id, { planId: plan.id, decision: "error", reason: (err as Error).message });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
    return { block: head.number, at: now, weekId: weekIdOf(now), plans: plans.map((p) => reports.get(p.id)!) };
  }

  return { tick };
}

export type Runner = ReturnType<typeof createRunner>;
export type { RunOutcome };
