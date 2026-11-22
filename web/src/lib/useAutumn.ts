"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadAutumnClient, type AutumnClient, type AutumnState } from "./autumn";

export type AutumnLoad =
  | { status: "loading" }
  | { status: "unconnected" }
  | { status: "error"; message: string; retry: () => void }
  | { status: "ready"; client: AutumnClient; state: AutumnState };

/** Current load state, plus whether the active client is the preview (known before its data loads). */
export function useAutumn(): AutumnLoad & { isPreview: boolean } {
  const [load, setLoad] = useState<AutumnLoad>({ status: "loading" });
  const [isPreview, setIsPreview] = useState(false);
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
        const refresh = async () => {
          try {
            const state = await client.getState();
            if (alive) setLoad({ status: "ready", client, state });
          } catch (e) {
            if (alive) setLoad({ status: "error", message: errorText(e), retry });
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

  return { ...load, isPreview };
}

export function errorText(e: unknown): string {
  if (!(e instanceof Error) || !e.message) return "Something went wrong.";
  // viem errors carry the whole request in `message`; `shortMessage` and `details` are the readable part.
  const v = e as Error & { shortMessage?: string; details?: string };
  if (typeof v.shortMessage === "string" && v.shortMessage) {
    if (/block is out of range/i.test(v.details ?? v.message)) return "Celo's public node did not answer in time. Wait a few seconds and try again.";
    return v.details && v.details !== v.shortMessage ? `${v.shortMessage} ${v.details}` : v.shortMessage;
  }
  if (/asset deficits/i.test(e.message)) return "The wallet does not hold enough for this amount plus the fee. Lower the amount (Max leaves room for the fee) and try again.";
  return e.message;
}
