import { stopPlanRequest } from "@autumn/agent";
import { handle, readBody, withService, notAllowed } from "@/server/autumn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Marks a plan stopped once the chain shows its session is no longer active. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(() => withService(async (svc) => stopPlanRequest(svc, id, await readBody(req))));
}

const refuse = notAllowed("POST");
export const GET = refuse;
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;
