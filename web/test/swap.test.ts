import { describe, expect, it } from "vitest";
import { SWAP_QUOTE_FRESH_MS, SwapUnavailableError, hasSpareCelo, swapKeepAndMax, type AutumnState, type SwapQuote } from "../src/lib/autumn";
import { amountView, latestOnly, quoteView, swapMaxNow } from "../src/lib/swap";

const CELO = 10n ** 18n;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const PER_KEY = 10n * CELO;

function quote(over: Partial<SwapQuote> = {}): SwapQuote {
  const fee = CELO / 20n;
  const { keep, max } = swapKeepAndMax(100n * CELO, { walletRegistered: true, perKeyFeeCelo: PER_KEY }, { fee, feeSymbol: "CELO", registrationCelo: 0n });
  return {
    amountIn: 5n * CELO,
    probe: false,
    expectedOut: 270_000n,
    minOut: 267_300n,
    referenceOut: 269_000n,
    belowReferenceBps: -37,
    fee,
    feeSymbol: "CELO",
    registrationCelo: 0n,
    keep,
    max,
    observedAt: new Date(NOW - 1_000),
    ...over,
  };
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

describe("swapKeepAndMax", () => {
  it("first passkey transaction with the fee in CELO: this swap's registration and fee, plus one key and 10% for the plan", () => {
    const { keep, max } = swapKeepAndMax(100n * CELO, { walletRegistered: false, perKeyFeeCelo: PER_KEY }, { fee: CELO / 10n, feeSymbol: "CELO", registrationCelo: PER_KEY });
    expect(keep).toEqual({ nextPlan: PER_KEY, thisTransaction: PER_KEY + (CELO * 15n) / 100n, buffer: CELO, total: 2n * PER_KEY + CELO + (CELO * 15n) / 100n });
    expect(max).toBe(100n * CELO - keep.total);
  });

  it("registered wallet with the fee in USD₮: only the next plan's registration and the spare", () => {
    const { keep } = swapKeepAndMax(100n * CELO, { walletRegistered: true, perKeyFeeCelo: PER_KEY }, { fee: 9_000n, feeSymbol: "USD₮", registrationCelo: 0n });
    expect(keep).toEqual({ nextPlan: PER_KEY, thisTransaction: 0n, buffer: CELO, total: PER_KEY + CELO });
  });
});

describe("amountView", () => {
  const q = quote();
  const balance = 100n * CELO;

  it("reads a decimal comma like Send out does", () => {
    expect(amountView("1,5", balance, q)).toEqual({ kind: "ok", amount: 1_500_000_000_000_000_000n, warning: false });
    expect(amountView("  ", balance, q)).toEqual({ kind: "empty" });
    expect(amountView("1.000,5", balance, q)).toMatchObject({ kind: "invalid", problem: expect.stringMatching(/decimal separator/) });
  });

  it("refuses zero and more than the balance, before and after a quote", () => {
    expect(amountView("0", balance, q)).toMatchObject({ kind: "invalid" });
    expect(amountView("100.000000000000000001", balance, null)).toMatchObject({ kind: "invalid", problem: expect.stringMatching(/more CELO/) });
    expect(amountView("100", balance, q)).toMatchObject({ kind: "invalid", problem: expect.stringMatching(/network fee/) });
  });

  it("warns, without refusing, above Max", () => {
    const max = swapMaxNow(balance, q)!;
    expect(amountView((max / CELO).toString(), balance, q)).toMatchObject({ kind: "ok", warning: false });
    expect(amountView("95", balance, q)).toMatchObject({ kind: "ok", warning: true });
  });
});

describe("quoteView", () => {
  const q = quote();
  const base = { amount: q.amountIn, quote: q, loading: false, error: null, now: NOW };

  it("shows a fresh quote for the typed amount as ready", () => {
    expect(quoteView(base, errText)).toEqual({ kind: "ready", quote: q });
  });

  it("never shows a quote for another amount, or the stand-in, as this amount's", () => {
    expect(quoteView({ ...base, amount: 6n * CELO }, errText)).toEqual({ kind: "loading" });
    expect(quoteView({ ...base, quote: quote({ probe: true }) }, errText)).toEqual({ kind: "loading" });
    expect(quoteView({ ...base, loading: true }, errText)).toEqual({ kind: "loading" });
  });

  it("marks a quote older than a minute as stale", () => {
    expect(quoteView({ ...base, now: q.observedAt.getTime() + SWAP_QUOTE_FRESH_MS }, errText).kind).toBe("ready");
    expect(quoteView({ ...base, now: q.observedAt.getTime() + SWAP_QUOTE_FRESH_MS + 1 }, errText).kind).toBe("stale");
  });

  it("keeps unavailable apart from other errors, also before an amount is typed", () => {
    const unavailable = new SwapUnavailableError("unreadable", "Celo's reference rate could not be read.");
    expect(quoteView({ ...base, error: unavailable }, errText)).toEqual({ kind: "unavailable", message: unavailable.message });
    expect(quoteView({ ...base, amount: null, error: new SwapUnavailableError("price", "too far below") }, errText).kind).toBe("unavailable");
    expect(quoteView({ ...base, error: new Error("relay busy") }, errText)).toEqual({ kind: "error", message: "relay busy" });
    expect(quoteView({ ...base, amount: null }, errText)).toEqual({ kind: "idle" });
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
    expect(hasSpareCelo({ ...state(0n, true), balances: null })).toBe(false);
  });
});
