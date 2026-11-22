/**
 * The runner under load and under concurrency: many plans due in the same
 * hour, the relay's fee ceiling, the tick's time budget, and two ticks at
 * once (against Postgres when TEST_DATABASE_URL is set).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { getAddress, toHex, type Address } from "viem";
import { AltanaError } from "@altananetwork/sdk";
import { MIN_PURCHASE_SPACING_SECS, USDT, periodStart } from "@autumn/core";
import { createPlan } from "../src/plans.js";
import { createRunner, FEE_TOO_HIGH_REASON } from "../src/runner.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { migrate, PgStorage } from "../src/storage/pg.js";
import type { Storage } from "../src/storage/types.js";
import type { ExecuteResult } from "@altananetwork/sdk";
import { FakeChain, FakeExecutor, GOLD_BUYER, type ExecCall } from "./fakes.js";

const WED_NOON = Math.floor(Date.parse("2026-11-18T12:00:00Z") / 1000);
const AMOUNT = 5_000_000n;
const walletN = (i: number) => getAddress(toHex(0x1000 + i, { size: 20 })) as Address;

async function addPlan(storage: Storage, chain: FakeChain, key: Buffer, wallet: Address, period: "week" | "day" = "week") {
  const { plan, sessionPublicKey, grant } = await createPlan(
    { storage, encryptionKey: key, goldBuyer: GOLD_BUYER, now: chain.now },
    { walletAddress: wallet, amountPerBuy: AMOUNT, period, expiresAt: chain.now + 60 * 86_400, dayOfWeek: 2, hourUtc: 9 },
  );
  chain.cap = grant.periodCap;
  chain.period = grant.period;
  chain.expiry = grant.expiry;
  await storage.activatePlan(plan.id, {
    walletAddress: wallet,
    publicKey: sessionPublicKey,
    permissions: { calls: grant.permissions.calls, spend: grant.permissions.spend.map((s) => ({ limit: s.limit.toString(), period: s.period, token: s.token! })) },
    expiry: grant.expiry,
  });
  return plan;
}

/**
 * Lands each purchase and resets the fake account's spend: the fake shares
 * one account between wallets, real wallets each have their own cap.
 */
function confirmEach(chain: FakeChain, delayMs: number) {
  return async (c: ExecCall): Promise<ExecuteResult> => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const p = chain.land(c.session.walletAddress, AMOUNT, 1_400n);
    chain.spent = 0n;
    chain.usdt = 100_000_000n;
    return { callsId: "0x01", transactionHash: p.txHash, status: "CONFIRMED", statusCode: 200 };
  };
}

function world(storage: Storage = new MemoryStorage()) {
  const chain = new FakeChain(WED_NOON);
  // The fake account is shared by every key: a big cap so each plan sees room (limits are per plan in reality).
  const executor = new FakeExecutor(chain);
  const key = randomBytes(32);
  const runner = (over: Partial<Parameters<typeof createRunner>[0]> = {}) =>
    createRunner({ storage, chain, executor, encryptionKey: key, goldBuyer: GOLD_BUYER, recheckAttempts: 1, recheckDelayMs: 0, sleep: async () => {}, ...over });
  return { storage, chain, executor, key, runner };
}

describe("relay fee ceiling", () => {
  it("refuses with a recorded reason when the relay's quote is above the per-buy fee allowance, and buys later when it is not", async () => {
    const w = world();
    const plan = await addPlan(w.storage, w.chain, w.key, walletN(1));
    w.executor.fee = 50_001n; // allowance is 50 000 (0.05 USD₮)
    const r = (await w.runner().tick()).plans[0]!;
    expect(r).toMatchObject({ decision: "skipped", kind: "fee_too_high", reason: FEE_TOO_HIGH_REASON });
    expect(w.executor.calls).toHaveLength(0);
    expect((w.storage as MemoryStorage).attempts).toHaveLength(0); // nothing claimed: the period is still open
    expect((w.storage as MemoryStorage).runLog.at(-1)).toMatchObject({ planId: plan.id, outcome: "skipped", kind: "fee_too_high" });

    w.chain.now += 3600;
    await w.runner().tick();
    expect((w.storage as MemoryStorage).runLog.filter((e) => e.kind === "fee_too_high")).toHaveLength(1); // logged once per period

    w.executor.fee = 50_000n; // exactly the allowance is fine
    w.chain.now += 3600;
    expect((await w.runner().tick()).plans[0]).toMatchObject({ decision: "bought" });
  });

  it("refuses a fee in another token, and treats a failed quote as a skip, not a send", async () => {
    const w = world();
    await addPlan(w.storage, w.chain, w.key, walletN(1));
    w.executor.fee = async () => ({ fee: 1n, feeToken: "0x0000000000000000000000000000000000000000" });
    expect((await w.runner().tick()).plans[0]).toMatchObject({ decision: "skipped", kind: "fee_too_high" });
    w.executor.fee = async () => {
      throw new AltanaError({ code: "relay_unreachable", statement: "s", action: "a" });
    };
    expect((await w.runner().tick()).plans[0]).toMatchObject({ decision: "skipped", kind: "relay_failure" });
    w.executor.fee = async () => {
      throw new AltanaError({ code: "unknown", statement: "s", action: "a", relayMessage: "execution reverted: OLD" });
    };
    expect((await w.runner().tick()).plans[0]).toMatchObject({ decision: "skipped", kind: "twap_unavailable" });
    expect(w.executor.calls).toHaveLength(0);
  });

  it("skips when the cap cannot hold the purchase plus the quoted fee", async () => {
    const w = world();
    await addPlan(w.storage, w.chain, w.key, walletN(1));
    w.chain.spent = 30_000n; // 5.05 cap − 0.03 spent = 5.02 left: enough headroom (0.01), not enough for a 0.03 fee
    w.executor.fee = 30_000n;
    expect((await w.runner().tick()).plans[0]).toMatchObject({ decision: "skipped", kind: "cap_exceeded", reason: expect.stringMatching(/and its fee/) });
  });
});

describe("runner capacity", () => {
  it("handles 16 plans due in the same hour: bounded parallelism, never two sends for one wallet at once, one cheap scan", async () => {
    const w = world();
    for (let i = 0; i < 16; i++) await addPlan(w.storage, w.chain, w.key, walletN(i % 8)); // two plans for each of 8 wallets
    w.executor.behaviour = confirmEach(w.chain, 5);
    const report = await w.runner({ concurrency: 4 }).tick();
    expect(report.plans).toHaveLength(16);
    expect(report.plans.filter((p) => p.decision === "error")).toEqual([]);
    expect(w.executor.maxInFlightPerWallet).toBe(1);
    expect(w.executor.maxInFlight).toBeGreaterThan(1);
    expect(w.executor.maxInFlight).toBeLessThanOrEqual(4);
    // One shared scan per tick, from the start of the current week less the purchase spacing (not per plan).
    expect(w.chain.scans[0]).toBe(periodStart(WED_NOON, "week") - MIN_PURCHASE_SPACING_SECS.week);
    expect(w.chain.scans.length).toBeLessThanOrEqual(1 + 16); // one shared scan, plus at most one recheck per send
  });

  it("scans a daily-only tick from today's start less the spacing, or from an older open attempt", async () => {
    const w = world();
    const plan = await addPlan(w.storage, w.chain, w.key, walletN(1), "day");
    await w.runner().tick();
    expect(w.chain.scans[0]).toBe(periodStart(WED_NOON, "day") - MIN_PURCHASE_SPACING_SECS.day);
    await w.storage.claimAttempt({ planId: plan.id, periodId: "2026-11-17", slot: "weekly", startedAt: WED_NOON - 86_400, amountIn: AMOUNT, minOut: 1n });
    w.chain.scans.length = 0;
    await w.runner().tick();
    expect(w.chain.scans[0]).toBe(WED_NOON - 86_400 - 60);
  });

  it("returns inside its time budget and leaves the plans it did not reach for the next tick", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) await addPlan(w.storage, w.chain, w.key, walletN(i));
    let t = 0;
    const clock = () => t;
    const confirm = confirmEach(w.chain, 0);
    w.executor.behaviour = async (c) => {
      t += 40_000; // each send takes 40 s of wall time
      return confirm(c);
    };
    const report = await w.runner({ concurrency: 1, timeBudgetMs: 120_000, minPlanMs: 45_000, clock }).tick();
    const d = report.plans.map((p) => p.decision);
    expect(d.filter((x) => x === "bought")).toHaveLength(2);
    expect(d.filter((x) => x === "deferred")).toHaveLength(3);
    expect(t).toBeLessThanOrEqual(120_000);
    // The next tick picks up the rest.
    t = 0;
    const next = await w.runner({ concurrency: 1, timeBudgetMs: 400_000, clock }).tick();
    expect(next.plans.filter((p) => p.decision === "bought")).toHaveLength(3);
  });

  it("stops waiting for a slow relay before the budget ends and leaves the attempt open for the chain to settle", async () => {
    const w = world();
    await addPlan(w.storage, w.chain, w.key, walletN(1));
    w.executor.behaviour = () => new Promise(() => {}); // the relay never answers
    const report = await w.runner({ timeBudgetMs: 60, minPlanMs: 0, finishMarginMs: 10 }).tick();
    expect(report.plans[0]).toMatchObject({ decision: "ambiguous" });
    expect((w.storage as MemoryStorage).attempts[0]?.status).toBe("ambiguous");
    w.executor.behaviour = "confirm";
    w.chain.now += 60;
    expect((await w.runner().tick()).plans[0]).toMatchObject({ decision: "waiting_on_earlier_attempt" });
    expect(w.executor.calls).toHaveLength(1);
  });

  it("isolates failures per plan, including a failed shared purchase scan, and always returns", async () => {
    const w = world();
    await addPlan(w.storage, w.chain, w.key, walletN(1));
    await addPlan(w.storage, w.chain, w.key, walletN(2));
    w.chain.purchasesSince = async () => {
      throw new Error("eth_getLogs: rate limited");
    };
    const report = await w.runner().tick();
    expect(report.plans.map((p) => p.decision)).toEqual(["error", "error"]);
    expect(report.plans[0]!.reason).toMatch(/purchase history could not be read: eth_getLogs/);
    expect(w.executor.calls).toHaveLength(0);
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("concurrent ticks against Postgres", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    // Its own schema, so this file can run alongside pg.test.ts (which resets "public").
    const setup = new pg.Pool({ connectionString: url, max: 1 });
    await setup.query("DROP SCHEMA IF EXISTS autumn_capacity CASCADE; CREATE SCHEMA autumn_capacity;");
    await setup.end();
    pool = new pg.Pool({ connectionString: url, max: 10, options: "-c search_path=autumn_capacity,public" });
    await migrate(pool);
  });
  afterAll(async () => pool?.end());

  it("two ticks at once over the same plans send each purchase once", async () => {
    const storage = new PgStorage(pool);
    const w = world(storage);
    for (let i = 0; i < 6; i++) await addPlan(storage, w.chain, w.key, walletN(100 + i));
    w.executor.behaviour = confirmEach(w.chain, 30);
    const [a, b] = await Promise.all([w.runner().tick(), w.runner().tick()]);
    const all = [...a.plans, ...b.plans];
    expect(all.filter((p) => p.decision === "bought")).toHaveLength(6);
    expect(all.filter((p) => p.decision === "error")).toEqual([]);
    expect(w.executor.calls).toHaveLength(6);
    expect(new Set(w.executor.calls.map((c) => c.session.walletAddress)).size).toBe(6);
    const rows = await pool.query("SELECT plan_id, count(*) AS n FROM purchase_attempts WHERE status = 'bought' GROUP BY plan_id");
    expect(rows.rows.every((r) => Number(r.n) === 1)).toBe(true);
    // And again: nothing more is sent this week.
    const [c, d] = await Promise.all([w.runner().tick(), w.runner().tick()]);
    expect([...c.plans, ...d.plans].every((p) => p.decision === "already_bought")).toBe(true);
    expect(w.executor.calls).toHaveLength(6);
  });

  it("ten parallel claims on one slot: exactly one wins", async () => {
    const storage = new PgStorage(pool);
    const w = world(storage);
    const plan = await addPlan(storage, w.chain, w.key, walletN(200));
    const a = { planId: plan.id, periodId: "2026-11-16", slot: "weekly" as const, startedAt: WED_NOON, amountIn: AMOUNT, minOut: 1n };
    const results = await Promise.all(Array.from({ length: 10 }, () => storage.claimAttempt(a)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

// USDT import keeps the fee-token default visible in this file.
void USDT;
