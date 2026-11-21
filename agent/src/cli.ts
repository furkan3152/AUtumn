#!/usr/bin/env node
import pg from "pg";
import { migrate } from "./storage/pg.js";
import { tickOnce } from "./production.js";

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

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
  console.error("usage: autumn-agent <migrate|tick>");
  process.exit(2);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
