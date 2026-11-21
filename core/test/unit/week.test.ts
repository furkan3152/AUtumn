import { describe, expect, it } from "vitest";
import { dueTimeInWeek, nextWeekStart, weekId, weekStart, WEEK_SECS } from "../../src/week.js";

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("week helper (Monday 00:00 UTC)", () => {
  it("maps any moment of a week to its Monday 00:00 UTC", () => {
    const monday = t("2026-11-16T00:00:00Z");
    expect(weekStart(t("2026-11-16T00:00:00Z"))).toBe(monday);
    expect(weekStart(t("2026-11-18T13:45:10Z"))).toBe(monday);
    expect(weekStart(t("2026-11-22T23:59:59Z"))).toBe(monday);
    expect(weekStart(new Date("2026-11-21T18:00:00Z"))).toBe(monday);
  });

  it("resets exactly at Monday 00:00 UTC", () => {
    expect(weekStart(t("2026-11-23T00:00:00Z"))).toBe(t("2026-11-23T00:00:00Z"));
    expect(weekStart(t("2026-11-23T00:00:00Z") - 1)).toBe(t("2026-11-16T00:00:00Z"));
    expect(nextWeekStart(t("2026-11-21T10:00:00Z"))).toBe(t("2026-11-23T00:00:00Z"));
  });

  it("is UTC, not local time, across year ends", () => {
    expect(weekId(t("2027-01-01T05:00:00Z"))).toBe("2026-12-28");
    expect(weekId(t("2026-11-22T23:59:59Z"))).toBe("2026-11-16");
    expect(new Date(weekStart(t("2027-01-03T12:00:00Z")) * 1000).getUTCDay()).toBe(1);
  });

  it("matches solady mondayTimestamp at the epoch edge", () => {
    expect(weekStart(0)).toBe(0);
    expect(weekStart(345_599)).toBe(0);
    expect(weekStart(345_600)).toBe(345_600);
    expect(weekStart(345_600 + WEEK_SECS - 1)).toBe(345_600);
  });

  it("refuses milliseconds and negative values", () => {
    expect(() => weekStart(1.5)).toThrow();
    expect(() => weekStart(-1)).toThrow();
  });

  it("computes a plan's due time inside the week", () => {
    expect(dueTimeInWeek(t("2026-11-20T00:00:00Z"), 2, 9)).toBe(t("2026-11-18T09:00:00Z"));
    expect(() => dueTimeInWeek(0, 7, 0)).toThrow();
    expect(() => dueTimeInWeek(0, 0, 24)).toThrow();
  });
});
