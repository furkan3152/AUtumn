import { cronAuthorized, tickOnce } from "@autumn/agent";
import { json, pool } from "@/server/autumn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** One tick waits for the relay (up to ~4 min per purchase in the SDK). Vercel caps this by plan. */
export const maxDuration = 300;

/**
 * Runs the purchase runner once. Vercel Cron calls GET with
 * `Authorization: Bearer $CRON_SECRET`; a manual trigger sends the same
 * header with GET or POST. AUTUMN_CRON_SECRET is accepted as the secret's
 * name too (one of the two must be set, at least 16 characters).
 */
async function run(req: Request) {
  const secret = process.env.CRON_SECRET || process.env.AUTUMN_CRON_SECRET;
  if (!cronAuthorized(req.headers.get("authorization"), secret)) return json({ error: "unauthorized" }, 401);
  try {
    const { live, report } = await tickOnce(process.env, pool());
    return json({ live, report });
  } catch (e) {
    console.error(JSON.stringify({ msg: "tick failed", error: (e as Error).message }));
    return json({ error: (e as Error).message }, 500);
  }
}

export const GET = run;
export const POST = run;
