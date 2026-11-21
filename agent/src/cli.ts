#!/usr/bin/env node
import pg from "pg";
import { createExecutor, createProductionService, serverConfigFromEnv, tickOnce } from "./production.js";
import { tryBuy } from "./probe.js";
import { migrate } from "./storage/pg.js";

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

const USAGE = `usage:
  autumn-agent migrate                       apply migrations/*.sql to DATABASE_URL
  autumn-agent tick                          one runner pass (sends only with AUTUMN_EXECUTION=live)
  autumn-agent try-buy <planId> <usdtUnits> --i-understand-this-sends
                                             refusal probe for docs/mainnet-run.md: sends one purchase
                                             that must be refused (over the cap, or after revoke)`;

async function main() {
  const cmd = process.argv[2];
  if (cmd === "migrate") {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      console.log(json({ applied: await migrate(pool) }));
    } finally {
      await pool.end();
    }
    return;
  }
  if (cmd === "tick") {
    console.log(json(await tickOnce()));
    return;
  }
  if (cmd === "try-buy") {
    const [planId, units, flag] = process.argv.slice(3);
    if (!planId || !units || !/^\d+$/.test(units) || flag !== "--i-understand-this-sends") {
      console.error(USAGE);
      process.exit(2);
    }
    const cfg = serverConfigFromEnv();
    if (!cfg.live) throw new Error("try-buy sends a transaction request: set AUTUMN_EXECUTION=live");
    const { deps, pool } = createProductionService();
    try {
      const r = await tryBuy({ ...deps, executor: createExecutor(cfg) }, planId, BigInt(units));
      console.log(json(r));
    } finally {
      await pool.end();
    }
    return;
  }
  console.error(USAGE);
  process.exit(2);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
