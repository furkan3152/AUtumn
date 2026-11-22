import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { getAddress, type Address } from "viem";
import { AltanaError } from "@altananetwork/sdk";
import { planToSessionGrant, weekStart } from "@autumn/core";
import { createPlan } from "../src/plans.js";
import { createRunner } from "../src/runner.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { FakeChain, FakeExecutor, GOLD_BUYER } from "./fakes.js";

const WALLET = getAddress("0x2222222222222222222222222222222222222222") as Address;
// Wednesday 2026-11-18 12:00 UTC.
const WED_NOON = Math.floor(Date.parse("2026-11-18T12:00:00Z") / 1000);
const AMOUNT = 5_000_000n;

async function setup(opts: { dipBuy?: boolean; dayOfWeek?: number; hourUtc?: number; now?: number; period?: "day" | "week" } = {}) {
  const now = opts.now ?? WED_NOON;
  const storage = new MemoryStorage();
  const chain = new FakeChain(now);
  const executor = new FakeExecutor(chain);
  const encryptionKey = randomBytes(32);
  const { plan, sessionPublicKey, grant } = await createPlan(
    { storage, encryptionKey, goldBuyer: GOLD_BUYER, now },
    { walletAddress: WALLET, amountPerBuy: AMOUNT, period: opts.period ?? "week", expiresAt: now + 60 * 86_400, dayOfWeek: opts.dayOfWeek ?? 1, hourUtc: opts.hourUtc ?? 9, dipBuy: !!opts.dipBuy },
  );
  chain.cap = grant.periodCap;
  chain.period = grant.period;
  chain.expiry = grant.expiry;
  // The browser's grant, as the SDK serializes it.
  await storage.activatePlan(plan.id, {
    walletAddress: WALLET,
    publicKey: sessionPublicKey,
    permissions: {
      calls: grant.permissions.calls,
      spend: grant.permissions.spend.map((s) => ({ limit: s.limit.toString(), period: s.period, token: s.token! })),
    },
    expiry: grant.expiry,
  });
  const runner = createRunner({
    storage, chain, executor, encryptionKey, goldBuyer: GOLD_BUYER,
    recheckAttempts: 2, recheckDelayMs: 0, ambiguityHoldSecs: 1800, sleep: async () => {},
  });
  return { storage, chain, executor, runner, plan, encryptionKey, grant, sessionPublicKey };
}

const only = async (r: { tick: () => Promise<{ plans: any[] }> }) => (await r.tick()).plans[0];

describe("runner", () => {
  it("makes a new plan's first purchase at once, then does nothing before the plan's due time in the week", async () => {
    const { runner, executor, chain } = await setup({ dayOfWeek: 4, hourUtc: 9 }); // due Friday 09:00
    expect(await only(runner)).toMatchObject({ decision: "bought" });
    chain.now = Math.floor(Date.parse("2026-11-23T10:00:00Z") / 1000); // next Monday: a new week, due Friday
    expect(await only(runner)).toMatchObject({ decision: "not_due" });
    expect(executor.calls).toHaveLength(1);
  });

  it("buys a weekly plan created on Sunday 23:05 UTC at the next tick, not a week later", async () => {
    const sun = Math.floor(Date.parse("2026-11-22T23:05:00Z") / 1000);
    const { runner, executor, chain } = await setup({ now: sun, dayOfWeek: 6, hourUtc: 23 });
    chain.now = Math.floor(Date.parse("2026-11-23T00:04:00Z") / 1000); // the tick lands after the Monday reset
    expect(await only(runner)).toMatchObject({ decision: "bought" });
    expect(executor.calls).toHaveLength(1);
  });

  it("keeps 12 hours between a daily catch-up purchase late in the day and the next day's purchase", async () => {
    const created = Math.floor(Date.parse("2026-11-20T01:00:00Z") / 1000);
    const { runner, executor, chain } = await setup({ now: created, period: "day", hourUtc: 1 });
    expect(await only(runner)).toMatchObject({ decision: "bought" }); // first purchase, 20 Nov 01:00
    chain.now = Math.floor(Date.parse("2026-11-21T23:50:00Z") / 1000); // the runner was away all of 21 Nov: catch-up
    chain.spent = 0n; // the fake does not reset the daily counter by itself
    expect(await only(runner)).toMatchObject({ decision: "bought" });
    chain.now = Math.floor(Date.parse("2026-11-22T01:05:00Z") / 1000); // due 01:00, but only 75 minutes later
    expect(await only(runner)).toMatchObject({ decision: "not_due" });
    chain.now = Math.floor(Date.parse("2026-11-22T11:51:00Z") / 1000);
    chain.spent = 0n; // the fake does not reset the daily counter by itself
    expect(await only(runner)).toMatchObject({ decision: "bought" });
    expect(executor.calls).toHaveLength(3);
  });

  it("buys once when due, with the decrypted session key and the exact two calls", async () => {
    const { runner, executor, storage, chain, plan } = await setup();
    const r = await only(runner);
    expect(r).toMatchObject({ decision: "bought", slot: "weekly", amountIn: AMOUNT });
    expect(executor.calls).toHaveLength(1);
    const sent = executor.calls[0]!;
    expect(sent.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent.calls.map((c) => c.to)).toEqual([getAddress("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"), GOLD_BUYER]);
    expect(storage.attempts[0]).toMatchObject({ status: "bought", txHash: chain.purchases[0]!.txHash });
    expect(storage.runLog.at(-1)).toMatchObject({ planId: plan.id, outcome: "bought", txHash: chain.purchases[0]!.txHash, out: 1_400n });
  });

  it("never buys twice in a week across repeated ticks", async () => {
    const { runner, executor, chain } = await setup();
    await runner.tick();
    chain.now += 3600;
    expect(await only(runner)).toMatchObject({ decision: "already_bought" });
    chain.now += 86_400 * 3; // Saturday
    expect(await only(runner)).toMatchObject({ decision: "already_bought" });
    expect(executor.calls).toHaveLength(1);
  });

  it("buys again after the Monday 00:00 UTC reset", async () => {
    const { runner, executor, chain } = await setup();
    await runner.tick();
    chain.now = weekStart(WED_NOON) + 604_800 + 86_400 + 9 * 3600 + 1; // next Tuesday 09:00:01 (plan: Tuesday 09:00)
    chain.spent = 0n;
    expect(await only(runner)).toMatchObject({ decision: "bought" });
    expect(executor.calls).toHaveLength(2);
  });

  it("decides from the chain: a purchase the database never saw blocks the week", async () => {
    const { runner, executor, chain } = await setup();
    chain.land(WALLET, AMOUNT, 1_400n, WED_NOON + 60); // e.g. a crash after send, before any DB write
    chain.now = WED_NOON + 120;
    expect(await only(runner)).toMatchObject({ decision: "already_bought" });
    expect(executor.calls).toHaveLength(0);
  });

  it("two concurrent ticks send once", async () => {
    const { storage, chain, executor, encryptionKey } = await setup();
    executor.delayMs = 20;
    const mk = () => createRunner({ storage, chain, executor, encryptionKey, goldBuyer: GOLD_BUYER, recheckAttempts: 1, recheckDelayMs: 0, sleep: async () => {} });
    const [a, b] = await Promise.all([mk().tick(), mk().tick()]);
    const decisions = [a.plans[0]!.decision, b.plans[0]!.decision].sort();
    expect(decisions).toEqual(["bought", "waiting_on_earlier_attempt"]);
    expect(executor.calls).toHaveLength(1);
  });

  it("skips with a recorded reason when the wallet lacks USD₮, once per week", async () => {
    const { runner, executor, storage, chain } = await setup();
    chain.usdt = 4_000_000n;
    expect(await only(runner)).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/enough USD₮/) });
    chain.now += 3600;
    await runner.tick();
    expect(executor.calls).toHaveLength(0);
    expect(storage.runLog.filter((e) => e.outcome === "skipped")).toHaveLength(1);
    chain.usdt = 10_000_000n;
    expect(await only(runner)).toMatchObject({ decision: "bought" });
  });

  it("skips when the remaining weekly cap cannot cover the amount plus send headroom", async () => {
    const { runner, executor, chain } = await setup();
    chain.spent = 100_000n; // e.g. an earlier fee drew on the cap
    expect(await only(runner)).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/weekly cap/) });
    expect(executor.calls).toHaveLength(0);
  });

  it("skips when the quote is worse than the bound", async () => {
    const { runner, executor, storage, chain } = await setup();
    chain.quoteWithin = false;
    expect(await only(runner)).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/price check failed/) });
    expect(executor.calls).toHaveLength(0);
    expect(storage.runLog.at(-1)?.outcome).toBe("skipped");
  });

  it("stops the plan when the session was revoked onchain", async () => {
    const { runner, executor, storage, chain, plan } = await setup();
    chain.status = "revoked";
    expect(await only(runner)).toMatchObject({ decision: "stopped", reason: expect.stringMatching(/revoked/) });
    expect((await storage.getPlan(plan.id))?.status).toBe("stopped");
    expect(executor.calls).toHaveLength(0);
    expect((await runner.tick()).plans).toHaveLength(0);
  });

  it("stops the plan when the session expired", async () => {
    const { runner, storage, chain, plan } = await setup();
    chain.status = "expired";
    expect(await only(runner)).toMatchObject({ decision: "stopped", reason: expect.stringMatching(/expired/) });
    expect((await storage.getPlan(plan.id))?.stoppedReason).toMatch(/expired/);
  });

  it("ambiguous relay error, then the chain shows the buy landed: records it and does not retry", async () => {
    const { runner, executor, storage, chain } = await setup();
    executor.behaviour = "throw-landed";
    expect(await only(runner)).toMatchObject({ decision: "bought", txHash: chain.purchases[0]!.txHash });
    expect(executor.calls).toHaveLength(1);
    expect(storage.attempts[0]?.status).toBe("bought");
    chain.now += 3600;
    expect(await only(runner)).toMatchObject({ decision: "already_bought" });
    expect(executor.calls).toHaveLength(1);
  });

  it("ambiguous relay error with nothing onchain: waits, and resolves from the chain later", async () => {
    const { runner, executor, storage, chain } = await setup();
    executor.behaviour = "throw-lost";
    expect(await only(runner)).toMatchObject({ decision: "ambiguous" });
    expect(storage.attempts[0]?.status).toBe("ambiguous");

    chain.now += 300; // inside the hold: no second send
    expect(await only(runner)).toMatchObject({ decision: "waiting_on_earlier_attempt" });
    expect(executor.calls).toHaveLength(1);

    // The original intent lands late.
    chain.land(WALLET, AMOUNT, 1_400n, chain.now);
    chain.now += 60;
    expect(await only(runner)).toMatchObject({ decision: "already_bought" });
    expect(storage.attempts[0]?.status).toBe("bought");
    expect(executor.calls).toHaveLength(1);
  });

  it("an unresolved attempt with nothing onchain after the hold frees the slot for one new attempt", async () => {
    const { runner, executor, storage, chain } = await setup();
    executor.behaviour = "pending-lost";
    expect(await only(runner)).toMatchObject({ decision: "ambiguous" });
    chain.now += 1801;
    executor.behaviour = "confirm";
    expect(await only(runner)).toMatchObject({ decision: "bought" });
    expect(storage.attempts.map((a) => a.status)).toEqual(["not_bought", "bought"]);
    expect(executor.calls).toHaveLength(2);
  });

  it("a crash between claim and send is treated as unknown, not as not-bought", async () => {
    const { runner, executor, storage, chain, plan } = await setup();
    await storage.claimAttempt({ planId: plan.id, periodId: "2026-11-16", slot: "weekly", startedAt: chain.now - 10, amountIn: AMOUNT, minOut: 1n });
    expect(await only(runner)).toMatchObject({ decision: "waiting_on_earlier_attempt" });
    expect(executor.calls).toHaveLength(0);
  });

  it("a cap refusal from the relay is a definite failure: recorded, plan kept", async () => {
    const { runner, executor, storage, plan } = await setup();
    executor.behaviour = async () => {
      throw new AltanaError({ code: "spend_limit_exceeded", statement: "s", action: "a" });
    };
    expect(await only(runner)).toMatchObject({ decision: "failed", kind: "cap_exceeded", reason: expect.stringMatching(/limit you set/) });
    expect(storage.attempts[0]?.status).toBe("not_bought");
    expect((await storage.getPlan(plan.id))?.status).toBe("active");
  });

  it("a revoked-key refusal stops the plan only when the chain agrees", async () => {
    const { runner, executor, storage, chain, plan } = await setup();
    executor.behaviour = async () => {
      throw new AltanaError({ code: "unknown", statement: "s", action: "a", relayMessage: "key hash 0xabc is unknown" });
    };
    expect(await only(runner)).toMatchObject({ decision: "failed" });
    expect((await storage.getPlan(plan.id))?.status).toBe("active");
    executor.behaviour = async () => {
      chain.status = "revoked";
      throw new AltanaError({ code: "unknown", statement: "s", action: "a", relayMessage: "key hash 0xabc is unknown" });
    };
    expect(await only(runner)).toMatchObject({ decision: "stopped" });
  });

  it("an onchain revert (FAILED 500) is not bought, and stops retrying after 3 failures in a week", async () => {
    const { runner, executor, chain } = await setup();
    executor.behaviour = async () => ({ callsId: "0x01", status: "FAILED", statusCode: 500 });
    for (let i = 0; i < 3; i++) {
      expect(await only(runner)).toMatchObject({ decision: "failed" });
      chain.now += 600;
    }
    expect(await only(runner)).toMatchObject({ decision: "skipped", kind: "too_many_failures", reason: expect.stringMatching(/3 attempts failed/) });
    expect(executor.calls).toHaveLength(3);
  });

  it("refuses to act when the onchain session limits differ from the plan", async () => {
    const { runner, executor, chain } = await setup();
    chain.allowedCalls = [...chain.allowedCalls, { target: GOLD_BUYER, selector: "0xdeadbeef" }];
    expect(await only(runner)).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/allowlist/) });
    chain.allowedCalls = chain.allowedCalls.slice(0, 3);
    // Any function of GoldBuyer instead of buy: only the pinned Orchestrator may carry the any-selector wildcard.
    const base = chain.allowedCalls;
    chain.allowedCalls = [base[0]!, { target: GOLD_BUYER, selector: "0x32323232" }, base[2]!];
    expect(await only(runner)).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/any function of/) });
    // Without the Orchestrator entry the allowlist is not what a real grant stores.
    chain.allowedCalls = base.slice(0, 2);
    expect(await only(runner)).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/allowlist differs/) });
    chain.allowedCalls = base;
    chain.cap = 99_000_000n;
    expect(await only(runner)).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/weekly cap differs/) });
    chain.cap = 5_050_000n;
    chain.period = "day";
    expect(await only(runner)).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/spend period differs/) });
    chain.period = "week";
    chain.expiry += 1;
    expect(await only(runner)).toMatchObject({ decision: "skipped", reason: expect.stringMatching(/expiry differs/) });
    expect(executor.calls).toHaveLength(0);
  });

  it("dip rule: buys once more in the week only at ≥2% below the last purchase price, inside the cap", async () => {
    const { runner, executor, chain, grant } = await setup({ dipBuy: true });
    expect(grant.periodCap).toBe(2n * (AMOUNT + 50_000n));
    expect(await only(runner)).toMatchObject({ decision: "bought", slot: "weekly" });
    chain.now += 3600;
    chain.quoteOut = 1_414n; // ~1% cheaper
    expect(await only(runner)).toMatchObject({ decision: "already_bought", reason: expect.stringMatching(/no dip/) });
    chain.quoteOut = 1_430n; // ~2.1% cheaper
    expect(await only(runner)).toMatchObject({ decision: "bought", slot: "dip" });
    chain.quoteOut = 1_600n;
    expect(await only(runner)).toMatchObject({ decision: "already_bought" });
    expect(executor.calls).toHaveLength(2);
  });

  it("dry run (no executor) decides but sends and claims nothing", async () => {
    const { storage, chain, encryptionKey } = await setup();
    const runner = createRunner({ storage, chain, executor: null, encryptionKey, goldBuyer: GOLD_BUYER });
    expect(await only(runner)).toMatchObject({ decision: "would_buy" });
    expect(storage.attempts).toHaveLength(0);
  });

  it("a session past its stored expiry stops without reading anything else", async () => {
    const { runner, chain } = await setup();
    chain.now += 61 * 86_400;
    expect(await only(runner)).toMatchObject({ decision: "stopped", reason: expect.stringMatching(/expired/) });
  });

  it("one plan's chain error does not stop the others", async () => {
    const s = await setup();
    const other = await createPlan(
      { storage: s.storage, encryptionKey: s.encryptionKey, goldBuyer: GOLD_BUYER, now: s.chain.now },
      { walletAddress: getAddress("0x3333333333333333333333333333333333333333"), amountPerBuy: AMOUNT, expiresAt: s.chain.now + 86_400 * 30, dayOfWeek: 0, hourUtc: 0 },
    );
    const g = planToSessionGrant({ amountPerBuy: AMOUNT, expiresAt: s.chain.now + 86_400 * 30 }, GOLD_BUYER, s.chain.now);
    await s.storage.activatePlan(other.plan.id, {
      walletAddress: getAddress("0x3333333333333333333333333333333333333333"), publicKey: other.sessionPublicKey,
      permissions: { calls: g.permissions.calls, spend: [{ limit: g.periodCap.toString(), period: "week", token: g.feeToken }] }, expiry: g.expiry,
    });
    const orig = s.chain.sessionState.bind(s.chain);
    s.chain.sessionState = async (w, pk) => {
      if (w === getAddress("0x3333333333333333333333333333333333333333")) throw new Error("RPC timeout");
      return orig(w, pk);
    };
    const report = await s.runner.tick();
    expect(report.plans.map((p) => p.decision).sort()).toEqual(["bought", "error"]);
  });

  it("daily plan: buys once per UTC day, never twice in the same day, again after 00:00 UTC", async () => {
    const { runner, executor, chain, grant } = await setup({ period: "day", hourUtc: 9 });
    expect(grant.permissions.spend[0]).toMatchObject({ period: "day", limit: AMOUNT + 50_000n });
    expect(await only(runner)).toMatchObject({ decision: "bought" });
    chain.now += 3600; // 13:00 the same day
    expect(await only(runner)).toMatchObject({ decision: "already_bought" });
    chain.now = Math.floor(Date.parse("2026-11-18T23:59:59Z") / 1000);
    expect(await only(runner)).toMatchObject({ decision: "already_bought" });
    expect(executor.calls).toHaveLength(1);

    chain.now = Math.floor(Date.parse("2026-11-19T00:00:00Z") / 1000); // new day, before 09:00
    chain.spent = 0n;
    expect(await only(runner)).toMatchObject({ decision: "not_due" });
    chain.now = Math.floor(Date.parse("2026-11-19T09:00:00Z") / 1000);
    expect(await only(runner)).toMatchObject({ decision: "bought" });
    expect(executor.calls).toHaveLength(2);
  });

  it("daily plan: two concurrent ticks in the same day send once", async () => {
    const { storage, chain, executor, encryptionKey } = await setup({ period: "day" });
    executor.delayMs = 20;
    const mk = () => createRunner({ storage, chain, executor, encryptionKey, goldBuyer: GOLD_BUYER, recheckAttempts: 1, recheckDelayMs: 0, sleep: async () => {} });
    const [a, b] = await Promise.all([mk().tick(), mk().tick()]);
    expect([a.plans[0]!.decision, b.plans[0]!.decision].sort()).toEqual(["bought", "waiting_on_earlier_attempt"]);
    expect(executor.calls).toHaveLength(1);
  });

  it("pool without a 30-minute price history: skips plainly, then buys later in the same period", async () => {
    const { runner, executor, storage, chain } = await setup();
    chain.quoteTwap = false;
    expect(await only(runner)).toMatchObject({ decision: "skipped", kind: "twap_unavailable", reason: "Price check not available right now, the agent will retry." });
    chain.now += 600;
    expect(await only(runner)).toMatchObject({ decision: "skipped", kind: "twap_unavailable" });
    expect(storage.runLog.filter((e) => e.kind === "twap_unavailable")).toHaveLength(1); // logged once per period
    expect(executor.calls).toHaveLength(0);
    chain.quoteTwap = true;
    chain.now += 1800;
    expect(await only(runner)).toMatchObject({ decision: "bought" });
  });

  it("an OLD refusal from the relay's simulation is deferred, not a failure, and is retried in the period", async () => {
    const { runner, executor, storage } = await setup();
    let n = 0;
    executor.behaviour = async () => {
      n++;
      throw new AltanaError({ code: "unknown", statement: "s", action: "a", relayMessage: "execution reverted: OLD" });
    };
    for (let i = 0; i < 4; i++) expect(await only(runner)).toMatchObject({ decision: "skipped", kind: "twap_unavailable" });
    expect(n).toBe(4); // never hits the 3-failure limit
    expect(storage.attempts.every((a) => a.status === "deferred")).toBe(true);
    executor.behaviour = "confirm";
    expect(await only(runner)).toMatchObject({ decision: "bought" });
  });

  it("a reverted transaction's fee does not block the rest of the period", async () => {
    const { runner, executor, chain } = await setup();
    executor.behaviour = async () => {
      chain.spent += 5_000n; // the relay fee of a transaction that reverted onchain
      return { callsId: "0x01", transactionHash: `0x${"ab".repeat(32)}`, status: "FAILED", statusCode: 500 };
    };
    expect(await only(runner)).toMatchObject({ decision: "failed", kind: "reverted" });
    executor.behaviour = "confirm";
    chain.now += 600;
    expect(await only(runner)).toMatchObject({ decision: "bought" });
  });

  it("dip rule on a daily plan doubles the daily cap and buys at most twice a day", async () => {
    const { runner, executor, chain, grant } = await setup({ period: "day", dipBuy: true });
    expect(grant.periodCap).toBe(2n * (AMOUNT + 50_000n));
    expect(await only(runner)).toMatchObject({ decision: "bought", slot: "weekly" });
    chain.quoteOut = 1_430n;
    chain.now += 60;
    expect(await only(runner)).toMatchObject({ decision: "bought", slot: "dip" });
    chain.quoteOut = 1_600n;
    chain.now += 60;
    expect(await only(runner)).toMatchObject({ decision: "already_bought" });
    expect(executor.calls).toHaveLength(2);
  });
});
