"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadGramClient, type GramClient, type GramState } from "./gram";

export type GramLoad =
  | { status: "loading" }
  | { status: "unconnected" }
  | { status: "error"; message: string; retry: () => void }
  | { status: "ready"; client: GramClient; state: GramState };

/** Current load state, plus whether the active client is the preview (known before its data loads). */
export function useGram(): GramLoad & { isPreview: boolean } {
  const [load, setLoad] = useState<GramLoad>({ status: "loading" });
  const [isPreview, setIsPreview] = useState(false);
  const clientRef = useRef<GramClient | null>(null);
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
        const client = clientRef.current ?? (await loadGramClient());
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
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong.";
}
