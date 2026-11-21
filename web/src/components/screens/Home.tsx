"use client";

import { useEffect, useState } from "react";
import { periodsInPlan, type ActivityItem, type AutumnClient, type AutumnState, type RefusalReason } from "@/lib/autumn";
import {
  celo,
  formatDate,
  formatDateTime,
  formatGrams,
  goldValue,
  perGram,
  relative,
  shortAddress,
  usdt,
} from "@/lib/format";
import { errorText } from "@/lib/useAutumn";
import { Scene, type SceneMode } from "../Scene";
import { P, Sprite } from "../pixel";
import { Button, CopyButton, Panel, Spinner, TxLink } from "../ui";

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Home({
  client,
  state,
  onAddMoney,
  onNewPlan,
}: {
  client: AutumnClient;
  state: AutumnState;
  onAddMoney: () => void;
  onNewPlan: () => void;
}) {
  const now = useNow();
  const plan = state.plan!;
  const agent = state.agent;
  const b = state.balances;
  const lim = plan.limits;
  const gold = b?.gold ?? 0n;

  const purchases = state.activity.filter((a): a is Extract<ActivityItem, { kind: "purchase" }> => a.kind === "purchase");
  const spentTotal = purchases.reduce((s, p) => s + p.spent, 0n);
  const budget = plan.amount * BigInt(periodsInPlan(plan.period));
  const chestFill = budget > 0n ? Math.min(1, Number((spentTotal * 1000n) / budget) / 1000) : 0;
  const spent = lim.spent ?? 0n;
  const limitUsed = lim.cap > 0n && lim.spent !== null ? Number((spent * 1000n) / lim.cap) / 1000 : 0;
  const left = lim.cap > spent ? lim.cap - spent : 0n;
  const daily = plan.period === "day";
  const periodWord = daily ? "day" : "week";

  const running = agent.kind === "active" || agent.kind === "stopping";
  const mode: SceneMode =
    agent.kind === "stopped" ? "stopped" : agent.kind === "expired" ? "expired" : agent.kind === "stopping" ? "stopping" : "active";

  const sceneLabel = [
    mode === "stopped"
      ? "Picture: the helper is sitting down asleep. A sign says the agent is stopped."
      : mode === "expired"
        ? "Picture: the helper is resting. A sign says the plan has ended."
        : "Picture: the helper stands by the chest, ready to walk to the gold stall.",
    gold > 0n ? `The chest holds ${formatGrams(gold)} grams of gold.` : "The chest is empty.",
    `The fence shows this ${periodWord}'s limit: ${Math.round(limitUsed * 100)}% used.`,
  ].join(" ");

  return (
    <div className="home">
      <div className="home__scene">
        <Scene
          mode={mode}
          chestFill={chestFill}
          limitUsed={limitUsed}
          purchaseKey={purchases[0]?.id}
          label={sceneLabel}
          signText={mode === "stopped" ? "Agent stopped" : mode === "expired" ? "Plan ended" : undefined}
        />
        <p className="scene-key">
          <span className="key-item">
            <span className="key key--chest" aria-hidden="true" /> Chest: gold you hold
          </span>
          <span className="key-item">
            <span className="key key--fence" aria-hidden="true" /> Fence: this {periodWord}&apos;s limit, gold posts are used
          </span>
        </p>
      </div>

      {agent.kind === "stopped" || agent.kind === "expired" ? (
        <Panel tone="stopped" title={agent.kind === "stopped" ? "Agent stopped" : "Plan ended"} className="home__status">
          {agent.kind === "stopped" ? (
            <p>
              {agent.stoppedAt ? (
                <>
                  The agent was stopped {relative(agent.stoppedAt, now)} (<span className="num">{formatDateTime(agent.stoppedAt)}</span>).
                </>
              ) : (
                <>The agent&apos;s key is revoked onchain.</>
              )}{" "}
              It can no longer buy anything.{" "}
              {agent.txHash ? <TxLink hash={agent.txHash}>See the revoke on Celoscan</TxLink> : null}
            </p>
          ) : (
            <p>The plan reached its end date on {formatDate(agent.expiredAt)}. The agent can no longer buy anything.</p>
          )}
          <p>Your gold and USD₮ stay in your wallet.</p>
          <Button onClick={onNewPlan}>Start a new plan</Button>
        </Panel>
      ) : (
        <StatusAndStop client={client} state={state} now={now} />
      )}

      <div className="home__grid">
        <div className="stack">
          <Panel title="Your gold">
            {gold > 0n ? (
              <>
                <p className="big num">{formatGrams(gold)} g</p>
                {state.price ? (
                  <>
                    <p className="num">about {usdt(goldValue(gold, state.price.usdtPerOunce))} USD₮</p>
                    <p className="muted small">
                      Price <span className="num">{usdt(perGram(state.price.usdtPerOunce))}</span> USD₮ per gram, checked{" "}
                      <span className="num">{formatDateTime(state.price.observedAt)}</span>
                    </p>
                  </>
                ) : (
                  <p className="muted small">Gold price unavailable right now.</p>
                )}
              </>
            ) : (
              <p>
                No gold yet.
                {plan.nextPurchaseAt && agent.kind === "active"
                  ? (
                    <>
                      {" "}The first purchase is <span className="num">{formatDateTime(plan.nextPurchaseAt)}</span>.
                    </>
                  ) : null}
              </p>
            )}
          </Panel>

          <Panel title={running ? `This ${periodWord}'s limit` : "Limits of the last plan"}>
            {!running && <p className="muted">No longer in force. The agent cannot spend anything.</p>}
            <div
              className="meter"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(limitUsed * 100)}
              aria-label={`${daily ? "Daily" : "Weekly"} limit used`}
            >
              <span style={{ width: `${Math.min(100, limitUsed * 100)}%` }} />
            </div>
            <dl className="facts">
              <div>
                <dt>Used</dt>
                <dd className="num">
                  {lim.spent !== null ? usdt(lim.spent) : "Unknown"} of {usdt(lim.cap)} USD₮
                </dd>
              </div>
              <div>
                <dt>Left</dt>
                <dd className="num">{lim.spent !== null ? `${usdt(left)} USD₮` : "Unknown"}</dd>
              </div>
              <div>
                <dt>Resets</dt>
                <dd>
                  {daily ? "Every day" : "Monday"} <span className="num">00:00</span> UTC (
                  <span className="num">{formatDateTime(lim.resetsAt)}</span> your time)
                </dd>
              </div>
              <div>
                <dt>Allowed</dt>
                <dd>Gold purchases only, delivered to your wallet</dd>
              </div>
              <div>
                <dt>Ends</dt>
                <dd className="num">{formatDate(lim.expiresAt)}</dd>
              </div>
            </dl>
            {lim.observedAt && (
              <p className="muted small">
                Read from Celo <span className="num">{formatDateTime(lim.observedAt)}</span>
              </p>
            )}
          </Panel>

          <Panel title="Wallet">
            <dl className="facts">
              <div>
                <dt>USD₮</dt>
                <dd className="num">{b ? usdt(b.usdt) : "Unknown"}</dd>
              </div>
              <div>
                <dt>CELO</dt>
                <dd className="num">{b ? celo(b.celo) : "Unknown"}</dd>
              </div>
              {state.identity && (
                <div>
                  <dt>Agent ID</dt>
                  <dd>{state.identity.registered ? "Registered (ERC-8004)" : "Not registered yet"}</dd>
                </div>
              )}
              <div>
                <dt>Address</dt>
                <dd className="addr-row">
                  <span className="num">{shortAddress(state.wallet!.address)}</span>
                  <CopyButton text={state.wallet!.address} />
                </dd>
              </div>
            </dl>
            <Button variant="plain" onClick={onAddMoney}>
              Add money
            </Button>
          </Panel>
        </div>

        <Panel title="Activity" className="activity">
          {state.activity.length === 0 ? (
            <p className="muted">Nothing yet.</p>
          ) : (
            <ul className="feed">
              {state.activity.map((a) => (
                <ActivityRow key={a.id} item={a} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function StatusAndStop({ client, state, now }: { client: AutumnClient; state: AutumnState; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopping = state.agent.kind === "stopping";
  const plan = state.plan!;
  const next = plan.nextPurchaseAt;
  const due = next !== null && next.getTime() <= now;
  const per = plan.period === "day" ? "day" : "week";
  const priceCheckDown = state.price?.priceCheckAvailable === false;

  const stop = async () => {
    setError(null);
    try {
      await client.stopAgent();
      setConfirming(false);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Panel className="home__status" title={stopping ? "Stopping the agent…" : "Agent is running"}>
      {stopping ? (
        <p className="waiting" role="status">
          <Spinner /> Sending the revoke to Celo. This takes a few seconds.
        </p>
      ) : (
        <>
          <p>
            Next purchase:{" "}
            <strong>
              {next === null ? "none scheduled" : due ? "due now, at the agent's next run" : <span className="num">{formatDateTime(next)} ({relative(next, now)})</span>}
            </strong>
            . Plan: <span className="num">{usdt(plan.amount)} USD₮</span> of gold a {per}
            {plan.buyTheDip ? ", plus one extra buy if gold drops 2%" : ""}.
          </p>
          {priceCheckDown && <p className="muted">Price check not available right now, the agent will retry.</p>}
        </>
      )}

      {!stopping && !confirming && (
        <Button variant="danger" block onClick={() => setConfirming(true)}>
          Stop the agent
        </Button>
      )}

      {!stopping && confirming && (
        <div className="confirm" role="group" aria-label="Confirm stop">
          <p>
            <strong>Stop the agent?</strong> This sends a revoke to Celo. The agent will not be able to buy anything
            after that. Your gold and USD₮ stay in your wallet.
          </p>
          <div className="row">
            <Button variant="danger" onClick={stop} autoFocus>
              Yes, stop now
            </Button>
            <Button variant="plain" onClick={() => setConfirming(false)}>
              Keep running
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          Could not stop: {error}
        </p>
      )}
    </Panel>
  );
}

const REFUSAL: Record<RefusalReason, string> = {
  cap: "Limit reached",
  "not-gold": "Not a gold purchase",
  expired: "The plan has ended",
  revoked: "The agent was stopped",
};

function ActivityRow({ item }: { item: ActivityItem }) {
  let icon: IconName;
  let title: React.ReactNode;
  let detail: React.ReactNode = null;
  switch (item.kind) {
    case "purchase":
      icon = "coin";
      title = (
        <>
          Bought <span className="num">{formatGrams(item.received)} g</span> of gold
        </>
      );
      detail = (
        <>
          Paid <span className="num">{usdt(item.spent)} USD₮</span> at{" "}
          <span className="num">{usdt(perGram(item.usdtPerOunce))}</span> per gram.{" "}
          {item.trigger === "dip" ? "Extra buy after a 2% drop." : item.period === "day" ? "Daily buy." : "Weekly buy."}
        </>
      );
      break;
    case "refused":
      icon = "no";
      title = `Purchase refused: ${REFUSAL[item.reason]}`;
      detail = (
        <>
          The limits blocked {item.attempted !== null ? <>a <span className="num">{usdt(item.attempted)} USD₮</span> buy</> : "a buy"}. Nothing was
          spent. Recorded by the agent.
        </>
      );
      break;
    case "skipped":
      icon = "leaf";
      title = item.retries ? "Purchase postponed" : "Purchase skipped";
      detail = <>{item.text} {item.txHash ? "Recorded by the agent." : "Recorded by the agent; nothing was sent onchain."}</>;
      break;
    case "plan-started":
      icon = "leaf";
      title = "Plan started";
      detail = (
        <>
          <span className="num">{usdt(item.amount)} USD₮</span> of gold a {item.period === "day" ? "day" : "week"}. Limits written onchain.
        </>
      );
      break;
    case "registration":
      icon = "leaf";
      title = "Wallet registered";
      detail = "Altana's one-time registration of your wallet, paid in CELO.";
      break;
    case "stopped":
      icon = "stop";
      title = "Agent stopped";
      detail = "You revoked the agent onchain.";
      break;
  }
  const tx = "txHash" in item ? item.txHash : undefined;
  return (
    <li className={`feed__item feed__item--${item.kind}`}>
      <FeedIcon name={icon} />
      <div className="feed__body">
        <p className="feed__title">{title}</p>
        {detail && <p className="feed__detail">{detail}</p>}
        <p className="feed__meta">
          <time className="num" dateTime={item.at.toISOString()}>{formatDateTime(item.at)}</time>
          {tx && (
            <>
              {" · "}
              <TxLink hash={tx} />
            </>
          )}
        </p>
      </div>
    </li>
  );
}

type IconName = "coin" | "no" | "leaf" | "stop";

const ICONS: Record<IconName, { rows: string[]; pal: Record<string, string> }> = {
  coin: {
    rows: ["..kkkk..", ".kyyyyk.", "kyllyyyk", "kylyyyyk", "kyyyyydk", "kyyyyydk", ".kyyddk.", "..kkkk.."],
    pal: { k: P.goldDark, y: P.gold, l: P.goldLight, d: "#d99a24" },
  },
  no: {
    rows: ["rr....rr", "rrr..rrr", ".rrrrrr.", "..rrrr..", "..rrrr..", ".rrrrrr.", "rrr..rrr", "rr....rr"],
    pal: { r: "#a3301f" },
  },
  leaf: {
    rows: ["....kkk.", "...koook", "..kooolk", ".koolook", ".kolook.", "kolokk..", "kkk.....", "k......."],
    pal: { k: "#6e2a18", o: "#d0702c", l: "#f0b040" },
  },
  stop: {
    rows: [".kkkkkk.", "kwwwwwwk", "kwkkkkwk", "kwkkkkwk", "kwkkkkwk", "kwkkkkwk", "kwwwwwwk", ".kkkkkk."],
    pal: { k: "#a3301f", w: "#fbefd2" },
  },
};

function FeedIcon({ name }: { name: IconName }) {
  const i = ICONS[name];
  return (
    <svg className="ficon" viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
      <Sprite rows={i.rows} palette={i.pal} />
    </svg>
  );
}
