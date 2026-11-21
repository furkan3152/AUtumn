import { activatePlanRequest } from "@autumn/agent";
import { handle, readBody, withService } from "@/server/autumn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Activates a plan once the chain shows the wallet granted its key with the exact limits. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(() => withService(async (svc) => activatePlanRequest(svc, id, await readBody(req))));
}
