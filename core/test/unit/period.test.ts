import { describe, expect, it } from "vitest";
import {
  dayStart,
  dueTimeInPeriod,
  MIN_PURCHASE_SPACING_SECS,
  nextDueTime,
  nextPeriodStart,
  nextScheduledPurchase,
  periodId,
  periodStart,
  utcDayOfWeek,
  utcHour,
} from "../../src/period.js";

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("spend periods (as the account's startOfSpendPeriod reports them)", () => {
  // Values read from the Celo mainnet account implementation on 2026-11-21:
  // startOfSpendPeriod(t, Day=2) and (t, Week=3).
  it("matches the onchain day and week starts", () => {
    expect(periodStart(t("2026-11-21T18:30:00Z"), "day")).toBe(t("2026-11-21T00:00:00Z"));
    expect(periodStart(t("2026-11-21T23:59:59Z"), "day")).toBe(t("2026-11-21T00:00:00Z"));
    expect(periodStart(t("2026-11-22T00:00:00Z"), "day")).toBe(t("2026-11-22T00:00:00Z"));
    expect(periodStart(t("2026-11-22T00:00:00Z"), "week")).toBe(t("2026-11-16T00:00:00Z"));
  });

  it("resets a day at 00:00 UTC and a week at Monday 00:00 UTC", () => {
    expect(nextPeriodStart(t("2026-11-21T10:00:00Z"), "day")).toBe(t("2026-11-22T00:00:00Z"));
    expect(nextPeriodStart(t("2026-11-21T10:00:00Z"), "week")).toBe(t("2026-11-23T00:00:00Z"));
    expect(dayStart(t("2026-12-31T23:59:59Z"))).toBe(t("2026-12-31T00:00:00Z"));
  });

  it("names periods by their first day", () => {
    expect(periodId(t("2026-11-21T10:00:00Z"), "day")).toBe("2026-11-21");
    expect(periodId(t("2026-11-21T10:00:00Z"), "week")).toBe("2026-11-16");
  });

  it("puts every day inside one week", () => {
    for (let d = 0; d < 21; d++) {
      const s = t("2026-11-16T00:00:00Z") + d * 86400;
      expect(periodStart(s, "week")).toBe(periodStart(s + 86399, "week"));
    }
  });

  it("computes due times per period", () => {
    const now = t("2026-11-18T12:00:00Z"); // Wednesday
    expect(dueTimeInPeriod(now, "day", 6, 9)).toBe(t("2026-11-18T09:00:00Z"));
    expect(dueTimeInPeriod(now, "week", 4, 9)).toBe(t("2026-11-20T09:00:00Z"));
    expect(nextDueTime(now, "day", 0, 9, true)).toBe(t("2026-11-19T09:00:00Z"));
    expect(nextDueTime(now, "week", 2, 9, true)).toBe(t("2026-11-25T09:00:00Z"));
    expect(nextDueTime(now, "week", 2, 9, false)).toBe(t("2026-11-18T09:00:00Z"));
  });

  it("reads the UTC weekday and hour", () => {
    expect(utcDayOfWeek(t("2026-11-16T00:00:00Z"))).toBe(0);
    expect(utcDayOfWeek(t("2026-11-22T23:59:59Z"))).toBe(6);
    expect(utcHour(t("2026-11-22T23:59:59Z"))).toBe(23);
  });
});

describe("nextScheduledPurchase (the runner's and the app's one schedule)", () => {
  it("makes a new plan's first purchase due at once, even late on a Sunday", () => {
    const createdAt = t("2026-11-22T23:05:00Z"); // a Sunday
    const daily = { period: "day" as const, dayOfWeek: 0, hourUtc: 23, createdAt };
    const weekly = { period: "week" as const, dayOfWeek: 6, hourUtc: 23, createdAt };
    const none = { lastPurchaseAt: null, boughtThisPeriod: false };
    expect(nextScheduledPurchase(daily, createdAt + 60, none)).toBe(createdAt);
    expect(nextScheduledPurchase(weekly, createdAt + 60, none)).toBe(createdAt);
    // The next tick may land after midnight, in the next period: still due.
    expect(nextScheduledPurchase(daily, t("2026-11-23T00:03:00Z"), none)).toBe(createdAt);
  });

  it("then follows the normal schedule", () => {
    const createdAt = t("2026-11-22T23:05:00Z");
    const daily = { period: "day" as const, dayOfWeek: 0, hourUtc: 23, createdAt };
    const bought = t("2026-11-22T23:06:00Z");
    expect(nextScheduledPurchase(daily, bought + 60, { lastPurchaseAt: bought, boughtThisPeriod: true })).toBe(t("2026-11-23T23:00:00Z"));
    const weekly = { period: "week" as const, dayOfWeek: 6, hourUtc: 23, createdAt };
    expect(nextScheduledPurchase(weekly, bought + 60, { lastPurchaseAt: bought, boughtThisPeriod: true })).toBe(t("2026-11-29T23:00:00Z"));
  });

  it("keeps a minimum spacing after a late catch-up purchase across midnight", () => {
    const daily = { period: "day" as const, dayOfWeek: 0, hourUtc: 1, createdAt: t("2026-11-01T01:00:00Z") };
    const catchUp = t("2026-11-21T23:50:00Z");
    const now = t("2026-11-22T01:05:00Z");
    const due = nextScheduledPurchase(daily, now, { lastPurchaseAt: catchUp, boughtThisPeriod: false });
    expect(due).toBe(catchUp + MIN_PURCHASE_SPACING_SECS.day);
    expect(due).toBe(t("2026-11-22T11:50:00Z"));
    // Never pushed out of the period: the spacing is shorter than a day.
    expect(due < t("2026-11-23T00:00:00Z")).toBe(true);
  });

  it("puts no spacing on a purchase older than the spacing window (0)", () => {
    const daily = { period: "day" as const, dayOfWeek: 0, hourUtc: 9, createdAt: t("2026-11-01T09:00:00Z") };
    expect(nextScheduledPurchase(daily, t("2026-11-22T10:00:00Z"), { lastPurchaseAt: 0, boughtThisPeriod: false })).toBe(t("2026-11-22T09:00:00Z"));
  });
});
