"use client";

import { useEffect, useRef, useState } from "react";
import {
  CUSTODY_TEXT,
  DIP_RULE_TEXT,
  LIMITS_TEXT,
  addressUrl,
  agentScanUrl,
  keystoreKeyUrl,
  periodsInPlan,
  type ActivityItem,
  type AutumnClient,
  type AutumnState,
  type RefusalReason,
} from "@/lib/autumn";
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
import { BackupChip, Banner, Button, CopyButton, ExtLink, FailureNotice, Label, Panel, Spinner, TxLink, isDeviceBound } from "../ui";
import { Icon, type IconName } from "../icons";

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
  onSendOut,
  onBackupCode,
}: {
  client: AutumnClient;
  state: AutumnState;
  onAddMoney: () => void;
  onNewPlan: () => void;
  onSendOut: () => void;
  onBackupCode: () => void;
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
  const bump = useBump(purchases[0]?.id);
  const started = state.activity.find((a) => a.kind === "plan-started");
  const freshlySealed = started !== undefined && now - started.at.getTime() < 3 * 60_000;

  const running = agent.kind === "active" || agent.kind === "stopping";
  const mode: SceneMode =
    agent.kind === "stopped" ? "stopped" : agent.kind === "expired" ? "expired" : agent.kind === "stopping" ? "stopping" : "active";

  const sceneLabel = [
    mode === "stopped"
      ? "Picture: the helper sits asleep by a small campfire. A sign says the agent is stopped."
      : mode === "expired"
        ? "Picture: the helper rests by a small campfire. A sign says the plan has ended."
        : "Picture: the helper stands by the chest, ready to walk to the gold stall.",
    gold > 0n ? `The chest holds ${formatGrams(gold)} grams of gold.` : "The chest is empty.",
    running ? `The lanterns along the path show this ${periodWord}'s limit: ${Math.round(limitUsed * 100)}% used.` : "",
  ]
    .filter(Boolean)
    .join(" ");

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
            <Icon name="chest" /> Chest: gold you hold
          </span>
          {running && (
            <span className="key-item">
              <span className="key key--lantern" aria-hidden="true" /> Lit lanterns: limit used <span className="num">{Math.round(limitUsed * 100)}%</span>
            </span>
          )}
        </p>
      </div>

      {agent.kind === "stopped" || agent.kind === "expired" ? (
        <section className="status status--rest home__status" aria-labelledby="status-title">
          <Banner tone="rest">
            <span id="status-title">{agent.kind === "stopped" ? "Agent stopped" : "Plan ended"}</span>
          </Banner>
          <div className="status__body">
            {agent.kind === "stopped" ? (
              <p>
                {agent.stoppedAt ? (
                  <>
                    The agent was stopped {relative(agent.stoppedAt, now, { past: true })} (<span className="num">{formatDateTime(agent.stoppedAt)}</span>).
                  </>
                ) : (
                  <>The agent&apos;s key is revoked onchain.</>
                )}{" "}
                It can no longer buy anything.{" "}
                {agent.txHash ? <TxLink hash={agent.txHash} label="See the revoke on Celoscan">See the revoke on Celoscan</TxLink> : null}
              </p>
            ) : (
              <p>The plan reached its end date on {formatDate(agent.expiredAt)}. The agent can no longer buy anything.</p>
            )}
            <p className="with-icon">
              <Icon name="chest" /> Your gold and USD₮ stay in your wallet.
            </p>
            <Button block onClick={onNewPlan}>
              Start a new plan
            </Button>
          </div>
        </section>
      ) : (
        <StatusAndStop client={client} state={state} now={now} />
      )}

      <div className="home__col home__col--a">
      <Panel title="Your gold" icon="bar" className="home__gold">
        {gold > 0n ? (
          <>
            <p className="keynum num">
              <span key={`g${bump}`} className={bump ? "pop" : ""}>
                {formatGrams(gold)} g
              </span>
              {bump > 0 && (
                <span key={`c${bump}`} className="coin-pop" aria-hidden="true">
                  <Icon name="coin" />
                </span>
              )}
            </p>
            {state.price ? (
              <>
                <p className="num keynum__sub">about {usdt(goldValue(gold, state.price.usdtPerOunce))} USD₮</p>
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
          <>
            <p className="keynum keynum--empty">No gold yet.</p>
            {plan.nextPurchaseAt && agent.kind === "active" ? (
              <p>
                The first purchase is <span className="num">{formatDateTime(plan.nextPurchaseAt)}</span>.
              </p>
            ) : null}
          </>
        )}
      </Panel>

      <Panel title="Wallet" icon="wallet" className="home__wallet">
        <dl className="facts facts--big">
          <div>
            <dt>
              <Label icon="note">USD₮</Label>
            </dt>
            <dd className="num">{b ? usdt(b.usdt) : "Unknown"}</dd>
          </div>
          <div>
            <dt>
              <Label icon="token">CELO</Label>
            </dt>
            <dd className="num">{b ? celo(b.celo) : "Unknown"}</dd>
          </div>
          <div>
            <dt>
              <Label icon="bar">Gold</Label>
            </dt>
            <dd className="num">{b ? `${formatGrams(b.gold)} g` : "Unknown"}</dd>
          </div>
          <div>
            <dt>
              <Label icon="wallet">Address</Label>
            </dt>
            <dd className="addr-row">
              <span className="num">{shortAddress(state.wallet!.address)}</span>
              <CopyButton text={state.wallet!.address} what="wallet address" />
            </dd>
          </div>
        </dl>
        {isDeviceBound(state.wallet) && <BackupChip onBackupCode={onBackupCode} />}
        <p className="muted small">You can send your funds out at any time, whether the agent is running or stopped.</p>
        <div className="row row--split">
          <Button variant="plain" onClick={onAddMoney}>
            Add money
          </Button>
          <Button variant="plain" onClick={onSendOut}>
            Send out
          </Button>
        </div>
      </Panel>

      <OnchainProof state={state} />
      </div>

      <div className="home__col home__col--b">
      <Panel title={running ? `This ${periodWord}'s limit` : "Limits of the last plan"} icon="pouch" className="home__limit">
        {!running && <p className="muted">No longer in force. The agent cannot spend anything.</p>}
        <p className="keynum-label">Left</p>
        <p className="keynum num">{lim.spent !== null ? `${usdt(left)} USD₮` : "Unknown"}</p>
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
            <dt>
              <Label icon="coin">Used</Label>
            </dt>
            <dd className="num">
              {lim.spent !== null ? usdt(lim.spent) : "Unknown"} of {usdt(lim.cap)} USD₮
            </dd>
          </div>
          <div>
            <dt>
              <Label icon="calendar">Resets</Label>
            </dt>
            <dd>
              {daily ? "Every day" : "Monday"} <span className="num">00:00</span> UTC (
              <span className="num">{formatDateTime(lim.resetsAt)}</span> your time)
            </dd>
          </div>
          <div>
            <dt>
              <Label icon="shield">Allowed</Label>
            </dt>
            <dd>{LIMITS_TEXT}</dd>
          </div>
          <div>
            <dt>
              <Label icon="hourglass">Ends</Label>
            </dt>
            <dd className="num">{formatDate(lim.expiresAt)}</dd>
          </div>
        </dl>
        {lim.observedAt && (
          <p className={`sealed ${running && freshlySealed ? "sealed--new" : ""}`}>
            <Icon name="seal" className="sealed__seal" />
            <span className="muted small">
              Read from Celo <span className="num">{formatDateTime(lim.observedAt)}</span>
            </span>
          </p>
        )}
      </Panel>

      <Panel title="Activity" icon="scroll" className="activity home__activity">
        {state.activity.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul className="feed">
            {state.activity.map((a) => (
              <ActivityRow key={a.id} item={a} now={now} />
            ))}
          </ul>
        )}
      </Panel>

      </div>
    </div>
  );
}

/** Counts changes of `key` after the first render, to replay a small celebration. */
function useBump(key: string | undefined) {
  const first = useRef(key);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (key === first.current) return;
    first.current = key;
    if (key) setN((x) => x + 1);
  }, [key]);
  return n;
}

function StatusAndStop({ client, state, now }: { client: AutumnClient; state: AutumnState; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);
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
      setError(e);
    }
  };

  return (
    <section className={`status ${stopping ? "status--busy" : "status--running"} home__status`} aria-labelledby="status-title">
      <Banner tone={stopping ? "busy" : "running"}>
        <span id="status-title">{stopping ? "Stopping the agent…" : "Agent is running"}</span>
      </Banner>
      <div className="status__body">
        {stopping ? (
          <p className="waiting" role="status">
            <Spinner /> Sending the revoke to Celo. This takes a few seconds.
          </p>
        ) : (
          <>
            <div className="status__next">
              <p className="keynum-label">
                <Icon name="hourglass" /> Next purchase
              </p>
              {next === null ? (
                <p className="keynum keynum--text">none scheduled</p>
              ) : due ? (
                <>
                  <p className="keynum keynum--text">due now</p>
                  <p className="muted">at the agent&apos;s next run</p>
                </>
              ) : (
                <>
                  <p className="keynum keynum--text">{relative(next, now)}</p>
                  <p className="num">{formatDateTime(next)}</p>
                </>
              )}
            </div>
            <p className="with-icon">
              <Icon name="calendar" />
              <span>
                Plan: <span className="num">{usdt(plan.amount)} USD₮</span> of gold a {per}
                {plan.buyTheDip ? `, plus ${DIP_RULE_TEXT}` : ""}.
              </span>
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
              <strong>Stop the agent?</strong> This sends a revoke to Celo. Your passkey approves it, and it costs a small
              network fee. The agent will not be able to buy anything after that. Your gold and USD₮ stay in your wallet.
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
        <FailureNotice error={error} onRetry={stop} prefix="Could not stop: " />
      </div>
    </section>
  );
}

const REFUSAL: Record<RefusalReason, string> = {
  cap: "Limit reached",
  "not-gold": "Not a gold purchase",
  expired: "The plan has ended",
  revoked: "The agent was stopped",
};

function ActivityRow({ item, now }: { item: ActivityItem; now: number }) {
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
          {item.trigger === "dip" ? "Extra buy: the price was at least 2% below this period's purchase price." : item.period === "day" ? "Daily buy." : "Weekly buy."}
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
      icon = "hourglass";
      title = item.retries ? "Purchase postponed" : "Purchase skipped";
      detail = <>{item.text} {item.txHash ? "Recorded by the agent." : "Recorded by the agent; nothing was sent onchain."}</>;
      break;
    case "plan-started":
      icon = "seal";
      title = "Plan started";
      detail = (
        <>
          <span className="num">{usdt(item.amount)} USD₮</span> of gold a {item.period === "day" ? "day" : "week"}. Limits written onchain.
        </>
      );
      break;
    case "registration":
      icon = "passkey";
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
  const txLabel = `View ${TX_NOUN[item.kind]} of ${formatDateTime(item.at)} on Celoscan`;
  const fresh = now - item.at.getTime() < 5 * 60_000;
  return (
    <li className={`feed__item feed__item--${item.kind} ${fresh ? "is-fresh" : ""}`}>
      <span className="feed__icon">
        <Icon name={icon} />
      </span>
      <div className="feed__body">
        <p className="feed__title">{title}</p>
        {detail && <p className="feed__detail">{detail}</p>}
        <p className="feed__meta">
          <time className="num" dateTime={item.at.toISOString()}>{formatDateTime(item.at)}</time>
          {tx && (
            <>
              {" · "}
              <TxLink hash={tx} label={txLabel} />
            </>
          )}
        </p>
      </div>
    </li>
  );
}

const TX_NOUN: Record<ActivityItem["kind"], string> = {
  purchase: "the purchase",
  refused: "the refused purchase",
  skipped: "the transaction",
  "plan-started": "the plan's start",
  registration: "the registration",
  stopped: "the stop",
};

/**
 * What anyone can check onchain: the agent's key in Altana's Keystore, the
 * calls it may make (our two plus the Orchestrator entry Altana adds), its
 * cap, period and expiry, and the agent identity.
 * A <details> so it stays out of the way on a phone; open by default on wide screens.
 */
function OnchainProof({ state }: { state: AutumnState }) {
  const plan = state.plan!;
  const lim = plan.limits;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(window.matchMedia("(min-width: 900px)").matches);
  }, []);
  const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`;
  return (
    <section className="frame frame--paper proof home__proof">
      <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>
          <span className="plank plank--summary">
            <Icon name="scroll" />
            <span>Onchain proof</span>
          </span>
        </summary>
        <dl className="facts">
          <div>
            <dt>
              <Label icon="key">Agent key</Label>
            </dt>
            <dd>
              <span className="proof__key" title={plan.proof.publicKey}>
                id {short(plan.proof.keyId)}
              </span>{" "}
              <ExtLink href={keystoreKeyUrl(plan.proof.keyId)} label="Open the agent's key in the Altana Keystore explorer">
                Keystore explorer
              </ExtLink>
            </dd>
          </div>
          <div>
            <dt>
              <Label icon="shield">May call</Label>
            </dt>
            <dd>
              {plan.proof.calls.map((c, i, all) => (
                <span key={c.label}>
                  {i === 0 ? "" : i === all.length - 1 ? " and " : ", "}
                  <ExtLink href={addressUrl(c.contract)} label={`${c.label}: open the contract ${c.contract} on Celoscan`}>
                    {c.label}
                  </ExtLink>
                </span>
              ))}
              <span className="proof__note muted small">{plan.proof.callsNote}</span>
            </dd>
          </div>
          <div>
            <dt>
              <Label icon="pouch">Cap</Label>
            </dt>
            <dd className="num">
              {usdt(lim.cap)} USD₮ per {lim.period === "day" ? "UTC day" : "week (from Monday 00:00 UTC)"}, fees included
            </dd>
          </div>
          <div>
            <dt>
              <Label icon="hourglass">Expires</Label>
            </dt>
            <dd className="num">{formatDate(lim.expiresAt)}</dd>
          </div>
          <div>
            <dt>
              <Label icon="id">Identity</Label>
            </dt>
            <dd>
              {state.identity?.registered ? (
                state.identity.agentId ? (
                  <ExtLink href={agentScanUrl(state.identity.agentId)} label={`Open agent ${state.identity.agentId} on 8004scan`}>
                    ERC-8004 agent #{state.identity.agentId}
                  </ExtLink>
                ) : (
                  "Registered (ERC-8004)"
                )
              ) : (
                "Not registered yet (ERC-8004)"
              )}
            </dd>
          </div>
        </dl>
        <p className="muted small">{CUSTODY_TEXT}</p>
      </details>
    </section>
  );
}
