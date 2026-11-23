import { describe, expect, it } from "vitest";
import { planToSessionGrant } from "@autumn/core";
import { PLAN_PRESETS_USDT, draftLimits, suggestedDeposit } from "../src/lib/autumn";
import { dollarLabel, planAmountView } from "../src/lib/plan";

const NOW = new Date("2026-11-23T12:00:00Z");

describe("planAmountView", () => {
  it("keeps the three presets at exactly 1, 5 and 10 USD₮", () => {
    expect(PLAN_PRESETS_USDT).toEqual([1, 5, 10]);
    expect(PLAN_PRESETS_USDT.map((p) => planAmountView(p, "anything typed earlier"))).toEqual([
      { kind: "ok", amount: 1_000_000n },
      { kind: "ok", amount: 5_000_000n },
      { kind: "ok", amount: 10_000_000n },
    ]);
  });

  it("reads the custom field with the app's decimal parser and the plan rules", () => {
    expect(planAmountView("custom", "")).toEqual({ kind: "empty" });
    expect(planAmountView("custom", "   ")).toEqual({ kind: "empty" });
    expect(planAmountView("custom", "4")).toEqual({ kind: "ok", amount: 4_000_000n });
    expect(planAmountView("custom", "4,5")).toEqual({ kind: "ok", amount: 4_500_000n });
    expect(planAmountView("custom", "1")).toEqual({ kind: "ok", amount: 1_000_000n });
    expect(planAmountView("custom", "100.00")).toEqual({ kind: "ok", amount: 100_000_000n });
    expect(planAmountView("custom", "0.5")).toEqual({ kind: "invalid", problem: "Enter at least 1 USD₮." });
    expect(planAmountView("custom", "150")).toEqual({ kind: "invalid", problem: "Enter at most 100 USD₮." });
    expect(planAmountView("custom", "4.555")).toEqual({ kind: "invalid", problem: "Enter at most 2 decimals." });
    expect(planAmountView("custom", "abc")).toMatchObject({ kind: "invalid" });
  });

  it("shows the limits, the full-plan deposit and the cost the grant will use for a custom amount", () => {
    const v = planAmountView("custom", "4.5");
    if (v.kind !== "ok") throw new Error("expected a valid amount");
    const exp = Math.floor(NOW.getTime() / 1000) + 84 * 86400;
    for (const buyTheDip of [false, true]) {
      const shown = draftLimits({ amount: v.amount, period: "day", buyTheDip }, NOW);
      const grant = planToSessionGrant({ amountPerBuy: v.amount, period: "day", dipBuy: buyTheDip, expiresAt: exp }, "0x1111111111111111111111111111111111111111", exp - 84 * 86400);
      expect(shown.cap).toBe(grant.periodCap);
      expect(shown.cap).toBe(buyTheDip ? 9_100_000n : 4_550_000n);
    }
    expect(suggestedDeposit(v.amount, "day")).toBe(382_200_000n); // (4.50 + 0.05) × 84
    expect(suggestedDeposit(v.amount, "week")).toBe(54_600_000n); // (4.50 + 0.05) × 12
  });
});

describe("dollarLabel", () => {
  it("reads whole amounts as the presets do and others with cents", () => {
    expect(dollarLabel(5_000_000n)).toBe("$5");
    expect(dollarLabel(100_000_000n)).toBe("$100");
    expect(dollarLabel(4_500_000n)).toBe("$4.50");
    expect(dollarLabel(4_010_000n)).toBe("$4.01");
  });
});
