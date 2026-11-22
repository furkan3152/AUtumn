import { cronAuthorized } from "@autumn/agent";
import { json, tick, notAllowed } from "@/server/autumn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs the purchase runner once. The Worker's Cron Trigger (web/worker.ts)
 * calls it in-process with `Authorization: Bearer $CRON_SECRET`; a manual
 * trigger sends the same header with GET or POST. AUTUMN_CRON_SECRET is accepted as the secret's
 * name too (one of the two must be set, at least 16 characters).
 */
async function run(req: Request) {
  const secret = process.env.CRON_SECRET || process.env.AUTUMN_CRON_SECRET;
  if (!cronAuthorized(req.headers.get("authorization"), secret)) return json({ error: "unauthorized" }, 401);
  try {
    const { live, report } = await tick();
    return json({ live, report });
  } catch (e) {
    console.error(JSON.stringify({ msg: "tick failed", error: (e as Error).message }));
    return json({ error: (e as Error).message }, 500);
  }
}

export const GET = run;
export const POST = run;

const refuse = notAllowed("GET", "POST");
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;
