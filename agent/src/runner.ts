import { getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import {
  APPROVE_SIGNATURE,
  BUY_SIGNATURE,
  buildBuyCalls,
  decodeBuyCalls,
  dueTimeInWeek,
  explainAltanaError,
  explainExecuteResult,
  planToSessionGrant,
  SPEND_PERIOD,
  USDT,
  weekId as weekIdOf,
  type ExplainedFailure,
  type Purchase,
  type SessionState,
} from "@autumn/core";
import type { ChainReader, SessionExecutor } from "./ports.js";
import type { Storage } from "./storage/types.js";
import type { Attempt, AttemptSlot, PlanRecord, RunLogEntry, RunOutcome } from "./types.js";
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
  /** Failed (not bought) attempts per plan, week and slot before the runner stops trying that week. Default 3. */
  maxFailuresPerWeek?: number;
  /** Dip rule threshold: buy again when the price is at least this many bps below the last purchase. Default 200. */
  dipBps?: number;
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
  | "error";

export type PlanReport = {
  planId: string;
  decision: PlanDecision;
  reason?: string;
  slot?: AttemptSlot;
  txHash?: Hex;
  amountIn?: bigint;
  out?: bigint;
};

export type TickReport = { block: bigint; at: number; weekId: string; plans: PlanReport[] };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createRunner(opts: RunnerOptions) {
  const {
    storage,
    chain,
    executor,
    encryptionKey,
    ambiguityHoldSecs = 1800,
    recheckAttempts = 3,
    recheckDelayMs = 5000,
    maxFailuresPerWeek = 3,
    dipBps = 200,
    sleep = defaultSleep,
    log = () => {},
  } = opts;
  const goldBuyer = getAddress(opts.goldBuyer);

  /** Appends to the run log unless the previous entry for the plan says the same thing this week. */
  async function record(entry: RunLogEntry): Promise<void> {
    if (entry.outcome === "skipped") {
      const last = await storage.lastRunLog(entry.planId);
      if (last && last.weekId === entry.weekId && last.outcome === entry.outcome && last.reason === entry.reason) return;
    }
    await storage.appendRunLog(entry);
  }

  async function stop(plan: PlanRecord, week: string, at: number, reason: string): Promise<PlanReport> {
    await storage.stopPlan(plan.id, reason);
    await record({ planId: plan.id, weekId: week, at, outcome: "stopped", reason });
    log("plan stopped", { planId: plan.id, reason });
    return { planId: plan.id, decision: "stopped", reason };
  }

  /** The plan's onchain session must carry exactly the plan's limits; anything else is refused. */
  function limitsMismatch(plan: PlanRecord, state: SessionState): string | undefined {
    let grant;
    try {
      grant = planToSessionGrant(
        { amountPerWeek: plan.amountPerWeek, feeAllowancePerBuy: plan.feeAllowancePerBuy, dipBuy: plan.dipBuy, expiresAt: plan.expiresAt },
        goldBuyer,
        state.blockTimestamp,
      );
    } catch (err) {
      return `the plan is not valid: ${(err as Error).message}`;
    }
    const want = new Set([
      `${USDT.toLowerCase()}:${toFunctionSelector(APPROVE_SIGNATURE)}`,
      `${goldBuyer.toLowerCase()}:${toFunctionSelector(BUY_SIGNATURE)}`,
    ]);
    const have = new Set(state.allowedCalls.map((c) => `${c.target.toLowerCase()}:${c.selector.toLowerCase()}`));
    if (have.size !== want.size || [...want].some((w) => !have.has(w))) return "the session's onchain allowlist differs from the plan";
    const usdtCaps = state.spend.filter((s) => s.token.toLowerCase() === USDT.toLowerCase());
    const weekly = usdtCaps.find((s) => s.period === SPEND_PERIOD.week);
    if (!weekly || weekly.limit !== grant.weeklyCap) return "the session's onchain weekly cap differs from the plan";
    if (state.spend.some((s) => s.token.toLowerCase() !== USDT.toLowerCase())) return "the session can spend a token other than USD₮";
    return undefined;
  }

  /** Purchases by `wallet` at or after `since`, not already credited to another attempt. */
  function findPurchase(purchases: Purchase[], wallet: Address, since: number, credited: Set<string>): Purchase | undefined {
    return purchases.find(
      (p) => p.buyer === wallet && p.timestamp >= since && !credited.has(p.txHash.toLowerCase()),
    );
  }

  /**
   * Settles attempts left open by an ambiguous send or a crash, from the chain
   * only. Returns true when an attempt is still unresolved (the plan must wait).
   */
  async function resolveOpenAttempts(plan: PlanRecord, purchases: Purchase[], now: number): Promise<boolean> {
    const open = await storage.openAttempts(plan.id);
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
      // Attempts may have landed in a later week than they were claimed in; search that week too.
      landed ??= findPurchase(purchases, plan.walletAddress, a.startedAt - 60, credited);
      if (!landed && weekIdOf(a.startedAt) !== weekIdOf(now)) {
        landed = findPurchase(await chain.purchasesInWeek(a.startedAt), plan.walletAddress, a.startedAt - 60, credited);
      }
      if (landed) {
        await storage.updateAttempt(a.id, { status: "bought", txHash: landed.txHash, out: landed.out });
        await record({ planId: plan.id, weekId: a.weekId, at: now, outcome: "bought", reason: "confirmed onchain after an earlier unclear result", txHash: landed.txHash, amountIn: landed.amountIn, out: landed.out });
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
  async function recheck(plan: PlanRecord, attempt: Attempt, txHash?: Hex): Promise<Purchase | undefined> {
    for (let i = 0; i < recheckAttempts; i++) {
      if (i > 0 || !txHash) await sleep(recheckDelayMs);
      if (txHash) {
        const inTx = await chain.purchasesInTx(txHash).catch(() => null);
        const p = inTx?.find((x) => x.buyer === plan.walletAddress);
        if (p) return p;
      }
      const credited = await storage.creditedTxHashes(plan.id);
      const all = await chain.purchasesInWeek(attempt.startedAt).catch(() => [] as Purchase[]);
      const p = findPurchase(all, plan.walletAddress, attempt.startedAt - 60, credited);
      if (p) return p;
    }
    return undefined;
  }

  async function processPlan(plan: PlanRecord, ctx: { now: number; week: string; weekPurchases: Purchase[] }): Promise<PlanReport> {
    const { now, week } = ctx;
    const base = { planId: plan.id };
    const skip = async (reason: string, slot?: AttemptSlot): Promise<PlanReport> => {
      await record({ planId: plan.id, weekId: week, at: now, outcome: "skipped", reason });
      return { ...base, decision: "skipped", reason, ...(slot ? { slot } : {}) };
    };

    if (!plan.session) return { ...base, decision: "error", reason: "active plan without a granted session" };
    if (plan.session.expiry <= now) return stop(plan, week, now, "the session has expired");

    // 1. Unresolved earlier attempts are settled from the chain first.
    if (await resolveOpenAttempts(plan, ctx.weekPurchases, now)) {
      return { ...base, decision: "waiting_on_earlier_attempt", reason: "an earlier purchase's outcome is not yet visible onchain" };
    }

    // 2. What did the chain record this week?
    const mine = ctx.weekPurchases.filter((p) => p.buyer === plan.walletAddress);
    let slot: AttemptSlot;
    if (mine.length === 0) {
      if (now < dueTimeInWeek(now, plan.dayOfWeek, plan.hourUtc)) return { ...base, decision: "not_due" };
      slot = "weekly";
    } else if (plan.dipBuy && mine.length === 1) {
      slot = "dip";
    } else {
      return { ...base, decision: "already_bought", txHash: mine[mine.length - 1]!.txHash };
    }

    // 3. Session validity and limits, onchain.
    const state = await chain.sessionState(plan.walletAddress, plan.sessionPublicKey);
    if (state.status === "expired") return stop(plan, week, now, "the session has expired");
    if (state.status === "revoked") return stop(plan, week, now, "the owner revoked the session");
    const mismatch = limitsMismatch(plan, state);
    if (mismatch) return skip(`refusing to act: ${mismatch}`, slot);

    const budget = plan.amountPerWeek + plan.feeAllowancePerBuy;
    const remaining = state.usdtWeekly?.remaining ?? 0n;
    if (remaining < budget) return skip("this purchase would exceed the weekly cap", slot);

    const balances = await chain.balances(plan.walletAddress);
    if (balances.usdt < budget) return skip("the wallet does not hold enough USD₮ for the purchase and its fee", slot);

    if ((await storage.countAttempts(plan.id, week, slot, "not_bought")) >= maxFailuresPerWeek) {
      return skip(`${maxFailuresPerWeek} attempts failed this week; waiting for next week`, slot);
    }

    // 4. Price.
    const quote = await chain.quote(plan.amountPerWeek);
    if (!quote.withinBound) return skip(`price check failed: ${quote.reason}`, slot);
    if (slot === "dip") {
      const last = mine[mine.length - 1]!;
      // quote price ≤ last price × (1 − dipBps)
      if (quote.priceUsdtPerXaut * 10_000n > last.priceUsdtPerXaut * BigInt(10_000 - dipBps)) {
        return { ...base, decision: "already_bought", reason: "no dip below the last purchase price", txHash: last.txHash };
      }
    }

    const calls = buildBuyCalls(plan.amountPerWeek, quote.minOut, goldBuyer);
    decodeBuyCalls(calls, goldBuyer); // refuses anything but the exact two-call purchase

    if (!executor) {
      return { ...base, decision: "would_buy", slot, amountIn: plan.amountPerWeek, reason: `dry run; minOut ${quote.minOut}` };
    }

    // 5. Claim the slot (the cross-process lock), then send once.
    const attempt = await storage.claimAttempt({
      planId: plan.id, weekId: week, slot, startedAt: now, amountIn: plan.amountPerWeek, minOut: quote.minOut,
    });
    if (!attempt) return { ...base, decision: "waiting_on_earlier_attempt", reason: "another run holds this purchase" };

    const enc = await storage.getEncryptedSessionKey(plan.id);
    if (!enc) {
      await storage.updateAttempt(attempt.id, { status: "not_bought", reason: "no session key stored" });
      return { ...base, decision: "error", reason: "no session key stored for the plan" };
    }
    let privateKey: Hex;
    try {
      privateKey = decryptSessionKey(enc, plan.id, encryptionKey);
    } catch {
      await storage.updateAttempt(attempt.id, { status: "not_bought", reason: "the session key could not be decrypted" });
      return { ...base, decision: "error", reason: "the session key could not be decrypted (wrong AUTUMN_KEY_ENCRYPTION_KEY?)" };
    }

    let failure: ExplainedFailure | undefined;
    let txHash: Hex | undefined;
    try {
      const r = await executor.execute({ session: plan.session, privateKey, calls });
      txHash = r.transactionHash;
      await storage.updateAttempt(attempt.id, { callsId: r.callsId, ...(txHash ? { txHash } : {}) });
      failure = explainExecuteResult(r);
      if (!failure) {
        const landed = await recheck(plan, attempt, txHash);
        if (landed) {
          await storage.updateAttempt(attempt.id, { status: "bought", txHash: landed.txHash, out: landed.out });
          await record({ planId: plan.id, weekId: week, at: now, outcome: "bought", reason: slot === "dip" ? "dip purchase" : "weekly purchase", txHash: landed.txHash, amountIn: landed.amountIn, out: landed.out });
          log("bought", { planId: plan.id, txHash: landed.txHash, out: String(landed.out) });
          return { ...base, decision: "bought", slot, txHash: landed.txHash, amountIn: landed.amountIn, out: landed.out };
        }
        // Relay said confirmed but the purchase is not readable yet: leave it open for the next tick.
        failure = { kind: "relay_failure", message: "The relay reported the purchase confirmed but it is not visible onchain yet.", bought: "unknown", stopsPlan: false };
      }
    } catch (err) {
      failure = explainAltanaError(err);
      log("execute threw", { planId: plan.id, kind: failure.kind, code: failure.code });
    }

    // 6. Not confirmed. Never retry blindly.
    if (failure.bought === "unknown") {
      const landed = await recheck(plan, attempt, txHash);
      if (landed) {
        await storage.updateAttempt(attempt.id, { status: "bought", txHash: landed.txHash, out: landed.out });
        await record({ planId: plan.id, weekId: week, at: now, outcome: "bought", reason: "confirmed onchain after an unclear relay result", txHash: landed.txHash, amountIn: landed.amountIn, out: landed.out });
        return { ...base, decision: "bought", slot, txHash: landed.txHash, amountIn: landed.amountIn, out: landed.out };
      }
      await storage.updateAttempt(attempt.id, { status: "ambiguous", reason: failure.message });
      await record({ planId: plan.id, weekId: week, at: now, outcome: "ambiguous", reason: failure.message, ...(txHash ? { txHash } : {}) });
      return { ...base, decision: "ambiguous", slot, reason: failure.message, ...(txHash ? { txHash } : {}) };
    }

    await storage.updateAttempt(attempt.id, { status: "not_bought", reason: failure.message });
    if (failure.stopsPlan) {
      // Confirm from the chain before stopping: a relay message is not proof of revocation.
      const after = await chain.sessionState(plan.walletAddress, plan.sessionPublicKey);
      if (after.status !== "active") {
        return stop(plan, week, now, after.status === "expired" ? "the session has expired" : "the owner revoked the session");
      }
    }
    await record({ planId: plan.id, weekId: week, at: now, outcome: "failed", reason: failure.message, ...(txHash ? { txHash } : {}) });
    return { ...base, decision: "failed", slot, reason: failure.message, ...(txHash ? { txHash } : {}) };
  }

  /**
   * One pass over every active plan. Safe to call any number of times and
   * concurrently: a purchase is decided from the chain's GoldBuyer events for
   * the calendar week and guarded by an attempt lock in storage.
   */
  async function tick(): Promise<TickReport> {
    const head = await chain.head();
    const now = head.timestamp;
    const week = weekIdOf(now);
    const plans = await storage.listActivePlans();
    const weekPurchases = plans.length ? await chain.purchasesInWeek(now) : [];
    const reports: PlanReport[] = [];
    for (const plan of plans) {
      try {
        reports.push(await processPlan(plan, { now, week, weekPurchases }));
      } catch (err) {
        log("plan error", { planId: plan.id, error: (err as Error).message });
        reports.push({ planId: plan.id, decision: "error", reason: (err as Error).message });
      }
    }
    return { block: head.number, at: now, weekId: week, plans: reports };
  }

  return { tick };
}

export type Runner = ReturnType<typeof createRunner>;
export type { RunOutcome };
