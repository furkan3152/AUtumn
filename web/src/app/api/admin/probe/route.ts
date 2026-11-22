import { createExecutor, createProductionService, cronAuthorized, parseProbeRequest, runAdminProbe, serverConfigFromEnv } from "@autumn/agent";
import { handle, json, readBody, withPool } from "@/server/autumn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Refusal probes for the funded mainnet run (docs/mainnet-run.md,
 * scripts/e2e-mainnet.mjs). POST { planId, kind } with kind "over-cap",
 * "outside-allowlist", "after-revoke" or "status".
 *
 * Protected exactly like /api/cron/tick: `Authorization: Bearer <CRON_SECRET>`
 * (or AUTUMN_CRON_SECRET), compared in constant time, 401 otherwise. The
 * secret is checked before the body is read or the database is touched.
 *
 * The request names only a plan and a probe kind. The calls, the amount and
 * the target are built on the server (agent/src/probe.ts), and a probe is
 * sent only when a fresh chain read shows it must be refused; see the
 * comment at the top of probe.ts for why it cannot buy beyond the plan or
 * move funds anywhere but through GoldBuyer.buy into the owner's wallet.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET || process.env.AUTUMN_CRON_SECRET;
  if (!cronAuthorized(req.headers.get("authorization"), secret)) return json({ error: "unauthorized" }, 401);
  return handle(async () => {
    const body = parseProbeRequest(await readBody(req)); // 400 before any database or chain access
    return withPool(async (pool) => {
      const cfg = serverConfigFromEnv(process.env);
      const { deps } = createProductionService(process.env, pool);
      const log = (msg: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...data }));
      const executor = cfg.live ? createExecutor(cfg, log, pool) : null;
      const result = await runAdminProbe({ ...deps, executor }, body);
      console.log(JSON.stringify({ msg: "admin probe", planId: result.planId, kind: result.kind, outcome: result.outcome, txHash: result.onchain.txHash }));
      return result;
    });
  });
}
