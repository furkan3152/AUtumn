import { createPlanRequest } from "@autumn/agent";
import { handle, readBody, service } from "@/server/autumn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Creates a pending plan and its session key; returns only the public key and the exact grant. */
export async function POST(req: Request) {
  return handle(async () => createPlanRequest(service(), await readBody(req)));
}
