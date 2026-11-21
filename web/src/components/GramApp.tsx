"use client";

import { useState } from "react";
import { isFunded, type GramClient, type GramState } from "@/lib/gram";
import { useGram } from "@/lib/useGram";
import { Logo } from "./Logo";
import { Button, Panel, Spinner } from "./ui";
import { Landing } from "./screens/Landing";
import { Deposit } from "./screens/Deposit";
import { PlanPicker } from "./screens/PlanPicker";
import { Home } from "./screens/Home";

type View = "auto" | "deposit" | "plan";

export function GramApp() {
  const load = useGram();
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
        {load.status === "unconnected" && <Landing connected={false} />}
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

function Ready({ client, state }: { client: GramClient; state: GramState }) {
  const [view, setView] = useState<View>("auto");
  const back = () => setView("auto");

  if (!state.wallet) return <Landing connected client={client} />;

  const hasPlan = state.plan !== null;

  if (view === "deposit") return <Deposit state={state} onBack={back} />;
  if (view === "plan" && isFunded(state)) return <PlanPicker client={client} state={state} onDone={back} onBack={back} />;
  if (view === "plan") return <Deposit state={state} onContinue={() => setView("plan")} onBack={back} />;
  if (!hasPlan) return <Deposit state={state} onContinue={() => setView("plan")} />;

  return <Home client={client} state={state} onAddMoney={() => setView("deposit")} onNewPlan={() => setView("plan")} />;
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
