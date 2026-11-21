"use client";

import { useId, useMemo, useState } from "react";
import { estimateBuyCost } from "@autumn/core";
import {
  DECIMALS,
  DIP_RULE_TEXT,
  LIMITS_TEXT,
  suggestedDeposit,
  PLAN_DURATION_WEEKS,
  PLAN_PRESETS_USDT,
  draftLimits,
  type PlanPeriod,
  type AutumnClient,
  type AutumnState,
} from "@/lib/autumn";
import { approxUsd, bpsPercent, celo, formatDate, usdt, usdtFine } from "@/lib/format";
import { celoInUsdt } from "../Costs";
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
  const fees = state.fees;
  const cost = fees ? estimateBuyCost(each, fees.relayFeeEstimate) : null;
  const fullPlan = suggestedDeposit(each, period);

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
            <span className="toggle__label">Buy the dip</span>
            <span className="toggle__help">
              Adds {DIP_RULE_TEXT}. At most one extra buy per {per}, so the {daily ? "daily" : "weekly"} limit doubles.
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
            <dd>{LIMITS_TEXT} GoldBuyer sends the gold (XAUt0) only to your wallet.</dd>
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
            <dd>Any time, with a passkey approval and a small network fee</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="What it costs">
        <dl className="facts">
          <div>
            <dt>Each buy</dt>
            <dd>
              {cost ? (
                <>
                  About <span className="num">{usdtFine(cost.total)}</span> USD₮ on top of the gold (
                  <span className="num">{bpsPercent(cost.totalBps)}</span> of <span className="num">${amount}</span>): the pool&apos;s{" "}
                  <span className="num">0.3%</span> fee (<span className="num">{usdtFine(cost.poolFee)}</span>) and an estimated relay fee of{" "}
                  <span className="num">{usdtFine(cost.relayFee)}</span> USD₮ at today&apos;s gas price. The agent refuses a relay fee above{" "}
                  <span className="num">{usdt(limits.feeAllowance / (dip ? 2n : 1n))}</span> USD₮.
                </>
              ) : (
                <>
                  The pool&apos;s <span className="num">0.3%</span> fee plus the relay fee, at most{" "}
                  <span className="num">{usdt(limits.feeAllowance / (dip ? 2n : 1n))}</span> USD₮ per buy.
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Setup</dt>
            <dd>
              {feeDue ? (
                <>
                  About <span className="num">{celo(feeDue.nextGrantFeeCelo)}</span> CELO{fees ? <> ({approxUsd(celoInUsdt(feeDue.nextGrantFeeCelo, fees))})</> : null}{" "}
                  once, for Altana&apos;s registration{feeDue.walletRegistered ? " of the agent's new key" : " of your wallet and the agent's key"}. Any
                  excess is refunded.
                </>
              ) : (
                "Read from Celo when the page refreshes."
              )}
            </dd>
          </div>
          <div>
            <dt>Full plan</dt>
            <dd>
              <span className="num">{usdt(fullPlan)}</span> USD₮ covers all <span className="num">{daily ? PLAN_DURATION_WEEKS * 7 : PLAN_DURATION_WEEKS}</span> buys
              {dip ? " (dip buys come on top)" : ""}.
            </dd>
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
          {" "}Confirming asks for your passkey twice: once for the limits, once for the agent&apos;s identity (ERC-8004).
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
