import { describe, expect, it } from "vitest";
import {
  dayStart,
  dueTimeInPeriod,
  nextDueTime,
  nextPeriodStart,
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
