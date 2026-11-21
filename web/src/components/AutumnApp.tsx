"use client";

import { useEffect, useState } from "react";
import { isFunded, type AutumnClient, type AutumnState } from "@/lib/autumn";
import { useAutumn } from "@/lib/useAutumn";
import { Logo } from "./Logo";
import { Button, Panel, Spinner } from "./ui";
import { Landing } from "./screens/Landing";
import { Deposit } from "./screens/Deposit";
import { PlanPicker } from "./screens/PlanPicker";
import { Home } from "./screens/Home";
import { SendOut } from "./screens/SendOut";
import { errorText } from "@/lib/useAutumn";
import { TxLink } from "./ui";
import type { TxHash } from "@/lib/autumn";

type View = "auto" | "deposit" | "plan" | "send";

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
      <Header />
      <main className="main" id="main">
        {load.status === "loading" && <Loading />}
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

function Ready({ client, state }: { client: AutumnClient; state: AutumnState }) {
  const [view, setView] = useState<View>("auto");
  const back = () => setView("auto");
  // A new screen starts at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  if (!state.wallet) return <Landing client={client} price={state.price} registration={state.registration} fees={state.fees} notices={state.notices} />;

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
  if (view === "send") return <SendOut client={client} state={state} onBack={back} {...(state.plan ? { goldBuyer: state.plan.proof.calls[1]!.contract } : {})} />;
  if (view === "deposit") return <Deposit state={state} onBack={back} onSendOut={onSendOut} />;
  if (view === "plan" && isFunded(state)) return <PlanPicker client={client} state={state} onDone={back} onBack={back} />;
  if (view === "plan") return <Deposit state={state} onContinue={() => setView("plan")} onBack={back} onSendOut={onSendOut} />;
  if (!hasPlan) return <Deposit state={state} onContinue={() => setView("plan")} onSendOut={onSendOut} />;

  return <Home client={client} state={state} onAddMoney={() => setView("deposit")} onNewPlan={() => setView("plan")} onSendOut={onSendOut} />;
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
    <Panel title="Autumn is not live yet" className="narrow">
      <p>Autumn will buy a little tokenized gold for you on Celo, within limits you set. It is not open yet.</p>
      <p className="muted">Please come back soon.</p>
    </Panel>
  );
}

/** An agent key that is live onchain but runs no plan: the owner is asked to revoke it. */
function StrayKey({ client, stray }: { client: AutumnClient; stray: NonNullable<AutumnState["strayKey"]> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ txHash?: TxHash } | null>(null);
  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await client.revokeStrayKey());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="narrow">
    <Panel title="An unused agent key is still live" tone="alert">
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
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Panel>
    </div>
  );
}

function Loading() {
  return (
    <div className="center-state" role="status">
      <Spinner />
      <p>Loading your wallet…</p>
    </div>
  );
}

function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Panel title="Could not load your wallet" tone="alert" className="narrow">
      <p>{message}</p>
      <p className="muted">Your funds are not affected. This page only reads from Celo.</p>
      <Button onClick={retry}>Try again</Button>
    </Panel>
  );
}
