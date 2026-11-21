import { walletViewRequest } from "@autumn/agent";
import { handle, withService } from "@/server/autumn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A wallet's plans (no key material) and the agent's run log. */
export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  return handle(() => withService((svc) => walletViewRequest(svc, address)));
}
