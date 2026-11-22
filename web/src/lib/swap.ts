/**
 * What the "Convert" screen shows, as pure functions of what it knows: the
 * pair, the typed amount, the balances and the latest quote. Kept out of the
 * component so the states stay distinct and testable.
 */
import { SWAP_DECIMALS, checkSwapAmount, parseAmountText, swapBalanceOf, swapFeeToken, swapMax, type SwapKeep } from "@autumn/core";
import { SWAP_QUOTE_FRESH_MS, SwapUnavailableError, swapBalances, type Balances, type SwapAsset, type SwapQuote } from "./autumn";

type Bal = Pick<Balances, "celo" | "usdt" | "gold">;

export type AmountView =
  /** Nothing typed yet. */
  | { kind: "empty" }
  | { kind: "invalid"; problem: string }
  /**
   * A valid amount. `feeToken` is the token the fee will be paid in (null before any quote); `leavesTooLittle` when
   * selling this much CELO would leave too little to start a plan.
   */
  | { kind: "ok"; amount: bigint; feeToken: "USDT" | "CELO" | null; leavesTooLittle: boolean };

/** A quote is used for the fees and Max only while it is for the same pair. */
const forPair = (quote: SwapQuote | null, from: SwapAsset, to: SwapAsset) => (quote && quote.from === from && quote.to === to ? quote : null);

/**
 * The typed amount against the balances and the latest quote's fees, parsed at the asset's decimals (a decimal comma
 * is accepted). Before any quote for this pair only the parse and the balance are checked.
 */
export function amountView(text: string, from: SwapAsset, to: SwapAsset, balances: Bal, quote: SwapQuote | null): AmountView {
  if (text.trim() === "") return { kind: "empty" };
  const parsed = parseAmountText(text, SWAP_DECIMALS[from]);
  if (!parsed.ok) return { kind: "invalid", problem: parsed.problem };
  const b = swapBalances(balances);
  const q = forPair(quote, from, to);
  if (!q) {
    if (parsed.value > swapBalanceOf(b, from)) return { kind: "invalid", problem: `That is more ${from === "XAUT0" ? "gold" : from === "USDT" ? "USD₮" : "CELO"} than the wallet holds.` };
    return { kind: "ok", amount: parsed.value, feeToken: null, leavesTooLittle: false };
  }
  const c = checkSwapAmount(from, parsed.value, b, q.fees, q.plan);
  return c.ok ? { kind: "ok", amount: parsed.value, feeToken: c.feeToken, leavesTooLittle: c.leavesTooLittle } : { kind: "invalid", problem: c.problem };
}

/** Max from the balances shown now and the latest quote's fees (and, for CELO, what a plan needs): never a stale figure. */
export function swapMaxNow(from: SwapAsset, to: SwapAsset, balances: Bal, quote: SwapQuote | null): { max: bigint; keep: SwapKeep | null } | null {
  const q = forPair(quote, from, to);
  return q ? swapMax(from, swapBalances(balances), q.fees, q.plan) : null;
}

/** The fee this conversion pays, in its token, for `amount` (or the quote's own amount). */
export function swapFeeFor(from: SwapAsset, amount: bigint, balances: Bal, quote: SwapQuote): { token: "USDT" | "CELO"; fee: bigint } | null {
  const token = swapFeeToken(from, amount, swapBalances(balances), quote.fees);
  if (!token) return null;
  const fee = token === "USDT" ? quote.fees.usdt : quote.fees.celo;
  return fee === null ? null : { token, fee };
}

/**
 * USD₮ that would be left after selling `amount` USD₮ (and paying the fee in USD₮, if it is), when that is less
 * than the running plan's next purchase needs; null when there is nothing to warn about.
 */
export function usdtShortfall(from: SwapAsset, amount: bigint, feeToken: "USDT" | "CELO" | null, fee: bigint, usdtBalance: bigint, nextPurchase: bigint | null): bigint | null {
  if (from !== "USDT" || nextPurchase === null) return null;
  const left = usdtBalance - amount - (feeToken === "USDT" ? fee : 0n);
  return left < nextPurchase ? (left > 0n ? left : 0n) : null;
}

export type QuoteView =
  /** No amount to quote. */
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; quote: SwapQuote }
  /** The quote is for this amount but older than SWAP_QUOTE_FRESH_MS. */
  | { kind: "stale"; quote: SwapQuote }
  /** A price could not be read or checked, or was refused: converting is unavailable. */
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

/**
 * The quote state for `amount` of this pair. A failed last quote (for this amount, or the stand-in before one is
 * typed) is shown as unavailable or an error whatever is typed, until a new request starts. A quote for another
 * amount or pair is never shown as this one's: that is loading until the matching answer arrives.
 */
export function quoteView(
  args: { from: SwapAsset; to: SwapAsset; amount: bigint | null; quote: SwapQuote | null; loading: boolean; error: unknown; now: number },
  errText: (e: unknown) => string,
): QuoteView {
  const { amount, quote, loading, error, now } = args;
  if (error && !loading) return error instanceof SwapUnavailableError ? { kind: "unavailable", message: error.message } : { kind: "error", message: errText(error) };
  if (amount === null) return { kind: "idle" };
  if (loading) return { kind: "loading" };
  const q = forPair(quote, args.from, args.to);
  if (!q || q.probe || q.amountIn !== amount) return { kind: "loading" };
  return now - q.observedAt.getTime() > SWAP_QUOTE_FRESH_MS ? { kind: "stale", quote: q } : { kind: "ready", quote: q };
}

/** Numbers each request so only the newest answer is used; older answers that arrive late are dropped. */
export function latestOnly() {
  let n = 0;
  return {
    next: () => ++n,
    isCurrent: (id: number) => id === n,
  };
}

/** A new pair after choosing `pick` as From (or To): the two can never be equal, so the other side moves out of the way. */
export function pickPair(side: "from" | "to", pick: SwapAsset, pair: { from: SwapAsset; to: SwapAsset }): { from: SwapAsset; to: SwapAsset } {
  if (side === "from") return { from: pick, to: pick === pair.to ? pair.from : pair.to };
  return { from: pick === pair.from ? pair.to : pair.from, to: pick };
}
