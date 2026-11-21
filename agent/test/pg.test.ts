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
    expect(await migrate(pool)).toEqual(["001_init.sql", "002_periods.sql"]);
    expect(await migrate(pool)).toEqual([]);
    storage = new PgStorage(pool);
  });
  afterAll(async () => pool?.end());

  it("stores plans with encrypted keys, attempts as a lock, and the run log", async () => {
    const { privateKey, publicKey } = generateSessionKey();
    const id = randomUUID();
    const wallet = getAddress("0x2222222222222222222222222222222222222222");
    const plan = await storage.createPlan(
      { id, walletAddress: wallet, amountPerBuy: 5_000_000n, period: "week", feeAllowancePerBuy: 50_000n, dipBuy: false, dayOfWeek: 1, hourUtc: 9, expiresAt: 1_800_000_000, sessionPublicKey: publicKey, createdAt: 1_795_000_000 },
      encryptSessionKey(privateKey, id, key),
    );
    expect(plan).toMatchObject({ id, status: "pending_grant", walletAddress: wallet, amountPerBuy: 5_000_000n, period: "week" });
    expect(await storage.listActivePlans()).toEqual([]);

    const session = { walletAddress: wallet, publicKey, permissions: { calls: [], spend: [] }, expiry: 1_800_000_000 };
    expect(await storage.countPendingPlans(wallet, 0)).toBe(1);
    await storage.activatePlan(id, session, `0x${"AB".repeat(32)}`);
    await expect(storage.activatePlan(id, session)).rejects.toThrow();
    expect((await storage.getPlan(id))?.grantTxHash).toBe(`0x${"ab".repeat(32)}`);
    const [active] = await storage.listActivePlans();
    expect(active?.session).toEqual(session);

    const enc = await storage.getEncryptedSessionKey(id);
    expect(decryptSessionKey(enc!, id, key)).toBe(privateKey);

    const a = { planId: id, periodId: "2026-11-16", slot: "weekly" as const, startedAt: 1_795_000_100, amountIn: 5_000_000n, minOut: 1_393n };
    const [c1, c2] = await Promise.all([storage.claimAttempt(a), storage.claimAttempt(a)]);
    expect([c1, c2].filter(Boolean)).toHaveLength(1);
    const claimed = (c1 ?? c2)!;
    expect(claimed).toMatchObject({ status: "submitting", periodId: "2026-11-16", amountIn: 5_000_000n });
    expect(await storage.openAttempts(id)).toHaveLength(1);
    await storage.updateAttempt(claimed.id, { status: "not_bought", reason: "refused" });
    expect(await storage.countAttempts(id, "2026-11-16", "weekly", "not_bought")).toBe(1);
    const again = await storage.claimAttempt(a);
    expect(again).not.toBeNull();
    await storage.updateAttempt(again!.id, { status: "bought", txHash: "0xAB", out: 1_400n });
    expect(await storage.claimAttempt(a)).toBeNull();
    expect(await storage.creditedTxHashes(id)).toEqual(new Set(["0xab"]));

    const deferred = await storage.claimAttempt({ ...a, slot: "dip" });
    await storage.updateAttempt(deferred!.id, { status: "deferred", reason: "Price check not available right now, the agent will retry." });
    expect(await storage.claimAttempt({ ...a, slot: "dip" })).not.toBeNull(); // deferred does not hold the slot

    await storage.appendRunLog({ planId: id, periodId: "2026-11-16", at: 1_795_000_200, outcome: "bought", reason: "weekly purchase", txHash: "0xab", amountIn: 5_000_000n, out: 1_400n, kind: "weekly" });
    await storage.appendRunLog({ planId: id, periodId: "2026-11-16", at: 1_795_000_300, outcome: "skipped", reason: "x", kind: "twap_unavailable" });
    expect(await storage.lastRunLog(id)).toMatchObject({ outcome: "skipped", kind: "twap_unavailable", periodId: "2026-11-16" });
    expect((await storage.listRunLog([id], 10)).map((e) => e.kind)).toEqual(["twap_unavailable", "weekly"]);
    expect(await storage.listRunLog([], 10)).toEqual([]);

    expect((await storage.listPlansForWallet(wallet)).map((p) => p.id)).toEqual([id]);
    expect(await storage.countPendingPlans(wallet, 0)).toBe(0);
    await storage.stopPlan(id, "the owner revoked the session", 1_795_000_400, `0x${"cd".repeat(32)}`);
    expect(await storage.getPlan(id)).toMatchObject({ status: "stopped", stoppedAt: 1_795_000_400, stopTxHash: `0x${"cd".repeat(32)}` });
    expect(await storage.getPlan("not-a-uuid")).toBeNull();
  });

  it("stores a daily plan and its creation block", async () => {
    const { privateKey, publicKey } = generateSessionKey();
    const id = randomUUID();
    const p = await storage.createPlan(
      { id, walletAddress: getAddress("0x4444444444444444444444444444444444444444"), amountPerBuy: 1_000_000n, period: "day", feeAllowancePerBuy: 50_000n, dipBuy: true, dayOfWeek: 0, hourUtc: 7, expiresAt: 1_800_000_000, sessionPublicKey: publicKey, createdAt: 1_795_000_000, createdBlock: 83_400_000n },
      encryptSessionKey(privateKey, id, key),
    );
    expect(p).toMatchObject({ period: "day", createdBlock: 83_400_000n, dipBuy: true });
    await expect(pool.query("UPDATE plans SET period = 'month' WHERE id = $1", [id])).rejects.toThrow();
  });

  it("rejects malformed rows at the database", async () => {
    await expect(pool.query("INSERT INTO owners (wallet_address) VALUES ('0xNOPE')")).rejects.toThrow();
  });
});
