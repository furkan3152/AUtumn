"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isFunded, type AutumnClient, type AutumnState } from "@/lib/autumn";
import { useAutumn } from "@/lib/useAutumn";
import { Logo } from "./Logo";
import { Button, FailureNotice, Panel, Spinner } from "./ui";
import { Icon } from "./icons";
import { Landing } from "./screens/Landing";
import { Deposit } from "./screens/Deposit";
import { PlanPicker } from "./screens/PlanPicker";
import { Home } from "./screens/Home";
import { SendOut } from "./screens/SendOut";
import { ConvertCelo } from "./screens/ConvertCelo";
import { BackupCode } from "./screens/BackupCode";
import { errorText } from "@/lib/useAutumn";
import { TxLink } from "./ui";
import type { TxHash } from "@/lib/autumn";

type View = "auto" | "deposit" | "plan" | "send" | "convert" | "backup" | "backup-new";

/** Screens kept in the address (?screen=…) so Back returns to Home and a reload stays put. Never a half-done step. */
const URL_VIEWS: readonly View[] = ["deposit", "plan", "send", "convert", "backup"];
const viewFromUrl = (): View => {
  const v = new URLSearchParams(window.location.search).get("screen") as View | null;
  return v && URL_VIEWS.includes(v) ? v : "auto";
};
function urlFor(v: View): string {
  const q = new URLSearchParams(window.location.search);
  if (URL_VIEWS.includes(v)) q.set("screen", v);
  else q.delete("screen");
  const qs = q.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
}

/** The current screen, in step with the browser's history (Back, the Android back gesture, reload). */
function useView(): [View, (v: View) => void] {
  const [view, setViewState] = useState<View>("auto");
  const current = useRef<View>("auto");
  useEffect(() => {
    const sync = () => {
      current.current = viewFromUrl();
      setViewState(current.current);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const setView = useCallback((v: View) => {
    if (current.current === v) return;
    if (v === "auto" && (window.history.state as { autumn?: boolean } | null)?.autumn) {
      window.history.back(); // the pushed screen goes; popstate sets the view
      return;
    }
    if (URL_VIEWS.includes(v)) window.history.pushState({ autumn: true }, "", urlFor(v));
    else window.history.replaceState(null, "", urlFor(v));
    current.current = v;
    setViewState(v);
  }, []);
  return [view, setView];
}

export function AutumnApp() {
  const load = useAutumn();
  const isPreview = load.isPreview;

  return (
    <>
      {isPreview && (
        <>
          <div className="ribbon" role="note">
            Preview data. Nothing here is real or onchain.
          </div>
        </>
      )}
      <Backdrop />
      <Header />
      <main className="main" id="main">
        {load.status === "loading" && load.walletGuess === "none" && <Landing client={null} price={null} registration={null} fees={null} />}
        {load.status === "loading" && load.walletGuess !== "none" && <Loading wallet={load.walletGuess === "stored"} />}
        {load.status === "unconnected" && <NotLive />}
        {load.status === "error" && <LoadError message={load.message} retry={load.retry} />}
        {load.status === "ready" && <Ready client={load.client} state={load.state} />}
      </main>
      <footer className="footer">
        <p>Runs on Celo. Wallet by Altana. Gold is Tether Gold (XAUt0).</p>
      </footer>
    </>
  );
}

function Header() {
  return (
    <header className="header">
      <span className="header__full">
        <Logo variant="full" scale={4} />
      </span>
      <span className="header__compact">
        <Logo variant="compact" scale={3} />
      </span>
    </header>
  );
}

/** Falling-leaf accents at the edges of the page. Decorative. */
function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={`bleaf bleaf--${i}`} />
      ))}
    </div>
  );
}

function Ready({ client, state }: { client: AutumnClient; state: AutumnState }) {
  const [view, setView] = useView();
  const back = () => setView("auto");
  // A new screen starts at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  if (!state.wallet)
    return (
      <Landing
        client={client}
        price={state.price}
        registration={state.registration}
        fees={state.fees}
        notices={state.notices}
        onCreated={() => setView("backup-new")}
      />
    );

  const hasPlan = state.plan !== null;

  return (
    <>
      <Notices notices={state.notices} />
      {state.strayKey && <StrayKey client={client} stray={state.strayKey} />}
      <Screen client={client} state={state} view={view} setView={setView} back={back} hasPlan={hasPlan} />
    </>
  );
}

function Screen({
  client,
  state,
  view,
  setView,
  back,
  hasPlan,
}: {
  client: AutumnClient;
  state: AutumnState;
  view: View;
  setView: (v: View) => void;
  back: () => void;
  hasPlan: boolean;
}) {
  const onSendOut = () => setView("send");
  const onConvert = () => setView("convert");
  const onBackupCode = () => setView("backup");
  const deviceBound = state.wallet?.passkey.discoverable !== true;
  if (view === "backup-new") return <BackupCode client={client} onDone={back} deviceBound={deviceBound} />;
  if (view === "backup") return <BackupCode client={client} onDone={back} onBack={back} deviceBound={deviceBound} />;
  if (view === "send") return <SendOut client={client} state={state} onBack={back} {...(state.plan ? { goldBuyer: state.plan.proof.calls[1]!.contract } : {})} />;
  if (view === "convert") return <ConvertCelo client={client} state={state} onBack={back} />;
  if (view === "deposit") return <Deposit client={client} state={state} onBack={back} onSendOut={onSendOut} onConvert={onConvert} onBackupCode={onBackupCode} />;
  if (view === "plan" && isFunded(state)) return <PlanPicker client={client} state={state} onDone={back} onBack={back} />;
  if (view === "plan")
    return <Deposit client={client} state={state} onContinue={() => setView("plan")} onBack={back} onSendOut={onSendOut} onConvert={onConvert} onBackupCode={onBackupCode} forNewPlan={hasPlan} />;
  if (!hasPlan) return <Deposit client={client} state={state} onContinue={() => setView("plan")} onSendOut={onSendOut} onConvert={onConvert} onBackupCode={onBackupCode} />;

  return (
    <Home
      client={client}
      state={state}
      onAddMoney={() => setView("deposit")}
      onNewPlan={() => setView("plan")}
      onSendOut={onSendOut}
      onConvert={onConvert}
      onBackupCode={onBackupCode}
    />
  );
}

export function Notices({ notices }: { notices: string[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="notices narrow" role="status">
      {notices.map((n) => (
        <p key={n} className="muted small">
          {n}
        </p>
      ))}
    </div>
  );
}

/** Shown when the app has no wallet connection configured and is not the preview. */
function NotLive() {
  return (
    <Panel title="Autumn is not live yet" icon="hourglass" className="narrow center-panel">
      <p className="lead-text">Autumn will buy a little tokenized gold for you on Celo, within limits you set. It is not open yet.</p>
      <p className="muted">Please come back soon.</p>
    </Panel>
  );
}

/** An agent key that is live onchain but runs no plan: the owner is asked to revoke it. */
function StrayKey({ client, stray }: { client: AutumnClient; stray: NonNullable<AutumnState["strayKey"]> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ txHash?: TxHash } | null>(null);
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await client.revokeStrayKey());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="narrow">
    <Panel title="An unused agent key is still live" icon="key" tone="alert">
      <p>
        Your wallet granted an agent key that no plan is using: {stray.reason}. It can still spend within the limits it
        was granted until it expires. Revoke it to be safe. Your passkey approves this and it costs a small fee.
      </p>
      <p className="muted small num" title={stray.publicKey}>
        Key {stray.publicKey.slice(0, 12)}…{stray.publicKey.slice(-8)}
      </p>
      {done ? (
        <p role="status">Revoked. {done.txHash ? <TxLink hash={done.txHash} label="View the revoke of the unused key on Celoscan" /> : null}</p>
      ) : (
        <Button variant="danger" onClick={revoke} disabled={busy}>
          {busy ? (
            <>
              <Spinner /> Revoking…
            </>
          ) : (
            "Revoke this key"
          )}
        </Button>
      )}
      <FailureNotice error={error} onRetry={revoke} />
    </Panel>
    </div>
  );
}

function Loading({ wallet }: { wallet: boolean }) {
  return (
    <div className="loading" role="status">
      <div className="loading__lantern" aria-hidden="true">
        <Spinner />
      </div>
      <p className="loading__text">{wallet ? "Loading your wallet…" : "Loading…"}</p>
      <div className="skeleton" aria-hidden="true">
        <span className="skeleton__scene" />
        <span className="skeleton__line" />
        <span className="skeleton__line skeleton__line--short" />
      </div>
    </div>
  );
}

function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Panel title="Could not load your wallet" icon="no" tone="alert" className="narrow center-panel">
      <p className="lead-text">{message}</p>
      <p className="muted with-icon">
        <Icon name="shield" /> Your funds are not affected. This page only reads from Celo.
      </p>
      <Button onClick={retry}>Try again</Button>
    </Panel>
  );
}
