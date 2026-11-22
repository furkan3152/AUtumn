"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckAgainError, DECIMALS, PasskeyError, SWAP_QUOTE_FRESH_MS, SWAP_ROUTE_TEXT, type AutumnClient, type AutumnState, type SwapQuote, type SwapResult } from "@/lib/autumn";
import { celo, formatDateTime, formatUnits, usdt, usdtFine } from "@/lib/format";
import { amountView, latestOnly, quoteView, swapMaxNow, type QuoteView } from "@/lib/swap";
import { errorText } from "@/lib/useAutumn";
import { Button, FailureNotice, Label, Panel, ScreenHead, Spinner, TxLink } from "../ui";

/** CELO with every decimal, for the input. */
const exactCelo = (v: bigint) => formatUnits(v, DECIMALS.CELO, DECIMALS.CELO).replace(/,/g, "");
/** CELO with up to 4 decimals, for small amounts such as fees. */
const celoFine = (v: bigint) => formatUnits(v, DECIMALS.CELO, 4);
const feeText = (q: Pick<SwapQuote, "fee" | "feeSymbol">) => (q.feeSymbol === "CELO" ? `${celoFine(q.fee)} CELO` : `${usdtFine(q.fee)} USD₮`);

/** Quotes are re-read this long after the owner stops typing. */
const QUOTE_DEBOUNCE_MS = 500;

type Step =
  | { kind: "form" }
  | { kind: "review"; quote: SwapQuote }
  | { kind: "converting"; quote: SwapQuote }
  | { kind: "done"; quote: SwapQuote; result: SwapResult };

export function ConvertCelo({ client, state, onBack }: { client: AutumnClient; state: AutumnState; onBack: () => void }) {
  const balance = state.balances?.celo ?? 0n;
  const [amountText, setAmountText] = useState("");
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "form" });
  /** The newest answer from quoteSwap (for the typed amount, or a stand-in amount for the fee and Max). */
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const latest = useRef(latestOnly());
  const converting = useRef(false);
  const amountId = useId();

  const view = amountView(amountText, balance, quote);
  const amount = view.kind === "ok" ? view.amount : null;
  const max = swapMaxNow(balance, quote);
  const qv = quoteView({ amount, quote, loading: quoteLoading, error: quoteError, now }, errorText);

  const requestQuote = (amt?: bigint) => {
    const id = latest.current.next();
    setQuoteLoading(true);
    setQuoteError(null);
    client
      .quoteSwap(amt !== undefined ? { amount: amt } : {})
      .then((q) => {
        if (!latest.current.isCurrent(id)) return; // a newer request was made: this answer is stale
        setQuote(q);
        setQuoteLoading(false);
      })
      .catch((e) => {
        if (!latest.current.isCurrent(id)) return;
        setQuoteError(e);
        setQuoteLoading(false);
      });
  };

  // The fee and Max before an amount is typed.
  useEffect(() => {
    requestQuote();
  }, [client]);

  // The quote for the typed amount, once typing pauses. Stale answers are dropped by `latest`.
  const amountKey = amount?.toString() ?? null;
  useEffect(() => {
    if (amountKey === null || step.kind !== "form") return;
    const t = setTimeout(() => requestQuote(BigInt(amountKey)), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [amountKey, step.kind]);

  // A clock for "this quote is old".
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const fillMax = () => {
    setTouched(true);
    if (max !== null && max > 0n) setAmountText(exactCelo(max));
  };

  /** A fresh quote for the exact amount, then the review. */
  const review = async () => {
    setTouched(true);
    if (amount === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const q = await client.quoteSwap({ amount });
      latest.current.next(); // any quote still on its way is older than this one
      setQuote(q);
      setQuoteError(null);
      setQuoteLoading(false);
      const again = amountView(amountText, balance, q);
      if (again.kind === "invalid") throw new Error(again.problem);
      setNow(Date.now());
      setStep({ kind: "review", quote: q });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (step.kind !== "review" || converting.current || error instanceof CheckAgainError) return;
    if (Date.now() - step.quote.observedAt.getTime() > SWAP_QUOTE_FRESH_MS) return;
    converting.current = true;
    const q = step.quote;
    setStep({ kind: "converting", quote: q });
    setError(null);
    try {
      const result = await client.swap({ amountIn: q.amountIn, minOut: q.minOut, feeSymbol: q.feeSymbol });
      setStep({ kind: "done", quote: q, result });
    } catch (e) {
      setError(e);
      setStep({ kind: "review", quote: q });
    } finally {
      converting.current = false;
    }
  };

  /** The conversion may be on its way: read its status, never convert again. */
  const checkAgain = async () => {
    if (step.kind !== "review" || !(error instanceof CheckAgainError) || checking) return;
    const q = step.quote;
    setChecking(true);
    try {
      const result = await client.checkSwap({ amountIn: q.amountIn, minOut: q.minOut, feeSymbol: q.feeSymbol }, error.ref);
      setError(null);
      setStep({ kind: "done", quote: q, result });
    } catch (e) {
      setError(e);
    } finally {
      setChecking(false);
    }
  };

  const inFlight = error instanceof CheckAgainError;
  const reviewStale = step.kind === "review" && now - step.quote.observedAt.getTime() > SWAP_QUOTE_FRESH_MS;
  /** After a refusal (price moved, relay error) the next step is a new quote, not the same signature again. */
  const needsNewQuote = step.kind === "review" && (reviewStale || (error !== null && !inFlight && !(error instanceof PasskeyError)));

  return (
    <div className="screen send">
      <ScreenHead title="Convert CELO to USD₮" onBack={onBack} backDisabled={step.kind === "converting"} />

      {step.kind === "form" && (
        <>
          <Panel className="send__what">
            <p>
              Swap part of your wallet&apos;s CELO for USD₮, so you can start a plan. Your passkey approves it. {SWAP_ROUTE_TEXT}
            </p>
            <dl className="facts">
              <div>
                <dt>
                  <Label icon="token">CELO</Label>
                </dt>
                <dd className="num">{state.balances ? celo(state.balances.celo) : "Unknown"}</dd>
              </div>
              <div>
                <dt>
                  <Label icon="note">USD₮</Label>
                </dt>
                <dd className="num">{state.balances ? usdt(state.balances.usdt) : "Unknown"}</dd>
              </div>
            </dl>
          </Panel>

          <Panel title="Amount" icon="coin" className="send__amount">
            <div className="field">
              <label htmlFor={amountId}>
                CELO to convert (you have <span className="num">{celo(balance)} CELO</span>)
              </label>
              <div className="field__row">
                <input
                  id={amountId}
                  className="input num"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-invalid={touched && view.kind === "invalid"}
                  aria-describedby={`${amountId}-keep`}
                />
                <Button
                  variant="plain"
                  className="btn--small"
                  disabled={max === null || max === 0n}
                  onClick={fillMax}
                  aria-label="Max: convert the most possible, keeping the CELO a plan needs"
                >
                  Max
                </Button>
              </div>
              {touched && view.kind === "invalid" && (
                <p className="error-text" role="alert">
                  {view.problem}
                </p>
              )}
              {view.kind === "ok" && view.warning && quote && (
                <p className="note" role="status">
                  Not enough CELO would remain to start a plan: a plan needs about <span className="num">{celo(quote.keep.nextPlan)}</span> CELO for
                  Altana&apos;s registration. You can still convert this amount.
                </p>
              )}
            </div>
            <QuoteLine view={qv} onRetry={() => requestQuote(amount ?? undefined)} />
            <KeepLine id={`${amountId}-keep`} quote={quote} max={max} loading={quoteLoading && !quote} hidden={qv.kind === "unavailable" || qv.kind === "error"} />
          </Panel>

          <div className="send__act">
            <Button block onClick={review} disabled={busy || amount === null || qv.kind === "unavailable"}>
              {busy ? (
                <>
                  <Spinner /> Getting a quote…
                </>
              ) : (
                "Review"
              )}
            </Button>
            <FailureNotice error={error} />
          </div>
        </>
      )}

      {(step.kind === "review" || step.kind === "converting") && (
        <Panel title="Check and convert" icon="token" className="send__review">
          <ReviewFacts quote={step.quote} />
          <p className="note">
            {SWAP_ROUTE_TEXT} If the pool gives less than the minimum when Celo runs the swap, nothing is converted.
          </p>
          {reviewStale && step.kind === "review" && !inFlight && (
            <p className="note" role="status">
              This quote is more than a minute old. Get a new quote before converting.
            </p>
          )}
          {step.kind === "converting" ? (
            <p className="waiting" role="status">
              <Spinner /> Approve with your passkey, then Autumn waits for Celo to confirm…
            </p>
          ) : inFlight ? (
            <div className="row">
              {checking && (
                <p className="waiting" role="status">
                  <Spinner /> Checking Celo…
                </p>
              )}
              <Button variant="plain" onClick={onBack} disabled={checking}>
                Back to the wallet
              </Button>
            </div>
          ) : (
            <div className="row">
              {needsNewQuote ? (
                <Button onClick={review} disabled={busy}>
                  {busy ? (
                    <>
                      <Spinner /> Getting a quote…
                    </>
                  ) : (
                    "Get a new quote"
                  )}
                </Button>
              ) : (
                <Button onClick={confirm}>Convert with passkey</Button>
              )}
              <Button
                variant="plain"
                onClick={() => {
                  setError(null);
                  setStep({ kind: "form" });
                }}
              >
                Change
              </Button>
            </div>
          )}
          <FailureNotice error={error} onRetry={confirm} onCheckAgain={checking ? undefined : checkAgain} prefix="Not converted: " />
        </Panel>
      )}

      {step.kind === "done" && (
        <Panel title="Converted" icon="check" className="send__review">
          <p role="status">
            Celo confirmed the swap of <span className="num">{celoFine(step.quote.amountIn)}</span> CELO for{" "}
            <span className="num">{usdtFine(step.result.received)}</span> USD₮.{" "}
            <TxLink hash={step.result.txHash} label={`View the swap of ${celo(step.quote.amountIn)} CELO on Celoscan`} />
          </p>
          {step.result.allowanceLeft > 0n && (
            <p className="error-text" role="alert">
              Uniswap&apos;s router can still take <span className="num">{celoFine(step.result.allowanceLeft)}</span> CELO from this wallet. This
              should not happen; send your funds out if you are unsure.
            </p>
          )}
          <dl className="facts">
            <div>
              <dt>
                <Label icon="note">USD₮</Label>
              </dt>
              <dd className="num">{usdt(step.result.balances.usdt)}</dd>
            </div>
            <div>
              <dt>
                <Label icon="token">CELO</Label>
              </dt>
              <dd className="num">{celo(step.result.balances.celo)}</dd>
            </div>
          </dl>
          <p className="muted small">
            Balances read from Celo <span className="num">{formatDateTime(step.result.balances.observedAt)}</span>
          </p>
          <Button onClick={onBack}>Done</Button>
        </Panel>
      )}
    </div>
  );
}

function QuoteLine({ view, onRetry }: { view: QuoteView; onRetry: () => void }) {
  switch (view.kind) {
    case "idle":
      return <p className="muted small">Enter an amount to see the quote.</p>;
    case "loading":
      return (
        <p className="muted small waiting" role="status">
          <Spinner /> Getting a quote from the pool…
        </p>
      );
    case "unavailable":
    case "error":
      return (
        <div className="row">
          <p className="error-text" role="alert">
            {view.kind === "error" ? `The quote could not be read: ${view.message}` : view.message}
          </p>
          <Button variant="plain" className="btn--small" onClick={onRetry}>
            Try again
          </Button>
        </div>
      );
    case "ready":
    case "stale":
      return (
        <p role="status">
          You get about <strong className="num">{usdtFine(view.quote.expectedOut)} USD₮</strong>, at least{" "}
          <span className="num">{usdtFine(view.quote.minOut)}</span>.{view.kind === "stale" ? " This quote is more than a minute old." : ""}
        </p>
      );
  }
}

function KeepLine({ id, quote, max, loading, hidden }: { id: string; quote: SwapQuote | null; max: bigint | null; loading: boolean; hidden: boolean }) {
  if (hidden) return null; // the quote line says why
  if (!quote)
    return loading ? (
      <p className="muted small waiting" id={id}>
        <Spinner /> Asking the relay for the fee…
      </p>
    ) : null;
  const k = quote.keep;
  return (
    <p className="muted small" id={id}>
      Network fee: up to <span className="num">{feeText(quote)}</span>
      {quote.registrationCelo > 0n && (
        <>
          , plus <span className="num">{celo(quote.registrationCelo)}</span> CELO for Altana&apos;s one-time registration of your wallet
        </>
      )}
      . Max keeps <span className="num">{celo(k.total)}</span> CELO: <span className="num">{celo(k.nextPlan)}</span> for Altana&apos;s registration
      when you start a plan, <span className="num">{celo(k.buffer)}</span> spare because that fee moves with CELO&apos;s price
      {k.thisTransaction > 0n && (
        <>
          , and <span className="num">{celo(k.thisTransaction)}</span> for this conversion
        </>
      )}
      . Max: <span className="num">{celo(max ?? 0n)} CELO</span>.
    </p>
  );
}

function ReviewFacts({ quote }: { quote: SwapQuote }) {
  return (
    <dl className="facts">
      <div>
        <dt>
          <Label icon="token">Convert</Label>
        </dt>
        <dd className="num">{celoFine(quote.amountIn)} CELO</dd>
      </div>
      <div>
        <dt>
          <Label icon="note">You get about</Label>
        </dt>
        <dd className="num">{usdtFine(quote.expectedOut)} USD₮</dd>
      </div>
      <div>
        <dt>
          <Label icon="shield">At least</Label>
        </dt>
        <dd className="num">{usdtFine(quote.minOut)} USD₮</dd>
      </div>
      <div>
        <dt>
          <Label icon="coin">Pool fee</Label>
        </dt>
        <dd className="num">0.01%</dd>
      </div>
      <div>
        <dt>
          <Label icon="seal">Network fee</Label>
        </dt>
        <dd>
          up to <span className="num">{feeText(quote)}</span>
          {quote.registrationCelo > 0n && (
            <>
              , plus <span className="num">{celo(quote.registrationCelo)}</span> CELO for Altana&apos;s one-time registration of your wallet (this is
              its first passkey transaction)
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}
