/**
 * The production wiring (PgStorage + Celo reads, dry run) against forno and a
 * real Postgres. Read-only on chain: AUTUMN_EXECUTION is not "live", so the
 * runner has no executor. Needs TEST_DATABASE_URL and MAINNET_READS=1.
 */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPlan, createProductionRunner, migrate, PgStorage } from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url || process.env.MAINNET_READS !== "1")("production runner (dry run, mainnet reads)", () => {
  it("reads the chain, finds the never-granted session revoked, and stops the plan without sending", async () => {
    const encKey = randomBytes(32).toString("hex");
    const pool = new pg.Pool({ connectionString: url });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    const storage = new PgStorage(pool);
    const client = (await import("@autumn/core")).createCeloPublicClient();
    const head = await client.getBlock();
    const now = Number(head.timestamp);
    // GoldBuyer is not deployed: any address with no Bought events stands in for the log scan.
    const env = {
      DATABASE_URL: url,
      AUTUMN_KEY_ENCRYPTION_KEY: encKey,
      AUTUMN_GOLD_BUYER_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      AUTUMN_GOLD_BUYER_DEPLOY_BLOCK: String(head.number - 20_000n),
    };
    const wallet = getAddress(privateKeyToAccount(generatePrivateKey()).address);
    const { plan, sessionPublicKey, grant } = await createPlan(
      { storage, encryptionKey: Buffer.from(encKey, "hex"), goldBuyer: getAddress(env.AUTUMN_GOLD_BUYER_ADDRESS), now },
      { walletAddress: wallet, amountPerBuy: 5_000_000n, expiresAt: now + 30 * 86_400, dayOfWeek: 0, hourUtc: 0 },
    );
    await storage.activatePlan(plan.id, {
      walletAddress: wallet, publicKey: sessionPublicKey,
      permissions: { calls: grant.permissions.calls, spend: [{ limit: grant.periodCap.toString(), period: "week", token: grant.feeToken }] },
      expiry: grant.expiry,
    });
    await pool.end();

    const { runner, pool: p2, live } = createProductionRunner(env);
    try {
      expect(live).toBe(false);
      const report = await runner.tick();
      expect(report.plans).toEqual([{ planId: plan.id, decision: "stopped", reason: "the owner revoked the session", kind: "revoked" }]);
    } finally {
      await p2.end();
    }
  });
});
