import { DECIMALS, GRAMS_PER_TROY_OUNCE, type Address } from "./autumn";

/** Exact decimal string of a base-unit amount, trimmed to `maxFraction` digits (rounded down). */
export function formatUnits(value: bigint, decimals: number, maxFraction: number, minFraction = 0): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction);
  frac = frac.replace(/0+$/, "");
  while (frac.length < minFraction) frac += "0";
  const wholeStr = whole.toLocaleString("en-US");
  return `${neg ? "-" : ""}${wholeStr}${frac ? `.${frac}` : ""}`;
}

export const usdt = (v: bigint) => formatUnits(v, DECIMALS.USDT, 2, 2);
/** USD₮ with up to 4 decimals, for fees smaller than a cent. */
export const usdtFine = (v: bigint) => formatUnits(v, DECIMALS.USDT, 4, 2);
export const celo = (v: bigint) => formatUnits(v, DECIMALS.CELO, 2);

/** XAUt0 base units to grams (display only). */
export function grams(goldUnits: bigint): number {
  return (Number(goldUnits) / 10 ** DECIMALS.XAUT0) * GRAMS_PER_TROY_OUNCE;
}

export function formatGrams(goldUnits: bigint): string {
  const g = grams(goldUnits);
  if (g === 0) return "0";
  if (g < 1) return g.toFixed(4);
  if (g < 100) return g.toFixed(3);
  return g.toFixed(2);
}

/** USD value of gold, in USD₮ base units. */
export function goldValue(goldUnits: bigint, usdtPerOunce: bigint): bigint {
  return (goldUnits * usdtPerOunce) / 10n ** BigInt(DECIMALS.XAUT0);
}

/** Price per gram in USD₮ base units, from a per-ounce price. */
export function perGram(usdtPerOunce: bigint): bigint {
  return (usdtPerOunce * 10_000_000n) / BigInt(Math.round(GRAMS_PER_TROY_OUNCE * 10_000_000));
}

export function shortAddress(a: Address | string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export const formatDate = (d: Date) => dateFmt.format(d);
export const formatDateTime = (d: Date) => dateTimeFmt.format(d);

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/**
 * "in 5 minutes", "3 hours ago". Pass `past: true` for an instant that has
 * happened (a stop, a purchase): it never reads as the future, even when the
 * chain's clock is a little ahead of this device's.
 */
export function relative(d: Date, now = Date.now(), opts: { past?: boolean } = {}): string {
  let diff = d.getTime() - now;
  if (opts.past && diff > 0) diff = 0;
  const abs = Math.abs(diff);
  const future = diff > 0;
  const wrap = (s: string) => (future ? `in ${s}` : `${s} ago`);
  if (abs < 45_000) return future ? "in less than a minute" : "just now";
  const min = Math.max(1, Math.round(abs / 60_000));
  if (min < 60) return wrap(plural(min, "minute"));
  const h = Math.round(abs / 3_600_000);
  if (h < 36) return wrap(plural(h, "hour"));
  return wrap(plural(Math.round(abs / 86_400_000), "day"));
}

/** Approximate dollars for an amount in USD₮ base units: "about $1.04", or "under $0.01". */
export function approxUsd(v: bigint): string {
  if (v > 0n && v < 10_000n) return "under $0.01";
  return `about $${formatUnits(v, DECIMALS.USDT, 2, 2)}`;
}

/** A fixed-point percentage from basis points: 40 → "0.40%". */
export function bpsPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
