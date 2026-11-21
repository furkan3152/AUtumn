"use client";

import { useState } from "react";
import { isFunded, type AutumnClient, type AutumnState } from "@/lib/autumn";
import { useAutumn } from "@/lib/useAutumn";
import { Logo } from "./Logo";
import { Button, Panel, Spinner } from "./ui";
import { Landing } from "./screens/Landing";
import { Deposit } from "./screens/Deposit";
import { PlanPicker } from "./screens/PlanPicker";
import { Home } from "./screens/Home";

type View = "auto" | "deposit" | "plan";

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
        {load.status === "unconnected" && <Landing connected={false} price={null} />}
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

  if (!state.wallet) return <Landing connected client={client} price={state.price} notices={state.notices} />;

  const hasPlan = state.plan !== null;

  return (
    <>
      <Notices notices={state.notices} />
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
  if (view === "deposit") return <Deposit state={state} onBack={back} />;
  if (view === "plan" && isFunded(state)) return <PlanPicker client={client} state={state} onDone={back} onBack={back} />;
  if (view === "plan") return <Deposit state={state} onContinue={() => setView("plan")} onBack={back} />;
  if (!hasPlan) return <Deposit state={state} onContinue={() => setView("plan")} />;

  return <Home client={client} state={state} onAddMoney={() => setView("deposit")} onNewPlan={() => setView("plan")} />;
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
