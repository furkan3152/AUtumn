"use client";

import { useState } from "react";
import type { AutumnClient, GoldPrice } from "@/lib/autumn";
import { formatDateTime, perGram, usdt } from "@/lib/format";
import { errorText } from "@/lib/useAutumn";
import { Logo } from "../Logo";
import { Scene } from "../Scene";
import { Button, Panel, Spinner } from "../ui";

const STEPS = [
  { title: "Create your wallet", body: "Use a passkey: Face ID, fingerprint or your device PIN. No seed phrase." },
  { title: "Add money", body: "Send USD₮ on the Celo network to your new wallet." },
  {
    title: "Choose a plan",
    body: (
      <>
        For example, <span className="num">$5</span> of gold every week. You can stop it with one tap.
      </>
    ),
  },
];

type LandingProps = { price: GoldPrice | null; notices?: string[] } & ({ connected: false } | { connected: true; client: AutumnClient });

export function Landing(props: LandingProps) {
  const [busy, setBusy] = useState<null | "create" | "restore">(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: "create" | "restore") => {
    if (!props.connected) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "create") await props.client.createWallet();
      else await props.client.restoreWallet();
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  return (
    <div className="landing">
      <div className="landing__hero">
        <div className="landing__logo">
          <Logo variant="full" scale={7} />
        </div>
        <p className="lede">A little gold every week. Never more than you allow.</p>
        <p className="pitch">
          A helper buys Tether Gold for you with USD₮ on Celo, only within limits written onchain, and you can stop it
          any time.
        </p>
        {props.price && (
          <p className="muted small landing__price">
            Gold now: <span className="num">{usdt(perGram(props.price.usdtPerOunce))}</span> USD₮ per gram on Celo, checked{" "}
            <span className="num">{formatDateTime(props.price.observedAt)}</span>.
          </p>
        )}
        {props.notices?.map((n) => (
          <p key={n} className="muted small">
            {n}
          </p>
        ))}
      </div>

      <div className="landing__scene">
        <Scene mode="intro" chestFill={0.4} limitUsed={0} label="Picture: a small helper stands next to a treasure chest, with a market stall selling gold nearby." />
      </div>

      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className="frame frame--paper step">
            <span className="step__num" aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <h2 className="step__title">{s.title}</h2>
              <p>{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      {props.connected ? (
        <div className="cta">
          <Button block onClick={() => run("create")} disabled={busy !== null}>
            {busy === "create" ? (
              <>
                <Spinner /> Waiting for your passkey…
              </>
            ) : (
              "Create wallet with passkey"
            )}
          </Button>
          <Button variant="plain" block onClick={() => run("restore")} disabled={busy !== null}>
            {busy === "restore" ? (
              <>
                <Spinner /> Waiting for your passkey…
              </>
            ) : (
              "I already have an Autumn passkey"
            )}
          </Button>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <Panel title="Not connected yet" tone="alert">
          <p>This version of Autumn is not connected to a wallet or to Celo yet, so there is nothing to show.</p>
          <p className="muted">No balances, prices or purchases are displayed until the connection is added.</p>
        </Panel>
      )}
    </div>
  );
}
