import pg from "pg";
import { configFromEnv } from "@autumn/core";
import { createAltanaExecutor, createChainReader } from "./adapters.js";
import { parseEncryptionKey } from "./crypto.js";
import { createRunner, type Runner } from "./runner.js";
import { PgStorage } from "./storage/pg.js";

type Env = Record<string, string | undefined>;

/**
 * The runner as deployed: Postgres storage, Celo reads, the Altana SDK.
 *
 * Purchases are sent only when `AUTUMN_EXECUTION=live`. Any other value (or
 * none) is a dry run that decides and quotes but sends nothing, so a
 * misconfigured deployment cannot spend.
 */
export function createProductionRunner(env: Env = process.env): { runner: Runner; pool: pg.Pool; live: boolean } {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const cfg = configFromEnv(env);
  const encryptionKey = parseEncryptionKey(env.AUTUMN_KEY_ENCRYPTION_KEY);
  const live = env.AUTUMN_EXECUTION === "live";
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });
  const runner = createRunner({
    storage: new PgStorage(pool),
    chain: createChainReader(cfg, env.CELO_LOGS_BLOCK_RANGE ? { logBlockRange: BigInt(env.CELO_LOGS_BLOCK_RANGE) } : {}),
    executor: live ? createAltanaExecutor(cfg.rpcUrl) : null,
    encryptionKey,
    goldBuyer: cfg.goldBuyer,
    log: (msg, data) => console.log(JSON.stringify({ msg, ...data })),
  });
  return { runner, pool, live };
}

/** One tick for a cron route or CLI; closes the pool afterwards. */
export async function tickOnce(env: Env = process.env) {
  const { runner, pool, live } = createProductionRunner(env);
  try {
    return { live, report: await runner.tick() };
  } finally {
    await pool.end();
  }
}
