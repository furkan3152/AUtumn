"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { estimateBuyCost } from "@autumn/core";
import {
  CheckAgainError,
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
import { Button, FailureNotice, Label, Panel, ScreenHead, Spinner, Trail } from "../ui";
import { Icon } from "../icons";
import { Sprite } from "../pixel";

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
  const [error, setError] = useState<unknown>(null);
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

  const waiting = error instanceof CheckAgainError;
  const [note, setNote] = useState<string | null>(null);
  // Leave as soon as the state shows the plan running (also when it was started by "Check again" or another tab).
  const left = useRef(false);
  useEffect(() => {
    if (!left.current && state.agent.kind === "active" && state.plan) {
      left.current = true;
      onDone();
    }
  }, [state.agent.kind, state.plan, onDone]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await client.confirmPlan({ amount: each, period, buyTheDip: dip, expiresAt: limits.expiresAt });
      if (!left.current) {
        left.current = true;
        onDone();
      }
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  /** Reads the chain and starts a granted plan; never grants or pays again. */
  const checkAgain = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const plan = await client.resumePlan();
      if (plan) {
        if (!left.current) {
          left.current = true;
          onDone();
        }
        return;
      }
      setError(null);
      setNote("No grant from this browser is waiting on Celo, so nothing was paid. You can confirm again.");
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };

  return (
    <div className="screen plan">
      <ScreenHead title="Choose a plan" onBack={onBack} backDisabled={busy} />
      {state.plan === null && <Trail at={2} />}

      <Panel className="plan__choose">
        <fieldset className="presets">
          <legend className="legend">
            <Icon name="calendar" /> How often
          </legend>
          <div className="segmented">
            {(["week", "day"] as const).map((p) => (
              <label key={p} className={`segment ${period === p ? "is-on" : ""}`}>
                <input type="radio" name={freqName} value={p} checked={period === p} onChange={() => setPeriod(p)} />
                <span className="segment__name">{p === "week" ? "Weekly" : "Daily"}</span>
                <span className="segment__note">{p === "week" ? "resets Monday 00:00 UTC" : "resets 00:00 UTC"}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="presets">
          <legend className="legend">
            <Icon name="coin" /> Gold to buy every {per}
          </legend>
          <div className="presets__row">
            {PLAN_PRESETS_USDT.map((p, i) => (
              <label key={p} className={`preset ${amount === p ? "is-on" : ""}`}>
                <input type="radio" name={name} value={p} checked={amount === p} onChange={() => setAmount(p)} />
                <CoinPile size={i + 1} />
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

      <div className="plan__info stack">
      <Panel title="Limits written onchain" icon="shield">
        <dl className="facts">
          <div>
            <dt>
              <Label icon="pouch">{daily ? "Daily" : "Weekly"} limit</Label>
            </dt>
            <dd>
              <span className="num num--key">{usdt(limits.cap)} USD₮</span> per {per}, including{" "}
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
            <dt>
              <Label icon="shield">Allowed</Label>
            </dt>
            <dd>{LIMITS_TEXT} GoldBuyer sends the gold (XAUt0) only to your wallet.</dd>
          </div>
          <div>
            <dt>
              <Label icon="hourglass">Ends</Label>
            </dt>
            <dd>
              <span className="num">{formatDate(limits.expiresAt)}</span>, after <span className="num">{PLAN_DURATION_WEEKS}</span> weeks.
              The agent cannot spend after that.
            </dd>
          </div>
          <div>
            <dt>
              <Label icon="lock">Stop</Label>
            </dt>
            <dd>Any time, with a passkey approval and a small network fee.</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="What it costs" icon="coin">
        <dl className="facts">
          <div>
            <dt>
              <Label icon="coin">Each buy</Label>
            </dt>
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
            <dt>
              <Label icon="token">Setup</Label>
            </dt>
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
            <dt>
              <Label icon="calendar">Full plan</Label>
            </dt>
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
          {" "}Confirming asks for your passkey twice: once for the limits, once for the agent&apos;s identity (ERC-8004). The first buy
          happens at the agent&apos;s next run; later buys are at least <span className="num">{daily ? "12 hours" : "3 days"}</span> apart.
        </p>
      </Panel>
      </div>

      <div className="plan__act">
      <Button block onClick={confirm} disabled={busy || waiting}>
        {busy && !waiting ? (
          <>
            <Spinner /> Confirm with your passkey…
          </>
        ) : (
          <>
            Confirm: <span className="num">{usdt(each)} USD₮</span> of gold a {per}
          </>
        )}
      </Button>
      <FailureNotice error={error} onRetry={confirm} onCheckAgain={busy ? undefined : checkAgain} />
      {note && (
        <p className="muted small" role="status">
          {note}
        </p>
      )}
      </div>
    </div>
  );
}

const PILE_PAL = { k: "#7a4e10", y: "#f2bf3a", l: "#ffe58a", d: "#c98f1e" };

/** A small pile of coins: one, a few, or many, matching the amount. Decorative. */
function CoinPile({ size }: { size: number }) {
  const coin = [".kkkk.", "klllyk", "kyyyyk", "kddddk", ".kkkk."];
  const spots: [number, number][] =
    size === 1 ? [[7, 9]] : size === 2 ? [[3, 9], [10, 9], [7, 5]] : [[0, 9], [6, 9], [12, 9], [3, 5], [9, 5], [6, 1]];
  return (
    <svg className="pile" viewBox="0 0 18 14" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {spots.map(([x, y], i) => (
        <Sprite key={i} rows={coin} palette={PILE_PAL} x={x} y={y} />
      ))}
    </svg>
  );
}
