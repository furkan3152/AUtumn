"use client";

import { useId, useMemo, useState } from "react";
import {
  DECIMALS,
  DIP_PERCENT,
  PLAN_DURATION_WEEKS,
  PLAN_PRESETS_USDT,
  draftLimits,
  type GramClient,
  type GramState,
} from "@/lib/gram";
import { celo, formatDate, usdt } from "@/lib/format";
import { errorText } from "@/lib/useGram";
import { Button, Panel, Spinner } from "../ui";

const UNIT = 10n ** BigInt(DECIMALS.USDT);

export function PlanPicker({
  client,
  state,
  onDone,
  onBack,
}: {
  client: GramClient;
  state: GramState;
  onDone: () => void;
  onBack?: () => void;
}) {
  const [amount, setAmount] = useState<number>(5);
  const [dip, setDip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();

  const weekly = BigInt(amount) * UNIT;
  const limits = useMemo(() => draftLimits({ weeklyAmount: weekly, buyTheDip: dip }, new Date()), [weekly, dip]);
  const balance = state.balances?.usdt ?? 0n;
  const weeksCovered = weekly > 0n ? Number(balance / weekly) : 0;
  const feeDue = state.registration && !state.registration.paid ? state.registration.feeCelo : null;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.confirmPlan({ weeklyAmount: weekly, buyTheDip: dip });
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
          <legend className="frame__title">Gold to buy every week</legend>
          <div className="presets__row">
            {PLAN_PRESETS_USDT.map((p) => (
              <label key={p} className={`preset ${amount === p ? "is-on" : ""}`}>
                <input type="radio" name={name} value={p} checked={amount === p} onChange={() => setAmount(p)} />
                <span className="preset__amount">${p}</span>
                <span className="preset__unit">per week</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="toggle">
          <input type="checkbox" checked={dip} onChange={(e) => setDip(e.target.checked)} />
          <span className="toggle__box" aria-hidden="true" />
          <span>
            <span className="toggle__label">Buy once more if gold drops {DIP_PERCENT}%</span>
            <span className="toggle__help">At most one extra buy per week, so the weekly limit doubles.</span>
          </span>
        </label>
      </Panel>

      <Panel title="Limits written onchain">
        <dl className="facts">
          <div>
            <dt>Weekly limit</dt>
            <dd>
              <span className="num">{usdt(limits.weeklyCap)} USD₮</span> per week, resets Monday <span className="num">00:00</span> UTC
            </dd>
          </div>
          <div>
            <dt>Allowed</dt>
            <dd>Gold purchases only (Tether Gold, XAUt0), delivered to your wallet</dd>
          </div>
          <div>
            <dt>Ends</dt>
            <dd>
              <span className="num">{formatDate(limits.expiresAt)}</span> (<span className="num">{PLAN_DURATION_WEEKS}</span> weeks)
            </dd>
          </div>
          <div>
            <dt>Stop</dt>
            <dd>Any time, with one tap</dd>
          </div>
        </dl>
        <p className="muted small">
          Your <span className="num">{usdt(balance)}</span> USD₮{" "}
          {weeksCovered >= 1 ? (
            <>
              covers about <span className="num">{weeksCovered}</span> weekly buys.
            </>
          ) : (
            "is less than one weekly buy. Add money before the first purchase."
          )}
          {feeDue !== null && (
            <>
              {" "}Confirming also pays the one-time registration fee of <span className="num">{celo(feeDue)}</span> CELO.
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
            Confirm: <span className="num">${amount}</span> of gold a week
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
