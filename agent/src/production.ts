import pg from "pg";
import { configFromEnv, type AutumnConfig } from "@autumn/core";
import { createAltanaExecutor, createChainReader } from "./adapters.js";
import { parseEncryptionKey } from "./crypto.js";
import type { ChainReader } from "./ports.js";
import { createRunner, type Runner } from "./runner.js";
import type { ServiceDeps } from "./service.js";
import { PgStorage } from "./storage/pg.js";

type Env = Record<string, string | undefined>;

/**
 * Server settings, from env:
 * - DATABASE_URL (Postgres, e.g. Neon's pooled connection string)
 * - AUTUMN_KEY_ENCRYPTION_KEY (32 bytes, hex or base64)
 * - AUTUMN_GOLD_BUYER_ADDRESS, AUTUMN_GOLD_BUYER_DEPLOY_BLOCK, AUTUMN_CELO_RPC_URL (optional)
 * - AUTUMN_EXECUTION=live to send purchases; anything else is a dry run
 * - AUTUMN_LOGS_BLOCK_RANGE (optional, default 5000: forno's eth_getLogs limit)
 */
export function serverConfigFromEnv(env: Env = process.env): {
  databaseUrl: string;
  cfg: AutumnConfig;
  encryptionKey: Buffer;
  live: boolean;
  logBlockRange?: bigint;
} {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const cfg = configFromEnv(env);
  const encryptionKey = parseEncryptionKey(env.AUTUMN_KEY_ENCRYPTION_KEY);
  const range = env.AUTUMN_LOGS_BLOCK_RANGE;
  if (range !== undefined && !/^\d+$/.test(range)) throw new Error("AUTUMN_LOGS_BLOCK_RANGE must be a block count");
  return {
    databaseUrl: env.DATABASE_URL,
    cfg,
    encryptionKey,
    live: env.AUTUMN_EXECUTION === "live",
    ...(range ? { logBlockRange: BigInt(range) } : {}),
  };
}

function chainFor(c: ReturnType<typeof serverConfigFromEnv>): ChainReader {
  return createChainReader(c.cfg, c.logBlockRange ? { logBlockRange: c.logBlockRange } : {});
}

/**
 * The runner as deployed: Postgres storage, Celo reads, the Altana SDK.
 *
 * Purchases are sent only when `AUTUMN_EXECUTION=live`. Any other value (or
 * none) is a dry run that decides and quotes but sends nothing, so a
 * misconfigured deployment cannot spend.
 */
export function createProductionRunner(env: Env = process.env, pool?: pg.Pool): { runner: Runner; pool: pg.Pool; live: boolean } {
  const c = serverConfigFromEnv(env);
  const p = pool ?? new pg.Pool({ connectionString: c.databaseUrl, max: 3 });
  const runner = createRunner({
    storage: new PgStorage(p),
    chain: chainFor(c),
    executor: c.live ? createAltanaExecutor(c.cfg.rpcUrl) : null,
    encryptionKey: c.encryptionKey,
    goldBuyer: c.cfg.goldBuyer,
    log: (msg, data) => console.log(JSON.stringify({ msg, ...data })),
  });
  return { runner, pool: p, live: c.live };
}

/** Dependencies of the owner-facing service (service.ts) over a shared pool. */
export function createProductionService(env: Env = process.env, pool?: pg.Pool): { deps: ServiceDeps; pool: pg.Pool; live: boolean } {
  const c = serverConfigFromEnv(env);
  const p = pool ?? new pg.Pool({ connectionString: c.databaseUrl, max: 3 });
  return {
    deps: { storage: new PgStorage(p), chain: chainFor(c), encryptionKey: c.encryptionKey, goldBuyer: c.cfg.goldBuyer },
    pool: p,
    live: c.live,
  };
}

/** One tick for a cron route or CLI; closes the pool afterwards unless one was passed in. */
export async function tickOnce(env: Env = process.env, pool?: pg.Pool) {
  const { runner, pool: p, live } = createProductionRunner(env, pool);
  try {
    return { live, report: await runner.tick() };
  } finally {
    if (!pool) await p.end();
  }
}
