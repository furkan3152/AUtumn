"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CUSTODY_TEXT, LIMITS_TEXT, isAndroid, type AutumnClient, type CreationMode, type FeeFacts, type GoldPrice, type Registration, type Wallet } from "@/lib/autumn";
import { formatDateTime, perGram, usdt } from "@/lib/format";
import { errorText } from "@/lib/useAutumn";
import { Logo } from "../Logo";
import { Scene } from "../Scene";
import { CostsList } from "../Costs";
import { Button, FailureNotice, Panel, Spinner } from "../ui";
import { Icon, type IconName } from "../icons";

const STEPS: { title: string; icon: IconName; body: React.ReactNode }[] = [
  { title: "Create your wallet", icon: "passkey", body: "Use a passkey: Face ID, fingerprint or your device PIN. No seed phrase." },
  { title: "Add money", icon: "note", body: "Send USD₮ on the Celo network to your new wallet." },
  {
    title: "Choose a plan",
    icon: "calendar",
    body: (
      <>
        For example, <span className="num">$5</span> of gold every week. You can stop it at any time with your passkey.
      </>
    ),
  },
];

type LandingProps = {
  /** null while the client loads: the page shows at once, its buttons wait. */
  client: AutumnClient | null;
  price: GoldPrice | null;
  registration: Registration | null;
  fees: FeeFacts | null;
  notices?: string[];
  /** Called with the new wallet once it is created. */
  onCreated?: (wallet: Wallet) => void;
};

export function Landing(props: LandingProps) {
  const [busy, setBusy] = useState<null | "create" | "restore" | "code">(null);
  const [error, setError] = useState<{ kind: "create" | "restore"; mode: CreationMode; e: unknown } | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  // On Android the main button makes a passkey behind this phone's screen lock (see passkey.ts); the link offers
  // the account-saved kind instead. Read after mount so the server and the first client render agree.
  const [android, setAndroid] = useState(false);
  useEffect(() => setAndroid(isAndroid()), []);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const codeId = useId();
  const createRef = useRef<HTMLButtonElement>(null);
  const client = props.client;
  const ready = client !== null;

  const run = async (kind: "create" | "restore", mode: CreationMode = "auto") => {
    if (!client || busy !== null) return;
    setBusy(kind);
    setError(null);
    setCodeError(null);
    try {
      if (kind === "create") {
        const w = await client.createWallet({ mode });
        props.onCreated?.(w);
      } else await client.restoreWallet();
    } catch (e) {
      setError({ kind, mode, e });
      setBusy(null);
    }
  };

  const restoreCode = async () => {
    if (code.trim() === "") {
      setCodeError("Paste your backup code first.");
      return;
    }
    if (!client || busy !== null) return;
    setBusy("code");
    setCodeError(null);
    setError(null);
    try {
      await client.restoreFromBackupCode(code.trim());
    } catch (e) {
      setCodeError(errorText(e));
      setBusy(null);
    }
  };

  return (
    <div className="landing">
      <section className="hero" aria-label="Autumn">
        <Scene
          variant="hero"
          mode="intro"
          chestFill={0.4}
          limitUsed={0}
          label="Picture: a small helper stands next to a treasure chest outside a cottage, with a market stall selling gold further down the path."
        >
          <div className="hangsign">
            <span className="hangsign__rope hangsign__rope--l" aria-hidden="true" />
            <span className="hangsign__rope hangsign__rope--r" aria-hidden="true" />
            <h1 className="hangsign__board">
              <span className="hangsign__logo hangsign__logo--big">
                <Logo variant="full" scale={6} />
              </span>
              <span className="hangsign__logo hangsign__logo--small">
                <Logo variant="full" scale={4} />
              </span>
            </h1>
          </div>
        </Scene>
      </section>

      <div className="landing__intro frame frame--paper">
        <p className="lede">A little gold every week. Never more than you allow.</p>
        <p className="pitch">
          A helper buys Tether Gold for you with USD₮ on Celo, on a schedule. Unlike an exchange&apos;s recurring buy, the gold
          sits in a wallet only you control, and the agent&apos;s limits are public and enforced onchain.
        </p>
        {/* Always rendered, so the price arriving later does not move the page. */}
        <p className="landing__price" aria-live="polite">
          <Icon name="coin" />
          {props.price ? (
            <span>
              Gold now: <span className="num">{usdt(perGram(props.price.usdtPerOunce))}</span> USD₮ per gram on Celo, checked{" "}
              <span className="num">{formatDateTime(props.price.observedAt)}</span>.
            </span>
          ) : (
            <span className="muted">Reading the gold price on Celo…</span>
          )}
        </p>
        {props.notices?.map((n) => (
          <p key={n} className="muted small">
            {n}
          </p>
        ))}
        <Button
          block
          onClick={() => {
            document.getElementById("start")?.scrollIntoView({ behavior: "smooth", block: "center" });
            createRef.current?.focus({ preventScroll: true });
          }}
        >
          Get started
        </Button>
      </div>

      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className="step">
            <span className="step__marker" aria-hidden="true">
              <span className="step__num">{i + 1}</span>
            </span>
            <div className="step__card">
              <h2 className="step__title">
                <Icon name={s.icon} />
                {s.title}
              </h2>
              <p>{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="landing__lower">
        <Panel title="Before you start" icon="scroll" className="landing__costs">
          <CostsList registration={props.registration} fees={props.fees} />
          <p className="callout">
            <Icon name="lock" />
            <span>
              {CUSTODY_TEXT} {LIMITS_TEXT}
            </span>
          </p>
        </Panel>

        <div className="cta" id="start">
          <Button block onClick={() => run("create")} disabled={busy !== null || !ready} ref={createRef}>
            {busy === "create" ? (
              <>
                <Spinner /> Waiting for your passkey…
              </>
            ) : (
              "Create wallet with passkey"
            )}
          </Button>
          {android ? (
            <>
              <p className="muted small">On Android the passkey is made with this phone&apos;s screen lock and lives on this phone only.</p>
              <button type="button" className="textlink" onClick={() => run("create", "synced")} disabled={busy !== null || !ready}>
                Save the passkey to my Google account instead
              </button>
            </>
          ) : (
            <button type="button" className="textlink" onClick={() => run("create", "device")} disabled={busy !== null || !ready}>
              My device only offers another device
            </button>
          )}
          <Button variant="plain" block onClick={() => run("restore")} disabled={busy !== null || !ready}>
            {busy === "restore" ? (
              <>
                <Spinner /> Waiting for your passkey…
              </>
            ) : (
              "I already have an Autumn passkey"
            )}
          </Button>
          {error && (
            <FailureNotice
              error={error.e}
              onRetry={() => run(error.kind, error.mode)}
              onDeviceFallback={error.kind === "create" && error.mode !== "device" ? () => run("create", "device") : undefined}
            />
          )}
          {!codeOpen ? (
            <Button
              variant="plain"
              block
              className="btn--quiet"
              onClick={() => {
                setError(null);
                setCodeOpen(true);
              }}
              disabled={busy !== null || !ready}
            >
              Restore with backup code
            </Button>
          ) : (
            <form
              className="restore"
              onSubmit={(e) => {
                e.preventDefault();
                void restoreCode();
              }}
            >
              <label htmlFor={codeId} className="restore__label">
                <Icon name="passkey" /> Restore with backup code
              </label>
              <textarea
                id={codeId}
                className="input num restore__input"
                rows={3}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Paste your backup code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-invalid={codeError !== null}
                aria-describedby={codeError ? `${codeId}-err` : undefined}
              />
              {codeError && (
                <p className="error-text" role="alert" id={`${codeId}-err`}>
                  {codeError}
                </p>
              )}
              <Button type="submit" variant="plain" block disabled={busy !== null || !ready}>
                {busy === "code" ? (
                  <>
                    <Spinner /> Checking the code…
                  </>
                ) : (
                  "Restore"
                )}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
