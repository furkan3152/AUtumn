/**
 * Spend periods as the Altana account meters them. Verified read-only on
 * Celo mainnet against the account implementation's own
 * `startOfSpendPeriod(t, period)` (0x4b5d…fa79, 2026-11-21):
 *
 * - "day" starts at 00:00:00 UTC of the calendar day (period id 2);
 * - "week" starts Monday 00:00:00 UTC (period id 3).
 *
 * Every UTC day lies inside exactly one calendar week, so a week's purchases
 * contain every day's purchases of that week.
 */
import { DAY_SECS, WEEK_SECS, dueTimeInWeek, toUnixSeconds, weekStart } from "./week.js";

export type PlanPeriod = "day" | "week";

export const PLAN_PERIODS: readonly PlanPeriod[] = ["week", "day"];

export function isPlanPeriod(v: unknown): v is PlanPeriod {
  return v === "day" || v === "week";
}

export function periodSecs(period: PlanPeriod): number {
  return period === "day" ? DAY_SECS : WEEK_SECS;
}

/** Start of the UTC calendar day containing `t`. */
export function dayStart(t: Date | number): number {
  const s = toUnixSeconds(t);
  return s - (s % DAY_SECS);
}

/** Start of the period containing `t`: the moment the account's spend counter for it starts at 0. */
export function periodStart(t: Date | number, period: PlanPeriod): number {
  return period === "day" ? dayStart(t) : weekStart(t);
}

/** When the account's spend for the period containing `t` resets. */
export function nextPeriodStart(t: Date | number, period: PlanPeriod): number {
  return periodStart(t, period) + periodSecs(period);
}

/** A stable id for the period containing `t`: its first day's date, `YYYY-MM-DD`. */
export function periodId(t: Date | number, period: PlanPeriod): string {
  return new Date(periodStart(t, period) * 1000).toISOString().slice(0, 10);
}

/**
 * When the plan's purchase becomes due inside the period containing `t`.
 * Weekly: `dayOfWeek` (0 = Monday) at `hourUtc`. Daily: `hourUtc`; `dayOfWeek` is ignored.
 */
export function dueTimeInPeriod(t: Date | number, period: PlanPeriod, dayOfWeek: number, hourUtc: number): number {
  if (period === "week") return dueTimeInWeek(t, dayOfWeek, hourUtc);
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) throw new Error(`hourUtc out of range: ${hourUtc}`);
  return dayStart(t) + hourUtc * 3600;
}

/** 0 = Monday … 6 = Sunday, in UTC. */
export function utcDayOfWeek(t: Date | number): number {
  const s = toUnixSeconds(t);
  return (Math.floor(s / DAY_SECS) + 3) % 7; // 1970-01-01 was a Thursday (3)
}

/** Hour of the day in UTC. */
export function utcHour(t: Date | number): number {
  return Math.floor((toUnixSeconds(t) % DAY_SECS) / 3600);
}

/**
 * The next time the plan is due to buy, given whether it has already bought
 * in the current period. Returns the due time of the current period when it
 * has not bought yet (this may be in the past: the purchase is due now).
 */
export function nextDueTime(
  now: number,
  period: PlanPeriod,
  dayOfWeek: number,
  hourUtc: number,
  boughtThisPeriod: boolean,
): number {
  if (!boughtThisPeriod) return dueTimeInPeriod(now, period, dayOfWeek, hourUtc);
  return dueTimeInPeriod(nextPeriodStart(now, period), period, dayOfWeek, hourUtc);
}

/**
 * The least time between two scheduled purchases of one plan. A purchase that
 * caught up late in a period (23:50 UTC for a daily plan due at 01:00) must
 * not be followed by the next period's purchase minutes later. Shorter than
 * the period, so a period is never skipped because of it: its due time moves
 * later inside the period at most.
 */
export const MIN_PURCHASE_SPACING_SECS: Record<PlanPeriod, number> = { day: 12 * 3600, week: 3 * DAY_SECS };

export type PurchaseHistory = {
  /**
   * The newest purchase of this plan (at or after its creation), unix
   * seconds; null when the plan has not bought yet. 0 when the plan has bought
   * but longer ago than the spacing reaches (no constraint).
   */
  lastPurchaseAt: number | null;
  /** Whether the plan's scheduled purchase of the period containing `now` happened. */
  boughtThisPeriod: boolean;
};

/**
 * When the plan's next scheduled purchase is due: the one rule the runner
 * decides by and the app shows.
 *
 * - The first purchase of a new plan is due at its creation, whatever the
 *   period boundary (a daily plan created at 23:05 UTC does not wait a day).
 * - After that: the period's due time (`dayOfWeek`, `hourUtc`), the next
 *   period's once this one has bought, and never earlier than
 *   MIN_PURCHASE_SPACING_SECS after the previous purchase.
 *
 * May be in the past: the purchase is due now.
 */
export function nextScheduledPurchase(
  plan: { period: PlanPeriod; dayOfWeek: number; hourUtc: number; createdAt: number },
  now: number,
  history: PurchaseHistory,
): number {
  if (history.lastPurchaseAt === null) return plan.createdAt;
  const due = nextDueTime(now, plan.period, plan.dayOfWeek, plan.hourUtc, history.boughtThisPeriod);
  const spaced = history.lastPurchaseAt + MIN_PURCHASE_SPACING_SECS[plan.period];
  return due > spaced ? due : spaced;
}

/** Plans run for 12 weeks; the session expires then. */
export const PLAN_DURATION_WEEKS = 12;
export const PLAN_DURATION_SECS = PLAN_DURATION_WEEKS * WEEK_SECS;
