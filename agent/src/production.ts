import pg from "pg";
import { configFromEnv, type AutumnConfig } from "@autumn/core";
import type { Hex } from "viem";
import { createAltanaExecutor, createChainReader } from "./adapters.js";
import { parseEncryptionKey } from "./crypto.js";
import { createDirectExecutor } from "./direct.js";
import { createDirectPreparedExecutor } from "./directPrepared.js";
import { pgSendLock } from "./sendLock.js";
import type { ChainReader, SessionExecutor } from "./ports.js";
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
 * - AUTUMN_SUBMITTER: "relay" (default) sends through the Altana relay;
 *   "direct" submits the signed intent from the agent's own EOA with the
 *   ERC-8021 tag at the end of the calldata (docs/direct-submit.md). Direct
 *   needs AUTUMN_DIRECT_SUBMITTER_KEY (the EOA's private key, which pays gas
 *   in CELO) and optionally AUTUMN_DIRECT_INTENT_TTL_SECS (default 600).
 *   "direct-prepared" lets Altana's relay prepare and price the intent as
 *   today (the wallet still pays Altana's fee), signs it with the session key,
 *   and submits it from the same agent EOA with the tag at the end
 *   (docs/direct-submit.md section 5). It needs AUTUMN_DIRECT_SUBMITTER_KEY
 *   too; AUTUMN_DIRECT_INTENT_TTL_SECS does not apply (the relay sets expiry).
 */
export function serverConfigFromEnv(env: Env = process.env): {
  databaseUrl: string;
  cfg: AutumnConfig;
  encryptionKey: Buffer;
  live: boolean;
  logBlockRange?: bigint;
  submitter: Submitter;
} {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const cfg = configFromEnv(env);
  const encryptionKey = parseEncryptionKey(env.AUTUMN_KEY_ENCRYPTION_KEY);
  const range = env.AUTUMN_LOGS_BLOCK_RANGE;
  if (range !== undefined && !/^\d+$/.test(range)) throw new Error("AUTUMN_LOGS_BLOCK_RANGE must be a block count");
  const submitter = submitterFromEnv(env);
  return {
    databaseUrl: env.DATABASE_URL,
    cfg,
    encryptionKey,
    live: env.AUTUMN_EXECUTION === "live",
    ...(range ? { logBlockRange: BigInt(range) } : {}),
    submitter,
  };
}

/** Who sends purchases: the Altana relay (default) or the agent's own EOA. */
export type Submitter =
  | { kind: "relay" }
  | { kind: "direct"; key: Hex; intentTtlSecs?: number }
  | { kind: "direct-prepared"; key: Hex };

export function submitterFromEnv(env: Env): Submitter {
  const raw = env.AUTUMN_SUBMITTER;
  if (raw === undefined || raw === "" || raw === "relay") return { kind: "relay" };
  if (raw !== "direct" && raw !== "direct-prepared") throw new Error('AUTUMN_SUBMITTER must be "relay", "direct" or "direct-prepared"');
  const key = env.AUTUMN_DIRECT_SUBMITTER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`AUTUMN_SUBMITTER=${raw} needs AUTUMN_DIRECT_SUBMITTER_KEY (0x + 64 hex)`);
  if (raw === "direct-prepared") return { kind: "direct-prepared", key: key as Hex };
  const ttl = env.AUTUMN_DIRECT_INTENT_TTL_SECS;
  if (ttl !== undefined && !/^\d+$/.test(ttl)) throw new Error("AUTUMN_DIRECT_INTENT_TTL_SECS must be a number of seconds");
  return { kind: "direct", key: key as Hex, ...(ttl ? { intentTtlSecs: Number(ttl) } : {}) };
}

/**
 * The executor for the configured submitter. With a pool, the direct
 * submitter takes a Postgres advisory lock per agent EOA around each send, so
 * overlapping ticks (two cron runs, the CLI) sharing the EOA cannot reuse a
 * transaction nonce.
 */
export function createExecutor(
  c: ReturnType<typeof serverConfigFromEnv>,
  log?: (msg: string, data?: Record<string, unknown>) => void,
  pool?: pg.Pool,
): SessionExecutor {
  if (c.submitter.kind === "relay") return createAltanaExecutor(c.cfg.rpcUrl);
  if (c.submitter.kind === "direct-prepared") {
    return createDirectPreparedExecutor({
      rpcUrl: c.cfg.rpcUrl,
      submitterKey: c.submitter.key,
      goldBuyer: c.cfg.goldBuyer,
      ...(pool ? { sendLock: pgSendLock(pool) } : {}),
      ...(log ? { log } : {}),
    });
  }
  return createDirectExecutor({
    rpcUrl: c.cfg.rpcUrl,
    submitterKey: c.submitter.key,
    goldBuyer: c.cfg.goldBuyer,
    ...(pool ? { sendLock: pgSendLock(pool) } : {}),
    ...(c.submitter.intentTtlSecs !== undefined ? { intentTtlSecs: c.submitter.intentTtlSecs } : {}),
    ...(log ? { log } : {}),
  });
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
  const log = (msg: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...data }));
  const runner = createRunner({
    storage: new PgStorage(p),
    chain: chainFor(c),
    executor: c.live ? createExecutor(c, log, p) : null,
    encryptionKey: c.encryptionKey,
    goldBuyer: c.cfg.goldBuyer,
    log,
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
