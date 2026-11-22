"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { SEND_ASSET_INFO, checkDestination, parseAmount } from "@autumn/core";
import { type Address, type AutumnClient, type AutumnState, type SendAsset, type SendQuote, type SendResult } from "@/lib/autumn";
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
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [quote, setQuote] = useState<SendQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState({ to: false, amount: false });
  const assetName = useId();
  const toId = useId();
  const amountId = useId();

  const balance = balanceOf(state.balances, asset);
  const dest = useMemo(() => checkDestination(to, { wallet, ...(goldBuyer ? { contracts: [goldBuyer] } : {}) }), [to, wallet, goldBuyer]);
  const amount = parseAmount(amountText, SEND_ASSET_INFO[asset].decimals);
  const max = quote?.max ?? null;
  const amountProblem =
    amountText.trim() === ""
      ? "Enter an amount."
      : amount === null
        ? `Enter a positive amount with at most ${SEND_ASSET_INFO[asset].decimals} decimals.`
        : amount > balance
          ? "That is more than the wallet holds."
          : max !== null && amount > max
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

  const review = async () => {
    setTouched({ to: true, amount: true });
    if (!dest.ok || amountProblem || amount === null) return;
    setBusy(true);
    setError(null);
    try {
      const q = await client.quoteSend({ asset, to: dest.address, amount });
      if (amount > q.max) throw new Error(`That leaves too little for the fee. The most you can send is ${shown(q.max, asset)}.`);
      setStep({ kind: "review", to: dest.address, amount, quote: q });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (step.kind !== "review") return;
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
                        setAmountText("");
                        setTouched((t) => ({ ...t, amount: false }));
                      }}
                    />
                    <Icon name={a.icon} className="preset__icon" />
                    <span className="preset__amount preset__amount--small">{a.label}</span>
                    <span className="preset__unit num">{a.id === "XAUT0" ? `${formatGrams(balanceOf(state.balances, a.id))} g` : a.id === "USDT" ? usdt(balanceOf(state.balances, a.id)) : celo(balanceOf(state.balances, a.id))}</span>
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
                {SEND_ASSET_INFO[asset].symbol} to send (you have <span className="num">{shown(balance, asset)}</span>)
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
                  onBlur={() => setTouched((t) => ({ ...t, amount: true }))}
                  aria-invalid={touched.amount && amountProblem !== null}
                />
                <Button
                  variant="plain"
                  className="btn--small"
                  disabled={max === null || max === 0n}
                  onClick={() => {
                    if (max !== null) setAmountText(exact(max, asset));
                    setTouched((t) => ({ ...t, amount: true }));
                  }}
                  aria-label={`Send the most possible, leaving room for the fee`}
                >
                  Max
                </Button>
              </div>
              {touched.amount && amountProblem && (
                <p className="error-text" role="alert">
                  {amountProblem}
                </p>
              )}
            </div>
            <FeeLine quote={quote} error={quoteError} asset={asset} />
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
          ) : (
            <div className="row">
              <Button onClick={confirm}>Send with passkey</Button>
              <Button variant="plain" onClick={() => setStep({ kind: "form" })}>
                Change
              </Button>
            </div>
          )}
          <FailureNotice
            error={error}
            onRetry={(error as { name?: string } | null)?.name === "SendSubmittedError" ? undefined : confirm}
            prefix={(error as { name?: string } | null)?.name === "SendSubmittedError" ? "" : "Not sent: "}
          />
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

function FeeLine({ quote, error, asset }: { quote: SendQuote | null; error: string | null; asset: SendAsset }) {
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
      . Max leaves room for it: <span className="num">{shown(quote.max, asset)}</span>.
    </p>
  );
}
