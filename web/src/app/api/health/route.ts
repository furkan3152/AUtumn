import { json, serverConfigured, notAllowed } from "@/server/autumn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the server has its settings, and whether the agent sends purchases (AUTUMN_EXECUTION=live). */
export async function GET() {
  const c = serverConfigured();
  return json({ configured: c.configured, live: c.live });
}

const refuse = notAllowed("GET");
export const POST = refuse;
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;
