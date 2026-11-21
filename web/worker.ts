/**
 * The Worker entry: OpenNext's generated fetch handler, plus a Cron Trigger
 * handler that runs the agent once (wrangler.jsonc, "triggers").
 *
 * The cron calls the app's own /api/cron/tick handler in-process (no network
 * hop, no public URL), so the tick runs the same code, with the same secret
 * check, as a manual `curl` to the route. It runs within the cron
 * invocation's limits, not an HTTP request's.
 */
// @ts-ignore `.open-next/worker.js` exists only after `opennextjs-cloudflare build`.
import { default as handler } from "./.open-next/worker.js";

type Env = { CRON_SECRET?: string; AUTUMN_CRON_SECRET?: string } & Record<string, unknown>;
type Ctx = { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void };
type Controller = { cron: string; scheduledTime: number };
type Handler = { fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> };

const app = handler as Handler;

export default {
  fetch: app.fetch,

  async scheduled(controller: Controller, env: Env, ctx: Ctx): Promise<void> {
    const secret = env.CRON_SECRET || env.AUTUMN_CRON_SECRET;
    if (!secret) throw new Error("CRON_SECRET is not set: the scheduled tick cannot authorise itself");
    const req = new Request("https://autumn.internal/api/cron/tick", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    const res = await app.fetch(req, env, ctx);
    const body = await res.text();
    console.log(JSON.stringify({ msg: "scheduled tick", cron: controller.cron, status: res.status, body: body.slice(0, 4000) }));
    // A thrown error marks the Cron Trigger run as failed in the dashboard and logs.
    if (!res.ok) throw new Error(`scheduled tick failed with HTTP ${res.status}`);
  },
};
