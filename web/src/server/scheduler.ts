/**
 * In-process scheduler for hosts that run the app as one long-lived Node
 * server and have no cron of their own. Enabled with AUTUMN_SCHEDULER=internal.
 *
 * It runs the purchase tick once per UTC hour and, when AUTUMN_KEEP_AWAKE_URL
 * is set, requests that URL every ten minutes so a host that suspends idle
 * services keeps this one running. The tick is the same one the cron route
 * runs; the runner's own locks make an overlapping run harmless.
 */
import "server-only";
import { tick } from "./autumn";

const MINUTE = 60_000;
const TICK_AFTER_MINUTE = 5;

type State = { started?: boolean; lastHour?: number; running?: boolean };
const g = globalThis as unknown as { __autumnScheduler?: State };
const state: State = (g.__autumnScheduler ??= {});

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ msg, ...extra }));
}

async function runTick(hour: number) {
  if (state.running) return;
  state.running = true;
  try {
    const { live, report } = await tick();
    state.lastHour = hour;
    log("scheduled tick done", { live, report });
  } catch (e) {
    // Leave lastHour unset so the next minute retries.
    log("scheduled tick failed", { error: (e as Error).message });
  } finally {
    state.running = false;
  }
}

export function startScheduler() {
  if (state.started) return;
  state.started = true;
  log("internal scheduler started");

  setInterval(() => {
    const now = new Date();
    const hour = Math.floor(now.getTime() / (60 * MINUTE));
    if (state.lastHour !== hour && now.getUTCMinutes() >= TICK_AFTER_MINUTE) void runTick(hour);
  }, MINUTE).unref();

  const keepAwake = process.env.AUTUMN_KEEP_AWAKE_URL;
  if (keepAwake) {
    setInterval(() => {
      fetch(keepAwake, { cache: "no-store" }).catch((e) => log("keep-awake request failed", { error: (e as Error).message }));
    }, 10 * MINUTE).unref();
  }
}
