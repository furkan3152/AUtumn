/**
 * PgStorage against a real Postgres. Runs only when TEST_DATABASE_URL is set
 * (a throwaway database: the test drops and recreates the schema).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { getAddress } from "viem";
import { decryptSessionKey, encryptSessionKey, generateSessionKey } from "../src/crypto.js";
import { migrate, PgStorage } from "../src/storage/pg.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgStorage", () => {
  let pool: pg.Pool;
  let storage: PgStorage;
  const key = randomBytes(32);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    expect(await migrate(pool)).toEqual(["001_init.sql"]);
    expect(await migrate(pool)).toEqual([]);
    storage = new PgStorage(pool);
  });
  afterAll(async () => pool?.end());

  it("stores plans with encrypted keys, attempts as a lock, and the run log", async () => {
    const { privateKey, publicKey } = generateSessionKey();
    const id = randomUUID();
    const wallet = getAddress("0x2222222222222222222222222222222222222222");
    const plan = await storage.createPlan(
      { id, walletAddress: wallet, amountPerWeek: 5_000_000n, feeAllowancePerBuy: 50_000n, dipBuy: false, dayOfWeek: 1, hourUtc: 9, expiresAt: 1_800_000_000, sessionPublicKey: publicKey, createdAt: 1_795_000_000 },
      encryptSessionKey(privateKey, id, key),
    );
    expect(plan).toMatchObject({ id, status: "pending_grant", walletAddress: wallet, amountPerWeek: 5_000_000n });
    expect(await storage.listActivePlans()).toEqual([]);

    const session = { walletAddress: wallet, publicKey, permissions: { calls: [], spend: [] }, expiry: 1_800_000_000 };
    await storage.activatePlan(id, session);
    await expect(storage.activatePlan(id, session)).rejects.toThrow();
    const [active] = await storage.listActivePlans();
    expect(active?.session).toEqual(session);

    const enc = await storage.getEncryptedSessionKey(id);
    expect(decryptSessionKey(enc!, id, key)).toBe(privateKey);

    const a = { planId: id, weekId: "2026-11-16", slot: "weekly" as const, startedAt: 1_795_000_100, amountIn: 5_000_000n, minOut: 1_393n };
    const [c1, c2] = await Promise.all([storage.claimAttempt(a), storage.claimAttempt(a)]);
    expect([c1, c2].filter(Boolean)).toHaveLength(1);
    const claimed = (c1 ?? c2)!;
    expect(claimed).toMatchObject({ status: "submitting", weekId: "2026-11-16", amountIn: 5_000_000n });
    expect(await storage.openAttempts(id)).toHaveLength(1);
    await storage.updateAttempt(claimed.id, { status: "not_bought", reason: "refused" });
    expect(await storage.countAttempts(id, "2026-11-16", "weekly", "not_bought")).toBe(1);
    const again = await storage.claimAttempt(a);
    expect(again).not.toBeNull();
    await storage.updateAttempt(again!.id, { status: "bought", txHash: "0xAB", out: 1_400n });
    expect(await storage.claimAttempt(a)).toBeNull();
    expect(await storage.creditedTxHashes(id)).toEqual(new Set(["0xab"]));

    await storage.appendRunLog({ planId: id, weekId: "2026-11-16", at: 1_795_000_200, outcome: "bought", reason: "weekly purchase", txHash: "0xab", amountIn: 5_000_000n, out: 1_400n });
    expect(await storage.lastRunLog(id)).toMatchObject({ outcome: "bought", out: 1_400n, weekId: "2026-11-16" });

    await storage.stopPlan(id, "the owner revoked the session");
    expect((await storage.getPlan(id))?.status).toBe("stopped");
  });

  it("rejects malformed rows at the database", async () => {
    await expect(pool.query("INSERT INTO owners (wallet_address) VALUES ('0xNOPE')")).rejects.toThrow();
  });
});
