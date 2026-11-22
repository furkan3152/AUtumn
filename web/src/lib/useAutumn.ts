"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadAutumnClient, type AutumnClient, type AutumnState } from "./autumn";
import { ApiError } from "./pending";

export type AutumnLoad =
  | { status: "loading" }
  | { status: "unconnected" }
  | { status: "error"; message: string; retry: () => void }
  | { status: "ready"; client: AutumnClient; state: AutumnState };

/** Current load state, plus whether the active client is the preview (known before its data loads). */
export function useAutumn(): AutumnLoad & { isPreview: boolean; walletGuess: "none" | "stored" | null } {
  const [load, setLoad] = useState<AutumnLoad>({ status: "loading" });
  const [isPreview, setIsPreview] = useState(false);
  // Read once after mount (the server render cannot know): a browser with no stored wallet sees the landing at once.
  const [walletGuess, setWalletGuess] = useState<"none" | "stored" | null>(null);
  useEffect(() => {
    try {
      setWalletGuess(process.env.NEXT_PUBLIC_AUTUMN_PREVIEW === "1" ? "stored" : window.localStorage.getItem("autumn:v1:wallet") ? "stored" : "none");
    } catch {
      setWalletGuess("stored");
    }
  }, []);
  const clientRef = useRef<AutumnClient | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setLoad({ status: "loading" });
    setAttempt((a) => a + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      try {
        const client = clientRef.current ?? (await loadAutumnClient());
        if (!alive) return;
        if (!client) {
          setLoad({ status: "unconnected" });
          return;
        }
        clientRef.current = client;
        setIsPreview(client.isPreview);
        // One read at a time. A change while one runs queues exactly one more read, so a result that started
        // before the change (e.g. "Agent is running" read before Stop) can never be the last one shown.
        let running = false;
        let again = false;
        let seq = 0;
        const refresh = async () => {
          if (running) {
            again = true;
            return;
          }
          running = true;
          try {
            do {
              again = false;
              const mine = ++seq;
              try {
                const state = await client.getState();
                if (alive && mine === seq) setLoad({ status: "ready", client, state });
              } catch (e) {
                if (alive && mine === seq) setLoad({ status: "error", message: errorText(e), retry });
              }
            } while (again && alive);
          } finally {
            running = false;
          }
        };
        unsubscribe = client.subscribe(() => void refresh());
        await refresh();
      } catch (e) {
        if (alive) setLoad({ status: "error", message: errorText(e), retry });
      }
    })();

    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [attempt, retry]);

  return { ...load, isPreview, walletGuess };
}

/** Plain words for the Autumn server's machine codes (HttpError.code). */
const API_TEXT: Record<string, string> = {
  network: "The Autumn server could not be reached. Check your connection and try again.",
  chain_unavailable: "Celo's public node did not answer. Nothing was changed; try again in a few seconds.",
  not_visible: "Celo does not show the agent's key yet. Try again in a few seconds.",
  limits_mismatch: "The agent's key onchain does not have this plan's limits, so the plan was not started.",
  pending_plan_exists: "Another plan is waiting for your passkey approval. Try again in a minute.",
  pending_plan_granted: "Your wallet already granted the agent's key for a plan that is starting. Check again in a minute.",
  other_plan_active: "Another plan is still running for this wallet. Stop it first.",
  plan_stopped: "This plan was stopped.",
  no_such_plan: "The Autumn server does not know this plan any more.",
};

export function errorText(e: unknown): string {
  if (!(e instanceof Error) || !e.message) return "Something went wrong.";
  // Autumn's own errors are already plain sentences.
  if (e.name === "CheckAgainError" || e.name === "PasskeyError" || e.name === "BackupCodeError" || e.name === "WrongDoorError") return e.message;
  if (e instanceof ApiError) {
    if (e.code && API_TEXT[e.code]) return API_TEXT[e.code]!;
    if (e.status === 429) return "Too many requests from this network right now. Wait a few minutes and try again.";
    if (e.status >= 500 || e.status === 0) return "The Autumn server could not complete this right now. Nothing was changed; try again in a minute.";
    // 4xx answers are the server's own short sentences.
    return `The Autumn server refused this: ${e.message}.`;
  }
  // viem errors carry the whole request in `message`; `shortMessage` and `details` are the readable part.
  const v = e as Error & { shortMessage?: string; details?: string };
  if (typeof v.shortMessage === "string" && v.shortMessage) {
    if (/block is out of range/i.test(v.details ?? v.message)) return "Celo's public node did not answer in time. Wait a few seconds and try again.";
    if (/HTTP request failed|fetch failed|timed out|took too long/i.test(v.shortMessage)) return "Celo's public node did not answer. Nothing was changed; try again in a few seconds.";
    const text = v.details && v.details !== v.shortMessage ? `${v.shortMessage} ${v.details}` : v.shortMessage;
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }
  const m = e.message;
  if (/asset deficits/i.test(m)) return "The wallet does not hold enough for this amount plus the fee. Lower the amount (Max leaves room for the fee) and try again.";
  // Altana SDK and relay messages: developer text, reworded.
  if (/Session grant did not confirm/i.test(m)) return "The network has not confirmed the agent's key yet. Check again in a minute; nothing will be paid twice.";
  if (/^erc8004:/i.test(m)) return "The agent identity could not be registered right now. Nothing was paid; try again later.";
  if (/FAILED.*no receipt|refused before being broadcast/i.test(m)) return "The relay refused the transaction before sending it, so nothing was sent. Try again in a minute.";
  if (e.name === "AltanaError" || /wallet_prepareCalls|wallet_sendPreparedCalls|RPC Request failed|JSON-RPC|relay code|callsId/i.test(m)) {
    return "The Altana relay could not handle this right now. Nothing was sent; try again in a minute.";
  }
  // Our own sentences are short; anything long is a developer dump.
  if (m.length > 300 || /\n\s+at |Request body:|Raw Call Arguments/i.test(m)) return "Something went wrong. Nothing was sent; try again in a minute.";
  return m;
}
