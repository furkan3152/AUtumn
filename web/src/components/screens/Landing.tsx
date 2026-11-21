"use client";

import { useState } from "react";
import { CUSTODY_TEXT, LIMITS_TEXT, type AutumnClient, type FeeFacts, type GoldPrice, type Registration } from "@/lib/autumn";
import { formatDateTime, perGram, usdt } from "@/lib/format";
import { errorText } from "@/lib/useAutumn";
import { Logo } from "../Logo";
import { Scene } from "../Scene";
import { CostsList } from "../Costs";
import { Button, Panel, Spinner } from "../ui";

const STEPS = [
  { title: "Create your wallet", body: "Use a passkey: Face ID, fingerprint or your device PIN. No seed phrase." },
  { title: "Add money", body: "Send USD₮ on the Celo network to your new wallet." },
  {
    title: "Choose a plan",
    body: (
      <>
        For example, <span className="num">$5</span> of gold every week. You can stop it at any time with your passkey.
      </>
    ),
  },
];

type LandingProps = {
  client: AutumnClient;
  price: GoldPrice | null;
  registration: Registration | null;
  fees: FeeFacts | null;
  notices?: string[];
};

export function Landing(props: LandingProps) {
  const [busy, setBusy] = useState<null | "create" | "restore">(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: "create" | "restore") => {
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
          A helper buys Tether Gold for you with USD₮ on Celo, on a schedule. Unlike an exchange&apos;s recurring buy, the gold
          sits in a wallet only you control, and the agent&apos;s limits are public and enforced onchain.
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

      <Panel title="Before you start">
        <CostsList registration={props.registration} fees={props.fees} />
        <p className="callout">
          {CUSTODY_TEXT} {LIMITS_TEXT}
        </p>
      </Panel>

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
    </div>
  );
}
