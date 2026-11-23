"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { SEND_ASSET_INFO, checkDestination, parseAmountText } from "@autumn/core";
import { CheckAgainError, sendMax, type Address, type AutumnClient, type AutumnState, type SendAsset, type SendQuote, type SendResult } from "@/lib/autumn";
import { celo, formatDateTime, formatGrams, formatUnits, shortAddress, usdt, usdtFine } from "@/lib/format";
import { errorText } from "@/lib/useAutumn";
import { Button, FailureNotice, Label, Panel, ScreenHead, Spinner, TxLink } from "../ui";
import { Icon, type IconName } from "../icons";

const ASSETS: { id: SendAsset; label: string; icon: IconName }[] = [
  { id: "USDT", label: "USD₮", icon: "note" },
  { id: "XAUT0", label: "Gold", icon: "bar" },
  { id: "CELO", label: "CELO", icon: "token" },
];

const balanceOf = (b: AutumnState["balances"], a: SendAsset) => (!b ? 0n : a === "USDT" ? b.usdt : a === "XAUT0" ? b.gold : b.celo);

/** Exact amount in the asset's own units, for inputs and the review. */
const exact = (v: bigint, a: SendAsset) => formatUnits(v, SEND_ASSET_INFO[a].decimals, SEND_ASSET_INFO[a].decimals).replace(/,/g, "");

function shown(v: bigint, a: SendAsset): string {
  if (a === "USDT") return `${usdt(v)} USD₮`;
  if (a === "CELO") return `${celo(v)} CELO`;
  return `${exact(v, a)} XAUt0 (${formatGrams(v)} g)`;
}

type Step = { kind: "form" } | { kind: "review"; to: Address; amount: bigint; quote: SendQuote } | { kind: "sending"; to: Address; amount: bigint } | { kind: "done"; to: Address; amount: bigint; result: SendResult };

export function SendOut({ client, state, onBack, goldBuyer }: { client: AutumnClient; state: AutumnState; onBack: () => void; goldBuyer?: Address }) {
  const wallet = state.wallet!.address;
  const [asset, setAsset] = useState<SendAsset>("USDT");
  const [to, setTo] = useState("");
  const [amountText, setAmountText] = useState("");
  // True while the amount is what Max filled in: Review may then lower it to the newest maximum instead of refusing.
  const usedMax = useRef(false);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [quote, setQuote] = useState<SendQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [touched, setTouched] = useState({ to: false, amount: false });
  const assetName = useId();
  const toId = useId();
  const amountId = useId();

  const balance = balanceOf(state.balances, asset);
  const dest = useMemo(() => checkDestination(to, { wallet, ...(goldBuyer ? { contracts: [goldBuyer] } : {}) }), [to, wallet, goldBuyer]);
  const parsed = parseAmountText(amountText, SEND_ASSET_INFO[asset].decimals);
  const amount = parsed.ok ? parsed.value : null;
  // From the balance shown now and the latest fee quote, on every render: never a stale figure.
  const max = quote ? sendMax(asset, balance, quote) : null;
  const amountProblem = !parsed.ok
    ? parsed.problem
    : parsed.value > balance
      ? "That is more than the wallet holds."
      : max !== null && parsed.value > max
        ? `That leaves too little for the fee. The most you can send is ${shown(max, asset)}.`
        : null;

  // The fee and the maximum, quoted for the chosen asset (nothing is signed).
  useEffect(() => {
    let alive = true;
    setQuote(null);
    setQuoteError(null);
    client
      .quoteSend({ asset })
      .then((q) => alive && setQuote(q))
      .catch((e) => alive && setQuoteError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [client, asset]);

  /** Max: a fresh fee quote, then the most the current balance allows with it. */
  const fillMax = async () => {
    setTouched((t) => ({ ...t, amount: true }));
    if (busy) return;
    setBusy(true);
    try {
      const q = await client.quoteSend({ asset });
      setQuote(q);
      setQuoteError(null);
      setAmountText(exact(sendMax(asset, balance, q), asset));
      usedMax.current = true;
    } catch (e) {
      setQuoteError(errorText(e));
      if (max !== null) {
        setAmountText(exact(max, asset));
        usedMax.current = true;
      }
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    setTouched({ to: true, amount: true });
    if (!dest.ok || amountProblem || amount === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const q = await client.quoteSend({ asset, to: dest.address, amount });
      setQuote(q); // Max and the fee line follow the newest quote
      const most = sendMax(asset, balance, q);
      let sending = amount;
      if (amount > most) {
        // The fee is quoted again here and can come back a little higher than when Max was pressed. Max means
        // "the most possible", so follow the newest maximum; an amount the owner typed is never changed.
        if (!usedMax.current || most <= 0n) throw new Error(`That leaves too little for the fee. The most you can send is ${shown(most, asset)}.`);
        sending = most;
        setAmountText(exact(most, asset));
      }
      setStep({ kind: "review", to: dest.address, amount: sending, quote: q });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (step.kind !== "review" || error instanceof CheckAgainError) return;
    const { to: dst, amount: amt } = step;
    setStep({ kind: "sending", to: dst, amount: amt });
    setError(null);
    try {
      const result = await client.send({ asset, to: dst, amount: amt });
      setStep({ kind: "done", to: dst, amount: amt, result });
    } catch (e) {
      setError(e);
      setStep({ kind: "review", to: dst, amount: amt, quote: step.quote });
    }
  };

  /** The transfer may be on its way: read its status, never send again. */
  const checkAgain = async () => {
    if (step.kind !== "review" || !(error instanceof CheckAgainError) || checking) return;
    const { to: dst, amount: amt } = step;
    setChecking(true);
    try {
      const result = await client.checkSend({ asset, to: dst, amount: amt }, error.ref);
      setError(null);
      setStep({ kind: "done", to: dst, amount: amt, result });
    } catch (e) {
      setError(e);
    } finally {
      setChecking(false);
    }
  };
  const inFlight = error instanceof CheckAgainError;

  return (
    <div className="screen send">
      <ScreenHead title="Send out" onBack={onBack} backDisabled={step.kind === "sending"} />

      {step.kind === "form" && (
        <>
          <Panel className="send__what">
            <p>
              Move USD₮, gold or CELO out of your wallet at any time, whether the agent is running or stopped. Your passkey
              approves the transfer.
            </p>
            <fieldset className="presets presets--spaced">
              <legend className="legend">
                <Icon name="send" /> What to send
              </legend>
              <div className="presets__row">
                {ASSETS.map((a) => (
                  <label key={a.id} className={`preset ${asset === a.id ? "is-on" : ""}`}>
                    <input
                      type="radio"
                      name={assetName}
                      value={a.id}
                      checked={asset === a.id}
                      onChange={() => {
                        setAsset(a.id);
                        usedMax.current = false;
                        setAmountText("");
                        setTouched((t) => ({ ...t, amount: false }));
                      }}
                    />
                    <Icon name={a.icon} className="preset__icon" />
                    <span className="preset__amount preset__amount--small">{a.label}</span>
                    <span className="preset__unit num">{a.id === "XAUT0" ? `${exact(balanceOf(state.balances, a.id), a.id)} XAUt0` : a.id === "USDT" ? usdt(balanceOf(state.balances, a.id)) : celo(balanceOf(state.balances, a.id))}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </Panel>

          <Panel title="To" icon="wallet" className="send__to">
            <div className="field">
              <label htmlFor={toId}>Celo address you control</label>
              <input
                id={toId}
                className="input num"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="0x…"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, to: true }))}
                aria-invalid={touched.to && !dest.ok}
                aria-describedby={`${toId}-help`}
              />
              {touched.to && !dest.ok && (
                <p className="error-text" role="alert">
                  {dest.problem}
                </p>
              )}
            </div>
            <p className="note" id={`${toId}-help`}>
              This must be an address on the <strong>Celo network</strong> that you control. If you send to an exchange,
              check that it accepts {SEND_ASSET_INFO[asset].symbol} deposits on Celo. Funds sent to a wrong address or
              network cannot be recovered.
            </p>
          </Panel>

          <Panel title="Amount" icon="coin" className="send__amount">
            <div className="field">
              <label htmlFor={amountId}>
                {asset === "XAUT0" ? "XAUt0 (troy ounces)" : SEND_ASSET_INFO[asset].symbol} to send (you have <span className="num">{shown(balance, asset)}</span>)
              </label>
              <div className="field__row">
                <input
                  id={amountId}
                  className="input num"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amountText}
                  onChange={(e) => {
                    usedMax.current = false;
                    setAmountText(e.target.value);
                  }}
                  onBlur={() => setTouched((t) => ({ ...t, amount: true }))}
                  aria-invalid={touched.amount && amountProblem !== null}
                />
                <Button
                  variant="plain"
                  className="btn--small"
                  disabled={busy || max === null || max === 0n}
                  onClick={() => void fillMax()}
                  aria-label={`Send the most possible, leaving room for the fee`}
                >
                  Max
                </Button>
              </div>
              {asset === "XAUT0" && amount !== null && !amountProblem && (
                <p className="muted small num">= {formatGrams(amount)} g of gold</p>
              )}
              {touched.amount && amountProblem && (
                <p className="error-text" role="alert">
                  {amountProblem}
                </p>
              )}
            </div>
            <FeeLine quote={quote} max={max} error={quoteError} asset={asset} />
          </Panel>

          <div className="send__act">
          <Button block onClick={review} disabled={busy}>
            {busy ? (
              <>
                <Spinner /> Checking the fee…
              </>
            ) : (
              "Review"
            )}
          </Button>
          <FailureNotice error={error} />
          </div>
        </>
      )}

      {(step.kind === "review" || step.kind === "sending") && (
        <Panel title="Check and send" icon="send" className="send__review">
          <dl className="facts">
            <div>
              <dt>
                <Label icon="send">Send</Label>
              </dt>
              <dd className="num">{shown(step.amount, asset)}</dd>
            </div>
            <div>
              <dt>
                <Label icon="wallet">To</Label>
              </dt>
              <dd className="num break">{step.to}</dd>
            </div>
            <div>
              <dt>
                <Label icon="globe">Network</Label>
              </dt>
              <dd>Celo</dd>
            </div>
            {step.kind === "review" && (
              <div>
                <dt>
                <Label icon="token">Fee</Label>
              </dt>
                <dd>
                  up to <span className="num">{step.quote.feeSymbol === "CELO" ? `${formatUnits(step.quote.fee, 18, 4)} CELO` : `${usdtFine(step.quote.fee)} USD₮`}</span>
                  {step.quote.registrationCelo > 0n && (
                    <>
                      , plus <span className="num">{celo(step.quote.registrationCelo)}</span> CELO for Altana&apos;s one-time registration of your
                      wallet (this is its first passkey transaction)
                    </>
                  )}
                </dd>
              </div>
            )}
          </dl>
          <p className="note">Double-check the address: a transfer cannot be undone.</p>
          {step.kind === "sending" ? (
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
              <Button onClick={confirm}>Send with passkey</Button>
              <Button variant="plain" onClick={() => setStep({ kind: "form" })}>
                Change
              </Button>
            </div>
          )}
          <FailureNotice error={error} onRetry={confirm} onCheckAgain={checking ? undefined : checkAgain} prefix="Not sent: " />
        </Panel>
      )}

      {step.kind === "done" && (
        <Panel title="Sent" icon="check" className="send__review">
          <p role="status">
            Celo confirmed the transfer of <span className="num">{shown(step.amount, asset)}</span> to{" "}
            <span className="num">{shortAddress(step.to)}</span>.{" "}
            <TxLink hash={step.result.txHash} label={`View the transfer of ${shown(step.amount, asset)} on Celoscan`} />
          </p>
          <dl className="facts">
            <div>
              <dt>
                <Label icon="note">USD₮</Label>
              </dt>
              <dd className="num">{usdt(step.result.balances.usdt)}</dd>
            </div>
            <div>
              <dt>
                <Label icon="bar">Gold</Label>
              </dt>
              <dd className="num">{formatGrams(step.result.balances.gold)} g</dd>
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

function FeeLine({ quote, max, error, asset }: { quote: SendQuote | null; max: bigint | null; error: string | null; asset: SendAsset }) {
  if (error) return <p className="muted small">The fee could not be quoted right now: {error}</p>;
  if (!quote)
    return (
      <p className="muted small waiting">
        <Spinner /> Asking the relay for the fee…
      </p>
    );
  return (
    <p className="muted small">
      Network fee: up to <span className="num">{quote.feeSymbol === "CELO" ? `${formatUnits(quote.fee, 18, 4)} CELO` : `${usdtFine(quote.fee)} USD₮`}</span>
      {quote.registrationCelo > 0n && (
        <>
          , plus <span className="num">{celo(quote.registrationCelo)}</span> CELO for Altana&apos;s one-time wallet registration
        </>
      )}
      . Max leaves room for it: <span className="num">{shown(max ?? quote.max, asset)}</span>.
    </p>
  );
}
