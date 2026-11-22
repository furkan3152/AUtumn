"use client";

import { useEffect, useId, useRef, useState } from "react";
import { SWAP_ASSETS, SWAP_DECIMALS } from "@autumn/core";
import {
  CheckAgainError,
  PasskeyError,
  SWAP_ASSET_LABEL,
  SWAP_QUOTE_FRESH_MS,
  swapRouteText,
  usdtForNextPurchase,
  type AutumnClient,
  type AutumnState,
  type SwapAsset,
  type SwapQuote,
  type SwapResult,
} from "@/lib/autumn";
import { celo, formatDateTime, formatGrams, formatUnits, perGram, usdt, usdtFine } from "@/lib/format";
import { amountView, latestOnly, pickPair, quoteView, swapFeeFor, swapMaxNow, usdtShortfall, type QuoteView } from "@/lib/swap";
import { errorText } from "@/lib/useAutumn";
import { Button, FailureNotice, Label, Panel, ScreenHead, Spinner, TxLink } from "../ui";
import { Icon, type IconName } from "../icons";

const ICON: Record<SwapAsset, IconName> = { CELO: "token", USDT: "note", XAUT0: "bar" };
const NAME: Record<SwapAsset, string> = { CELO: "CELO", USDT: "USD₮", XAUT0: "gold" };

/** Every decimal, for the input. */
const exact = (v: bigint, a: SwapAsset) => formatUnits(v, SWAP_DECIMALS[a], SWAP_DECIMALS[a]).replace(/,/g, "");
/** An amount with its unit; gold as XAUt0 with grams, as the rest of the app shows it. */
function shown(v: bigint, a: SwapAsset): string {
  if (a === "USDT") return `${usdtFine(v)} USD₮`;
  if (a === "CELO") return `${formatUnits(v, 18, 4)} CELO`;
  return `${exact(v, a)} XAUt0 (${formatGrams(v)} g)`;
}
/** A balance, short. */
function brief(v: bigint, a: SwapAsset): string {
  if (a === "USDT") return usdt(v);
  if (a === "CELO") return celo(v);
  return `${formatGrams(v)} g`;
}
const feeText = (f: { token: "USDT" | "CELO"; fee: bigint }) => (f.token === "CELO" ? `${formatUnits(f.fee, 18, 4)} CELO` : `${usdtFine(f.fee)} USD₮`);

/** The effective gold price of a trade, in the other asset per gram (as Home shows the gold price). Null without gold. */
function goldPrice(from: SwapAsset, to: SwapAsset, amountIn: bigint, out: bigint): string | null {
  if (from !== "XAUT0" && to !== "XAUT0") return null;
  const [goldUnits, other, otherAsset] = from === "XAUT0" ? [amountIn, out, to] : [out, amountIn, from];
  if (goldUnits <= 0n) return null;
  const perGramV = perGram((other * 1_000_000n) / goldUnits);
  return otherAsset === "USDT" ? `${usdt(perGramV)} USD₮ per gram` : `${formatUnits(perGramV, 18, 2)} CELO per gram`;
}

/** Quotes are re-read this long after the owner stops typing. */
const QUOTE_DEBOUNCE_MS = 500;

type Pair = { from: SwapAsset; to: SwapAsset };
type Step =
  | { kind: "form" }
  | { kind: "review"; quote: SwapQuote }
  | { kind: "converting"; quote: SwapQuote }
  | { kind: "done"; quote: SwapQuote; result: SwapResult };

export function Convert({ client, state, onBack, initial = { from: "CELO", to: "USDT" } }: { client: AutumnClient; state: AutumnState; onBack: () => void; initial?: Pair }) {
  const balances = state.balances ?? { celo: 0n, usdt: 0n, gold: 0n };
  const balanceOf = (a: SwapAsset) => (a === "CELO" ? balances.celo : a === "USDT" ? balances.usdt : balances.gold);
  const [pair, setPair] = useState<Pair>(initial);
  const { from, to } = pair;
  const [amountText, setAmountText] = useState("");
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "form" });
  /** The newest answer from quoteSwap (for the typed amount, or a stand-in amount for the fees and Max). */
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
  const fromName = useId();
  const toName = useId();

  const view = amountView(amountText, from, to, balances, quote);
  const amount = view.kind === "ok" ? view.amount : null;
  const maxNow = swapMaxNow(from, to, balances, quote);
  const qv = quoteView({ from, to, amount, quote, loading: quoteLoading, error: quoteError, now }, errorText);
  const nextPurchase = usdtForNextPurchase(state);

  const requestQuote = (p: Pair, amt?: bigint) => {
    const id = latest.current.next();
    setQuoteLoading(true);
    setQuoteError(null);
    client
      .quoteSwap({ from: p.from, to: p.to, ...(amt !== undefined ? { amount: amt } : {}) })
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

  // The fees and Max for this pair before an amount is typed.
  useEffect(() => {
    if (step.kind === "form") requestQuote(pair);
  }, [client, pair.from, pair.to]);

  // The quote for the typed amount, once typing pauses. Stale answers are dropped by `latest`.
  const amountKey = amount?.toString() ?? null;
  useEffect(() => {
    if (amountKey === null || step.kind !== "form") return;
    const t = setTimeout(() => requestQuote(pair, BigInt(amountKey)), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [amountKey, step.kind, pair.from, pair.to]);

  // A clock for "this quote is old".
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const choose = (side: "from" | "to", a: SwapAsset) => {
    const next = pickPair(side, a, pair);
    if (next.from === from && next.to === to) return;
    if (next.from !== from) setAmountText("");
    setTouched(false);
    setError(null);
    setPair(next);
  };
  const flip = () => {
    setAmountText("");
    setTouched(false);
    setError(null);
    setPair({ from: to, to: from });
  };

  const fillMax = () => {
    setTouched(true);
    if (maxNow && maxNow.max > 0n) setAmountText(exact(maxNow.max, from));
  };

  /** A fresh quote for the exact amount, then the review. */
  const review = async () => {
    setTouched(true);
    if (amount === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const q = await client.quoteSwap({ from, to, amount });
      latest.current.next(); // any quote still on its way is older than this one
      setQuote(q);
      setQuoteError(null);
      setQuoteLoading(false);
      const again = amountView(amountText, from, to, balances, q);
      if (again.kind === "invalid") throw new Error(again.problem);
      setNow(Date.now());
      setStep({ kind: "review", quote: q });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const requestFor = (q: SwapQuote) => {
    const f = swapFeeFor(q.from, q.amountIn, balances, q);
    if (!f) throw new Error("The network fee could not be quoted.");
    return { from: q.from, to: q.to, amountIn: q.amountIn, minOut: q.minOut, feeSymbol: f.token === "CELO" ? ("CELO" as const) : ("USD₮" as const) };
  };

  const confirm = async () => {
    if (step.kind !== "review" || converting.current || error instanceof CheckAgainError) return;
    if (Date.now() - step.quote.observedAt.getTime() > SWAP_QUOTE_FRESH_MS) return;
    converting.current = true;
    const q = step.quote;
    setStep({ kind: "converting", quote: q });
    setError(null);
    try {
      const result = await client.swap(requestFor(q));
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
      const result = await client.checkSwap(requestFor(q), error.ref);
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
  const fee = amount !== null && quote && quote.from === from && quote.to === to ? swapFeeFor(from, amount, balances, quote) : null;
  const shortfall = amount !== null ? usdtShortfall(from, amount, fee?.token ?? null, fee?.fee ?? 0n, balances.usdt, nextPurchase) : null;

  const Picker = ({ side }: { side: "from" | "to" }) => (
    <fieldset className="presets presets--spaced">
      <legend className="legend">
        <Icon name={side === "from" ? "send" : "coin"} /> {side === "from" ? "From" : "To"}
      </legend>
      <div className="presets__row">
        {SWAP_ASSETS.map((a) => {
          const on = (side === "from" ? from : to) === a;
          return (
            <label key={a} className={`preset ${on ? "is-on" : ""}`}>
              <input type="radio" name={side === "from" ? fromName : toName} value={a} checked={on} onChange={() => choose(side, a)} />
              <Icon name={ICON[a]} className="preset__icon" />
              <span className="preset__amount preset__amount--small">{SWAP_ASSET_LABEL[a]}</span>
              <span className="preset__unit num">{brief(balanceOf(a), a)}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );

  return (
    <div className="screen send">
      <ScreenHead title="Convert" onBack={onBack} backDisabled={step.kind === "converting"} />

      {step.kind === "form" && (
        <>
          <Panel className="send__what">
            <p>Swap between CELO, USD₮ and gold in your wallet. Your passkey approves it.</p>
            {Picker({ side: "from" })}
            <div className="convert__flip">
              <Button variant="plain" className="btn--small" onClick={flip} aria-label={`Switch: convert ${NAME[to]} to ${NAME[from]}`}>
                ⇅ Switch
              </Button>
            </div>
            {Picker({ side: "to" })}
            <p className="muted small">{swapRouteText(from, to)}</p>
          </Panel>

          <Panel title="Amount" icon="coin" className="send__amount">
            <div className="field">
              <label htmlFor={amountId}>
                {from === "XAUT0" ? "XAUt0 (troy ounces)" : NAME[from]} to convert (you have <span className="num">{shown(balanceOf(from), from)}</span>)
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
                  disabled={!maxNow || maxNow.max === 0n}
                  onClick={fillMax}
                  aria-label={from === "CELO" ? "Max: convert the most possible, keeping the CELO a plan needs" : "Max: convert the most possible, leaving the network fee"}
                >
                  Max
                </Button>
              </div>
              {from === "XAUT0" && amount !== null && <p className="muted small num">= {formatGrams(amount)} g of gold</p>}
              {touched && view.kind === "invalid" && (
                <p className="error-text" role="alert">
                  {view.problem}
                </p>
              )}
              {view.kind === "ok" && view.leavesTooLittle && maxNow?.keep && (
                <p className="note" role="status">
                  Not enough CELO would remain to start a plan: a plan needs about <span className="num">{celo(maxNow.keep.nextPlan)}</span> CELO for
                  Altana&apos;s registration. You can still convert this amount.
                </p>
              )}
              {view.kind === "ok" && shortfall !== null && nextPurchase !== null && (
                <p className="note" role="status">
                  Your plan&apos;s next purchase needs <span className="num">{usdt(nextPurchase)}</span> USD₮; after this the wallet would hold{" "}
                  <span className="num">{usdt(shortfall)}</span>. The agent skips a purchase when the balance runs short. You can still convert this amount.
                </p>
              )}
            </div>
            <QuoteLine view={qv} onRetry={() => requestQuote(pair, amount ?? undefined)} />
            <FeeLine id={`${amountId}-keep`} from={from} quote={quote && quote.from === from && quote.to === to ? quote : null} maxNow={maxNow} fee={fee} balances={balances} loading={quoteLoading && !maxNow} hidden={qv.kind === "unavailable" || qv.kind === "error"} />
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
          <ReviewFacts quote={step.quote} fee={swapFeeFor(step.quote.from, step.quote.amountIn, balances, step.quote)} />
          <p className="note">
            {swapRouteText(step.quote.from, step.quote.to)} If the swap would give less than the minimum when Celo runs it, nothing is converted.
            {step.quote.to === "XAUT0" && " This is your own purchase, approved with your passkey: it is not one of the agent's purchases and does not use the agent's limit."}
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
            Celo confirmed the swap of <span className="num">{shown(step.quote.amountIn, step.quote.from)}</span> for{" "}
            <span className="num">{shown(step.result.received, step.quote.to)}</span>.{" "}
            <TxLink hash={step.result.txHash} label={`View the swap of ${shown(step.quote.amountIn, step.quote.from)} on Celoscan`} />
          </p>
          {step.result.allowanceLeft > 0n && (
            <p className="error-text" role="alert">
              Uniswap&apos;s router can still take <span className="num">{shown(step.result.allowanceLeft, step.quote.from)}</span> from this wallet. This should
              not happen; send your funds out if you are unsure.
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
            <div>
              <dt>
                <Label icon="bar">Gold</Label>
              </dt>
              <dd className="num">{formatGrams(step.result.balances.gold)} g</dd>
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
    case "stale": {
      const q = view.quote;
      const price = goldPrice(q.from, q.to, q.amountIn, q.expectedOut);
      return (
        <p role="status">
          You get about <strong className="num">{shown(q.expectedOut, q.to)}</strong>, at least <span className="num">{shown(q.minOut, q.to)}</span>
          {q.viaUsdt ? ", via USD₮" : ""}.{price ? <> Price: <span className="num">{price}</span>.</> : null}
          {view.kind === "stale" ? " This quote is more than a minute old." : ""}
        </p>
      );
    }
  }
}

function FeeLine({
  id,
  from,
  quote,
  maxNow,
  fee,
  balances,
  loading,
  hidden,
}: {
  id: string;
  from: SwapAsset;
  quote: SwapQuote | null;
  maxNow: ReturnType<typeof swapMaxNow>;
  fee: ReturnType<typeof swapFeeFor>;
  balances: { celo: bigint; usdt: bigint; gold: bigint };
  loading: boolean;
  hidden: boolean;
}) {
  if (hidden) return null; // the quote line says why
  if (!quote || !maxNow)
    return loading ? (
      <p className="muted small waiting" id={id}>
        <Spinner /> Asking the relay for the fee…
      </p>
    ) : null;
  const f = fee ?? swapFeeFor(from, quote.amountIn, balances, quote);
  const k = maxNow.keep;
  return (
    <p className="muted small" id={id}>
      {f ? (
        <>
          Network fee: up to <span className="num">{feeText(f)}</span>
        </>
      ) : (
        <>The network fee could not be quoted</>
      )}
      {quote.fees.registration > 0n && (
        <>
          , plus <span className="num">{celo(quote.fees.registration)}</span> CELO for Altana&apos;s one-time registration of your wallet
        </>
      )}
      .{" "}
      {k ? (
        <>
          Max keeps <span className="num">{celo(k.total)}</span> CELO: <span className="num">{celo(k.nextPlan)}</span> for Altana&apos;s registration when you
          start a plan, <span className="num">{celo(k.buffer)}</span> spare because that fee moves with CELO&apos;s price
          {k.thisTransaction > 0n && (
            <>
              , and <span className="num">{celo(k.thisTransaction)}</span> for this conversion
            </>
          )}
          .{" "}
        </>
      ) : from === "USDT" && quote.fees.usdt !== null ? (
        <>Max leaves the fee in USD₮. </>
      ) : null}
      Max: <span className="num">{shown(maxNow.max, from)}</span>.
    </p>
  );
}

function ReviewFacts({ quote, fee }: { quote: SwapQuote; fee: ReturnType<typeof swapFeeFor> }) {
  const price = goldPrice(quote.from, quote.to, quote.amountIn, quote.expectedOut);
  return (
    <dl className="facts">
      <div>
        <dt>
          <Label icon={ICON[quote.from]}>Convert</Label>
        </dt>
        <dd className="num">{shown(quote.amountIn, quote.from)}</dd>
      </div>
      <div>
        <dt>
          <Label icon={ICON[quote.to]}>You get about</Label>
        </dt>
        <dd className="num">{shown(quote.expectedOut, quote.to)}</dd>
      </div>
      <div>
        <dt>
          <Label icon="shield">At least</Label>
        </dt>
        <dd className="num">{shown(quote.minOut, quote.to)}</dd>
      </div>
      {price && (
        <div>
          <dt>
            <Label icon="bar">Price</Label>
          </dt>
          <dd className="num">{price}</dd>
        </div>
      )}
      <div>
        <dt>
          <Label icon="globe">Route</Label>
        </dt>
        <dd>{quote.viaUsdt ? "Via USD₮, two pools" : "One pool"}</dd>
      </div>
      <div>
        <dt>
          <Label icon="coin">Pool fee</Label>
        </dt>
        <dd className="num">{quote.poolFees}</dd>
      </div>
      <div>
        <dt>
          <Label icon="seal">Network fee</Label>
        </dt>
        <dd>
          {fee ? (
            <>
              up to <span className="num">{feeText(fee)}</span>
            </>
          ) : (
            "could not be quoted"
          )}
          {quote.fees.registration > 0n && (
            <>
              , plus <span className="num">{celo(quote.fees.registration)}</span> CELO for Altana&apos;s one-time registration of your wallet (this is its
              first passkey transaction)
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}
