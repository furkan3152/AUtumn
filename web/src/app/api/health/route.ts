import { json, serverConfigured } from "@/server/autumn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the server has its settings, and whether the agent sends purchases (AUTUMN_EXECUTION=live). */
export async function GET() {
  const c = serverConfigured();
  return json({ configured: c.configured, live: c.live });
}
