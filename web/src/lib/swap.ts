/**
 * What the "Convert CELO to USD₮" screen shows, as pure functions of what it
 * knows: the typed amount, the balance and the latest quote. Kept out of the
 * component so the states stay distinct and testable.
 */
import { checkSwapAmount, maxSwappable, parseAmountText } from "@autumn/core";
import { DECIMALS, SWAP_QUOTE_FRESH_MS, SwapUnavailableError, type SwapQuote } from "./autumn";

export type AmountView =
  /** Nothing typed yet. */
  | { kind: "empty" }
  | { kind: "invalid"; problem: string }
  /** A valid amount; `warning` when converting it would leave too little CELO to start a plan. */
  | { kind: "ok"; amount: bigint; warning: boolean };

/**
 * The typed amount against the balance and what the latest quote says to keep. Before any quote only the parse and
 * the balance are checked.
 */
export function amountView(text: string, celoBalance: bigint, quote: Pick<SwapQuote, "keep"> | null): AmountView {
  if (text.trim() === "") return { kind: "empty" };
  const parsed = parseAmountText(text, DECIMALS.CELO);
  if (!parsed.ok) return { kind: "invalid", problem: parsed.problem };
  if (parsed.value > celoBalance) return { kind: "invalid", problem: "That is more CELO than the wallet holds." };
  if (!quote) return { kind: "ok", amount: parsed.value, warning: false };
  const c = checkSwapAmount(parsed.value, celoBalance, quote.keep);
  return c.ok ? { kind: "ok", amount: parsed.value, warning: c.leavesTooLittle } : { kind: "invalid", problem: c.problem };
}

/** Max from the balance shown now and the latest quote: never a stale figure. */
export const swapMaxNow = (celoBalance: bigint, quote: Pick<SwapQuote, "keep"> | null) => (quote ? maxSwappable(celoBalance, quote.keep) : null);

export type QuoteView =
  /** No amount to quote. */
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; quote: SwapQuote }
  /** The quote is for this amount but older than SWAP_QUOTE_FRESH_MS. */
  | { kind: "stale"; quote: SwapQuote }
  /** The reference rate or the quote could not be read, or the price was refused: converting is unavailable. */
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

/**
 * The quote state for `amount`. A failed last quote (for this amount, or the stand-in before one is typed) is shown
 * as unavailable or an error whatever is typed, until a new request starts. A quote for another amount (the owner
 * kept typing) is never shown as this amount's: that is loading until the matching answer arrives.
 */
export function quoteView(args: { amount: bigint | null; quote: SwapQuote | null; loading: boolean; error: unknown; now: number }, errText: (e: unknown) => string): QuoteView {
  const { amount, quote, loading, error, now } = args;
  if (error && !loading) return error instanceof SwapUnavailableError ? { kind: "unavailable", message: error.message } : { kind: "error", message: errText(error) };
  if (amount === null) return { kind: "idle" };
  if (loading) return { kind: "loading" };
  if (!quote || quote.probe || quote.amountIn !== amount) return { kind: "loading" };
  return now - quote.observedAt.getTime() > SWAP_QUOTE_FRESH_MS ? { kind: "stale", quote } : { kind: "ready", quote };
}

/** Numbers each request so only the newest answer is used; older answers that arrive late are dropped. */
export function latestOnly() {
  let n = 0;
  return {
    next: () => ++n,
    isCurrent: (id: number) => id === n,
  };
}
