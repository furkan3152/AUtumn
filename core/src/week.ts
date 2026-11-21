/**
 * Calendar weeks as the Altana account meters them: a week starts Monday
 * 00:00:00 UTC (`DateTimeLib.mondayTimestamp`, GuardedExecutor.startOfSpendPeriod).
 * All values are unix seconds.
 */

export const WEEK_SECS = 604_800;
export const DAY_SECS = 86_400;
/** 1970-01-05 00:00 UTC, the first Monday after the epoch (a Thursday). */
const FIRST_MONDAY = 345_600;

/** Unix seconds for a Date, a millisecond count is never accepted silently. */
export function toUnixSeconds(t: Date | number): number {
  if (t instanceof Date) return Math.floor(t.getTime() / 1000);
  if (!Number.isInteger(t) || t < 0) throw new Error(`not a unix timestamp in seconds: ${t}`);
  return t;
}

/** Start of the calendar week (Monday 00:00 UTC) containing `t`. Matches solady's mondayTimestamp. */
export function weekStart(t: Date | number): number {
  const s = toUnixSeconds(t);
  if (s < FIRST_MONDAY) return 0;
  return Math.floor((s - FIRST_MONDAY) / WEEK_SECS) * WEEK_SECS + FIRST_MONDAY;
}

/** Start of the following week: the moment the account's weekly spend resets. */
export function nextWeekStart(t: Date | number): number {
  return weekStart(t) + WEEK_SECS;
}

/** A stable id for the week containing `t`: the Monday's date, `YYYY-MM-DD`. */
export function weekId(t: Date | number): string {
  return new Date(weekStart(t) * 1000).toISOString().slice(0, 10);
}

/**
 * The moment inside the week of `t` a plan's purchase becomes due.
 * `dayOfWeek` 0 = Monday … 6 = Sunday, `hourUtc` 0–23.
 */
export function dueTimeInWeek(t: Date | number, dayOfWeek: number, hourUtc: number): number {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new Error(`dayOfWeek out of range: ${dayOfWeek}`);
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) throw new Error(`hourUtc out of range: ${hourUtc}`);
  return weekStart(t) + dayOfWeek * DAY_SECS + hourUtc * 3600;
}
