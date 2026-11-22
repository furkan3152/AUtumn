import { describe, expect, it } from "vitest";
import { SWAP_QUOTE_FRESH_MS, SwapUnavailableError, hasSpareCelo, swapRouteText, usdtForNextPurchase, type AutumnState, type SwapQuote } from "../src/lib/autumn";
import { amountView, latestOnly, pickPair, quoteView, swapFeeFor, swapMaxNow, usdtShortfall } from "../src/lib/swap";

const CELO = 10n ** 18n;
const USD = 10n ** 6n;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const PER_KEY = 10n * CELO;
const FEES = { usdt: 10_000n, celo: CELO / 10n, registration: 0n };
const BAL = { celo: 100n * CELO, usdt: 20n * USD, gold: 5_000n };

function quote(over: Partial<SwapQuote> = {}): SwapQuote {
  return {
    from: "CELO",
    to: "USDT",
    amountIn: 5n * CELO,
    probe: false,
    expectedOut: 270_000n,
    minOut: 267_300n,
    referenceOut: 269_000n,
    belowReferenceBps: -37,
    viaUsdt: false,
    poolFees: "0.01%",
    fees: FEES,
    plan: { walletRegistered: true, perKeyFee: PER_KEY },
    observedAt: new Date(NOW - 1_000),
    ...over,
  };
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

describe("amountView", () => {
  it("parses at the asset's decimals and reads a decimal comma like Send out does", () => {
    expect(amountView("1,5", "CELO", "USDT", BAL, quote())).toMatchObject({ kind: "ok", amount: 1_500_000_000_000_000_000n });
    expect(amountView("1,5", "USDT", "XAUT0", BAL, quote({ from: "USDT", to: "XAUT0" }))).toMatchObject({ kind: "ok", amount: 1_500_000n });
    expect(amountView("0,001", "XAUT0", "USDT", BAL, null)).toMatchObject({ kind: "ok", amount: 1_000n, feeToken: null });
    expect(amountView("0.0000001", "XAUT0", "USDT", BAL, null)).toMatchObject({ kind: "invalid", problem: "Enter at most 6 decimals." });
    expect(amountView("  ", "CELO", "USDT", BAL, null)).toEqual({ kind: "empty" });
    expect(amountView("1.000,5", "CELO", "USDT", BAL, null)).toMatchObject({ kind: "invalid", problem: expect.stringMatching(/decimal separator/) });
  });

  it("refuses zero and more than the balance, before and after a quote", () => {
    expect(amountView("0", "CELO", "USDT", BAL, quote())).toMatchObject({ kind: "invalid" });
    expect(amountView("0.006", "XAUT0", "USDT", BAL, null)).toMatchObject({ kind: "invalid", problem: expect.stringMatching(/more gold/) });
    expect(amountView("21", "USDT", "CELO", BAL, quote({ from: "USDT", to: "CELO" }))).toMatchObject({ kind: "invalid", problem: expect.stringMatching(/more USD₮/) });
  });

  it("ignores a quote for another pair (its fees and Max are not this pair's)", () => {
    expect(amountView("1", "USDT", "XAUT0", BAL, quote())).toMatchObject({ kind: "ok", feeToken: null });
  });

  it("warns, without refusing, when CELO above Max is sold", () => {
    const max = swapMaxNow("CELO", "USDT", BAL, quote())!.max;
    expect(max).toBe(100n * CELO - 11n * CELO);
    expect(amountView("89", "CELO", "USDT", BAL, quote())).toMatchObject({ kind: "ok", leavesTooLittle: false, feeToken: "USDT" });
    expect(amountView("95", "CELO", "USDT", BAL, quote())).toMatchObject({ kind: "ok", leavesTooLittle: true });
  });

  it("selling all USD₮ moves the fee to CELO; the fee token follows the amount", () => {
    const q = quote({ from: "USDT", to: "XAUT0" });
    expect(amountView("20", "USDT", "XAUT0", BAL, q)).toMatchObject({ kind: "ok", feeToken: "CELO" });
    expect(amountView("19.985", "USDT", "XAUT0", BAL, q)).toMatchObject({ kind: "ok", feeToken: "USDT" });
    expect(swapMaxNow("USDT", "XAUT0", BAL, q)).toEqual({ max: 20n * USD - 15_000n, keep: null });
    expect(amountView("20", "USDT", "XAUT0", { ...BAL, celo: 0n }, q)).toMatchObject({ kind: "invalid", problem: expect.stringMatching(/network fee/) });
  });

  it("Max for gold is the whole balance; nothing is kept when CELO is bought", () => {
    const q = quote({ from: "XAUT0", to: "CELO" });
    expect(swapMaxNow("XAUT0", "CELO", BAL, q)).toEqual({ max: 5_000n, keep: null });
  });
});

describe("fees and the plan warning", () => {
  it("names the fee for the amount in its token", () => {
    const q = quote({ from: "USDT", to: "XAUT0" });
    expect(swapFeeFor("USDT", 20n * USD, BAL, q)).toEqual({ token: "CELO", fee: CELO / 10n });
    expect(swapFeeFor("USDT", USD, BAL, q)).toEqual({ token: "USDT", fee: 10_000n });
  });

  it("warns when selling USD₮ leaves less than the running plan's next purchase", () => {
    const running = { plan: { amount: 5n * USD } as AutumnState["plan"], agent: { kind: "active" } as const };
    expect(usdtForNextPurchase(running)).toBe(5_050_000n);
    expect(usdtForNextPurchase({ ...running, agent: { kind: "stopped", stoppedAt: null } })).toBeNull();
    expect(usdtShortfall("USDT", 15n * USD, "USDT", 10_000n, 20n * USD, 5_050_000n)).toBe(4_990_000n);
    expect(usdtShortfall("USDT", 14n * USD, "USDT", 10_000n, 20n * USD, 5_050_000n)).toBeNull();
    expect(usdtShortfall("USDT", 20n * USD, "CELO", 10_000n, 20n * USD, 5_050_000n)).toBe(0n);
    expect(usdtShortfall("CELO", CELO, "USDT", 10_000n, 0n, 5_050_000n)).toBeNull();
    expect(usdtShortfall("USDT", 20n * USD, "CELO", 0n, 20n * USD, null)).toBeNull();
  });
});

describe("quoteView", () => {
  const q = quote();
  const base = { from: "CELO" as const, to: "USDT" as const, amount: q.amountIn, quote: q, loading: false, error: null, now: NOW };

  it("shows a fresh quote for the typed amount and pair as ready", () => {
    expect(quoteView(base, errText)).toEqual({ kind: "ready", quote: q });
  });

  it("never shows a quote for another amount, another pair, or the stand-in, as this one's", () => {
    expect(quoteView({ ...base, amount: 6n * CELO }, errText)).toEqual({ kind: "loading" });
    expect(quoteView({ ...base, to: "XAUT0" }, errText)).toEqual({ kind: "loading" });
    expect(quoteView({ ...base, quote: quote({ probe: true }) }, errText)).toEqual({ kind: "loading" });
    expect(quoteView({ ...base, loading: true }, errText)).toEqual({ kind: "loading" });
  });

  it("marks a quote older than a minute as stale", () => {
    expect(quoteView({ ...base, now: q.observedAt.getTime() + SWAP_QUOTE_FRESH_MS }, errText).kind).toBe("ready");
    expect(quoteView({ ...base, now: q.observedAt.getTime() + SWAP_QUOTE_FRESH_MS + 1 }, errText).kind).toBe("stale");
  });

  it("keeps unavailable apart from other errors, also before an amount is typed", () => {
    const noAverage = new SwapUnavailableError("no-average", "Converting gold is unavailable right now.");
    expect(quoteView({ ...base, error: noAverage }, errText)).toEqual({ kind: "unavailable", message: noAverage.message });
    expect(quoteView({ ...base, amount: null, error: new SwapUnavailableError("price", "moves the pool's price too much") }, errText).kind).toBe("unavailable");
    expect(quoteView({ ...base, error: new Error("relay busy") }, errText)).toEqual({ kind: "error", message: "relay busy" });
    expect(quoteView({ ...base, amount: null }, errText)).toEqual({ kind: "idle" });
  });
});

describe("pickPair and the route line", () => {
  it("never lets From and To be equal", () => {
    expect(pickPair("from", "USDT", { from: "CELO", to: "USDT" })).toEqual({ from: "USDT", to: "CELO" });
    expect(pickPair("from", "XAUT0", { from: "CELO", to: "USDT" })).toEqual({ from: "XAUT0", to: "USDT" });
    expect(pickPair("to", "CELO", { from: "CELO", to: "USDT" })).toEqual({ from: "USDT", to: "CELO" });
    expect(pickPair("to", "XAUT0", { from: "CELO", to: "USDT" })).toEqual({ from: "CELO", to: "XAUT0" });
  });

  it("names the pools", () => {
    expect(swapRouteText("CELO", "USDT")).toMatch(/CELO\/USD₮ pool .*0\.01%/);
    expect(swapRouteText("XAUT0", "USDT")).toMatch(/USD₮\/XAUt0 pool .*0\.3%/);
    expect(swapRouteText("XAUT0", "CELO")).toMatch(/via USD₮ through two/);
  });
});

describe("latestOnly", () => {
  it("drops answers to requests that were superseded", () => {
    const l = latestOnly();
    const a = l.next();
    const b = l.next();
    expect(l.isCurrent(a)).toBe(false);
    expect(l.isCurrent(b)).toBe(true);
  });
});

describe("hasSpareCelo", () => {
  const state = (celo: bigint, walletRegistered: boolean) =>
    ({
      balances: { usdt: 0n, gold: 0n, celo, observedAt: new Date(NOW) },
      registration: { walletRegistered, nextGrantFeeCelo: walletRegistered ? PER_KEY : 2n * PER_KEY, perKeyFeeCelo: PER_KEY },
    }) as AutumnState;

  it("offers conversion only above the next plan's registration plus the spare", () => {
    expect(hasSpareCelo(state(21n * CELO, false))).toBe(false);
    expect(hasSpareCelo(state(21n * CELO + 1n, false))).toBe(true);
    expect(hasSpareCelo(state(11n * CELO, true))).toBe(false);
    expect(hasSpareCelo(state(11n * CELO + 1n, true))).toBe(true);
  });
});
