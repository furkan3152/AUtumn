import { describe, expect, it } from "vitest";
import type { Purchase, TxFacts } from "@autumn/core";
import {
  agentStatusFor,
  buildActivity,
  currentPlan,
  mergePurchases,
  nextPurchaseFor,
  runLogPurchases,
  planItems,
  purchaseItems,
  runLogItems,
  type PlanView,
  type RunLogView,
} from "../src/lib/activity";
import { draftLimits, isFunded, nextResetUtc, type AutumnState } from "../src/lib/autumn";

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const H = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as `0x${string}`;
const WALLET = "0x2222222222222222222222222222222222222222" as const;

function plan(over: Partial<PlanView> = {}): PlanView {
  return {
    id: "p1",
    walletAddress: WALLET,
    status: "active",
    period: "week",
    amountPerBuy: "5000000",
    feeAllowancePerBuy: "50000",
    periodCap: "5050000",
    dipBuy: false,
    dayOfWeek: 2,
    hourUtc: 9,
    expiresAt: t("2027-02-10T09:00:00Z"),
    sessionPublicKey: `0x04${"ab".repeat(64)}`,
    createdAt: t("2026-11-18T09:00:00Z"),
    createdBlock: "83000000",
    grantTxHash: H(1),
    stopTxHash: null,
    stoppedAt: null,
    stoppedReason: null,
    ...over,
  };
}

function buy(ts: number, n: number): Purchase {
  return { buyer: WALLET, amountIn: 5_000_000n, out: 1_400n, priceUsdtPerXaut: 3_571_428_571n, txHash: H(100 + n), blockNumber: BigInt(1000 + n), logIndex: 0, timestamp: ts };
}

describe("purchaseItems", () => {
  it("marks the second purchase in a plan's period as the dip buy, per period", () => {
    const p = plan({ period: "day", dipBuy: true });
    const items = purchaseItems(
      [buy(t("2026-11-18T09:01:00Z"), 1), buy(t("2026-11-18T15:00:00Z"), 2), buy(t("2026-11-19T09:01:00Z"), 3)],
      [p],
    );
    expect(items.map((i) => (i.kind === "purchase" ? [i.trigger, i.period] : null))).toEqual([
      ["scheduled", "day"],
      ["dip", "day"],
      ["scheduled", "day"],
    ]);
  });
});

describe("runLogItems", () => {
  const entry = (over: Partial<RunLogView>): RunLogView => ({ planId: "p1", periodId: "2026-11-16", at: t("2026-11-18T09:00:00Z"), outcome: "skipped", reason: "r", ...over });

  it("words the pool's missing price history plainly and says the agent retries", () => {
    const [i] = runLogItems([entry({ kind: "twap_unavailable" })]);
    expect(i).toMatchObject({ kind: "skipped", text: "Price check not available right now, the agent will retry.", retries: true });
  });

  it("shows relay and chain refusals as refusals, and leaves purchases and stops to the chain", () => {
    const items = runLogItems([
      entry({ outcome: "failed", kind: "cap_exceeded", amountIn: "6000000" }),
      entry({ outcome: "failed", kind: "revoked" }),
      entry({ outcome: "bought", kind: "weekly" }),
      entry({ outcome: "stopped", kind: "revoked" }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: "refused", reason: "cap", attempted: 6_000_000n }),
      expect.objectContaining({ kind: "refused", reason: "revoked", attempted: null }),
    ]);
  });

  it("keeps the server's words for an unknown kind, and the tx of a reverted purchase", () => {
    const [a, b] = runLogItems([entry({ reason: "something new" }), entry({ outcome: "failed", kind: "reverted", txHash: H(9) })]);
    expect(a).toMatchObject({ kind: "skipped", text: "something new", retries: false });
    expect(b).toMatchObject({ kind: "skipped", txHash: H(9) });
  });
});

describe("planItems", () => {
  const facts = new Map<string, TxFacts | null>([
    [H(1), { txHash: H(1), succeeded: true, blockNumber: 5n, timestamp: t("2026-11-18T09:00:30Z"), keysRegistered: [{ keyId: H(7), isRoot: true }], touchedWallet: true }],
  ]);
  it("uses the grant's block time, shows the first registration, and a stop only for a revoke", () => {
    const items = planItems(
      [plan(), plan({ id: "p0", status: "stopped", stoppedReason: "the owner revoked the session", stoppedAt: t("2026-11-10T00:00:00Z"), grantTxHash: null }), plan({ id: "px", status: "pending_grant" })],
      facts,
    );
    expect(items.map((i) => i.kind)).toEqual(["plan-started", "registration", "plan-started", "stopped"]);
    expect(items[0]!.at.toISOString()).toBe("2026-11-18T09:00:30.000Z");
    const expired = planItems([plan({ status: "stopped", stoppedReason: "the session has expired", stoppedAt: 1 })], new Map());
    expect(expired.map((i) => i.kind)).toEqual(["plan-started"]);
  });
  it("sorts newest first", () => {
    const all = buildActivity([planItems([plan()], facts), purchaseItems([buy(t("2026-11-18T10:00:00Z"), 1)], [plan()])]);
    expect(all.map((i) => i.kind)).toEqual(["purchase", "plan-started", "registration"]);
  });
});

describe("agentStatusFor", () => {
  const facts = new Map<string, TxFacts | null>();
  it("says stopped only when the chain shows the key revoked", () => {
    expect(agentStatusFor({ plan: plan(), chainStatus: "active", stopping: { txHash: H(3) }, facts })).toEqual({ kind: "stopping", txHash: H(3) });
    expect(agentStatusFor({ plan: plan(), chainStatus: "revoked", stopping: { txHash: H(3) }, facts })).toMatchObject({ kind: "stopped", txHash: H(3) });
    expect(agentStatusFor({ plan: plan(), chainStatus: "active", stopping: null, facts })).toEqual({ kind: "active" });
    expect(agentStatusFor({ plan: plan(), chainStatus: "expired", stopping: null, facts })).toMatchObject({ kind: "expired" });
    expect(agentStatusFor({ plan: null, chainStatus: null, stopping: null, facts })).toEqual({ kind: "none" });
  });
});

describe("nextPurchaseFor", () => {
  it("makes a new plan's first purchase due at once, then follows the period's due time", () => {
    const p = plan({ period: "day", hourUtc: 9 });
    const now = t("2026-11-20T08:00:00Z");
    // No purchase yet: due since the plan's creation (the runner buys at its next tick), whatever the period.
    expect(nextPurchaseFor(p, [], now, { kind: "active" })?.toISOString()).toBe("2026-11-18T09:00:00.000Z");
    // Bought yesterday: today's 09:00.
    expect(nextPurchaseFor(p, [buy(t("2026-11-19T09:00:10Z"), 1)], now, { kind: "active" })?.toISOString()).toBe("2026-11-20T09:00:00.000Z");
    expect(nextPurchaseFor(p, [buy(t("2026-11-20T09:00:10Z"), 1)], t("2026-11-20T10:00:00Z"), { kind: "active" })?.toISOString()).toBe("2026-11-21T09:00:00.000Z");
    expect(nextPurchaseFor(p, [], now, { kind: "stopped", stoppedAt: null })).toBeNull();
    // Bought today, and the plan ends before tomorrow's buy: nothing more is scheduled.
    const ending = plan({ period: "day", hourUtc: 9, expiresAt: t("2026-11-20T23:00:00Z") });
    expect(nextPurchaseFor(ending, [buy(t("2026-11-20T09:00:10Z"), 1)], t("2026-11-20T10:00:00Z"), { kind: "active" })).toBeNull();
  });

  it("ignores purchases from before the plan, and keeps 12 h after a late catch-up purchase", () => {
    const p = plan({ period: "day", hourUtc: 1, createdAt: t("2026-11-18T01:00:00Z") });
    expect(nextPurchaseFor(p, [buy(t("2026-11-17T12:00:00Z"), 1)], t("2026-11-18T02:00:00Z"), { kind: "active" })?.toISOString()).toBe("2026-11-18T01:00:00.000Z");
    const late = [buy(t("2026-11-18T01:01:00Z"), 1), buy(t("2026-11-19T23:50:00Z"), 2)];
    expect(nextPurchaseFor(p, late, t("2026-11-20T00:30:00Z"), { kind: "active" })?.toISOString()).toBe("2026-11-20T11:50:00.000Z");
  });
});

describe("runLogPurchases and mergePurchases", () => {
  it("turns the run log's purchases into history, and lets the chain's copy win", () => {
    const log: RunLogView[] = [
      { planId: "p1", periodId: "2026-11-18", at: t("2026-11-18T09:01:00Z"), outcome: "bought", reason: "weekly purchase", txHash: H(101), amountIn: "5000000", out: "1400", kind: "weekly" },
      { planId: "p1", periodId: "2026-11-18", at: t("2026-11-18T10:00:00Z"), outcome: "skipped", reason: "x", kind: "twap_unavailable" },
      { planId: "p1", periodId: "2026-11-25", at: t("2026-11-25T09:01:00Z"), outcome: "bought", reason: "weekly purchase", txHash: H(102), amountIn: "5000000", out: "1400", kind: "weekly" },
    ];
    const fromLog = runLogPurchases(log, WALLET);
    expect(fromLog.map((p) => [p.txHash, p.amountIn, p.out])).toEqual([
      [H(101), 5_000_000n, 1_400n],
      [H(102), 5_000_000n, 1_400n],
    ]);
    const merged = mergePurchases([buy(t("2026-11-18T09:01:05Z"), 1)], fromLog);
    expect(merged.map((p) => p.txHash)).toEqual([H(101), H(102)]);
    expect(merged[0]!.blockNumber).toBe(1001n); // the chain's copy
  });
});

describe("currentPlan", () => {
  it("prefers the active plan, ignores pending ones", () => {
    expect(currentPlan([plan({ id: "a", status: "stopped", createdAt: 5 }), plan({ id: "b", status: "pending_grant", createdAt: 9 })])?.id).toBe("a");
    expect(currentPlan([plan({ id: "a", status: "stopped", createdAt: 9 }), plan({ id: "b", status: "active", createdAt: 5 })])?.id).toBe("b");
    expect(currentPlan([plan({ status: "pending_grant" })])).toBeNull();
  });
});

describe("draftLimits", () => {
  const now = new Date("2026-11-21T18:00:00Z"); // Saturday
  it("shows the exact cap the grant writes: amount plus fee allowance, doubled by the dip rule", () => {
    expect(draftLimits({ amount: 5_000_000n, period: "week", buyTheDip: false }, now).cap).toBe(5_050_000n);
    expect(draftLimits({ amount: 1_000_000n, period: "day", buyTheDip: true }, now).cap).toBe(2_100_000n);
  });
  it("resets daily at 00:00 UTC and weekly on Monday 00:00 UTC; ends after 12 weeks", () => {
    expect(nextResetUtc(now, "day").toISOString()).toBe("2026-11-22T00:00:00.000Z");
    expect(nextResetUtc(now, "week").toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(draftLimits({ amount: 5_000_000n, period: "week", buyTheDip: false }, now).expiresAt.toISOString()).toBe("2027-02-13T18:00:00.000Z");
  });
});

describe("isFunded", () => {
  const s = (usdt: bigint, celo: bigint, fee: bigint) =>
    ({ balances: { usdt, gold: 0n, celo, observedAt: new Date() }, registration: { walletRegistered: false, nextGrantFeeCelo: fee } }) as AutumnState;
  it("needs USD₮ and the CELO the grant's registration sends", () => {
    expect(isFunded(s(1n, 10n, 10n))).toBe(true);
    expect(isFunded(s(1n, 9n, 10n))).toBe(false);
    expect(isFunded(s(0n, 10n, 10n))).toBe(false);
  });
});
