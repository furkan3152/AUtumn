"use client";

import { useId, useMemo, useState } from "react";
import {
  DECIMALS,
  DIP_PERCENT,
  PLAN_DURATION_WEEKS,
  PLAN_PRESETS_USDT,
  draftLimits,
  type PlanPeriod,
  type AutumnClient,
  type AutumnState,
} from "@/lib/autumn";
import { celo, formatDate, usdt } from "@/lib/format";
import { errorText } from "@/lib/useAutumn";
import { Button, Panel, Spinner } from "../ui";

const UNIT = 10n ** BigInt(DECIMALS.USDT);

export function PlanPicker({
  client,
  state,
  onDone,
  onBack,
}: {
  client: AutumnClient;
  state: AutumnState;
  onDone: () => void;
  onBack?: () => void;
}) {
  const [amount, setAmount] = useState<number>(5);
  const [period, setPeriod] = useState<PlanPeriod>("week");
  const [dip, setDip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  const freqName = useId();

  const each = BigInt(amount) * UNIT;
  const daily = period === "day";
  const per = daily ? "day" : "week";
  const limits = useMemo(() => draftLimits({ amount: each, period, buyTheDip: dip }, new Date()), [each, period, dip]);
  const balance = state.balances?.usdt ?? 0n;
  const buysCovered = each > 0n ? Number(balance / each) : 0;
  const feeDue = state.registration && state.registration.nextGrantFeeCelo > 0n ? state.registration : null;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.confirmPlan({ amount: each, period, buyTheDip: dip, expiresAt: limits.expiresAt });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="stack narrow">
      <div className="screen-head">
        <h1>Choose a plan</h1>
        {onBack && (
          <Button variant="plain" className="btn--small" onClick={onBack} disabled={busy}>
            Back
          </Button>
        )}
      </div>

      <Panel>
        <fieldset className="presets">
          <legend className="frame__title">How often</legend>
          <div className="presets__row presets__row--two">
            {(["week", "day"] as const).map((p) => (
              <label key={p} className={`preset ${period === p ? "is-on" : ""}`}>
                <input type="radio" name={freqName} value={p} checked={period === p} onChange={() => setPeriod(p)} />
                <span className="preset__amount">{p === "week" ? "Weekly" : "Daily"}</span>
                <span className="preset__unit">{p === "week" ? "resets Monday 00:00 UTC" : "resets 00:00 UTC"}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="presets">
          <legend className="frame__title">Gold to buy every {per}</legend>
          <div className="presets__row">
            {PLAN_PRESETS_USDT.map((p) => (
              <label key={p} className={`preset ${amount === p ? "is-on" : ""}`}>
                <input type="radio" name={name} value={p} checked={amount === p} onChange={() => setAmount(p)} />
                <span className="preset__amount">${p}</span>
                <span className="preset__unit">per {per}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="toggle">
          <input type="checkbox" checked={dip} onChange={(e) => setDip(e.target.checked)} />
          <span className="toggle__box" aria-hidden="true" />
          <span>
            <span className="toggle__label">Buy once more if gold drops {DIP_PERCENT}%</span>
            <span className="toggle__help">
              At most one extra buy per {per}, so the {daily ? "daily" : "weekly"} limit doubles.
            </span>
          </span>
        </label>
      </Panel>

      <Panel title="Limits written onchain">
        <dl className="facts">
          <div>
            <dt>{daily ? "Daily" : "Weekly"} limit</dt>
            <dd>
              <span className="num">{usdt(limits.cap)} USD₮</span> per {per}, including{" "}
              <span className="num">{usdt(limits.feeAllowance)}</span> USD₮ for network fees. Resets{" "}
              {daily ? (
                <>
                  every day at <span className="num">00:00</span> UTC
                </>
              ) : (
                <>
                  Monday <span className="num">00:00</span> UTC
                </>
              )}
              .
            </dd>
          </div>
          <div>
            <dt>Allowed</dt>
            <dd>Gold purchases only (Tether Gold, XAUt0), delivered to your wallet</dd>
          </div>
          <div>
            <dt>Ends</dt>
            <dd>
              <span className="num">{formatDate(limits.expiresAt)}</span>, after <span className="num">{PLAN_DURATION_WEEKS}</span> weeks.
              The agent cannot spend after that.
            </dd>
          </div>
          <div>
            <dt>Stop</dt>
            <dd>Any time, with one tap</dd>
          </div>
        </dl>
        <p className="muted small">
          Your <span className="num">{usdt(balance)}</span> USD₮{" "}
          {buysCovered >= 1 ? (
            <>
              covers about <span className="num">{buysCovered}</span> {daily ? "daily" : "weekly"} buys.
            </>
          ) : (
            `is less than one ${daily ? "daily" : "weekly"} buy. Add money before the first purchase.`
          )}
          {feeDue !== null && (
            <>
              {" "}
              Confirming also pays Altana&apos;s registration fee of about <span className="num">{celo(feeDue.nextGrantFeeCelo)}</span> CELO
              {feeDue.walletRegistered ? " for the agent's new key" : " for your wallet and the agent's key"}.
            </>
          )}
        </p>
      </Panel>

      <Button block onClick={confirm} disabled={busy}>
        {busy ? (
          <>
            <Spinner /> Confirm with your passkey…
          </>
        ) : (
          <>
            Confirm: <span className="num">${amount}</span> of gold a {per}
          </>
        )}
      </Button>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
