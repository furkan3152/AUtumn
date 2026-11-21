import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { PLAN_DURATION_SECS } from "@autumn/core";
import {
  activatePlanRequest,
  createPlanRequest,
  cronAuthorized,
  HttpError,
  stopPlanRequest,
  walletViewRequest,
  type ServiceDeps,
} from "../src/service.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { FakeChain, GOLD_BUYER } from "./fakes.js";

const WALLET = getAddress("0x2222222222222222222222222222222222222222") as Address;
const OTHER = getAddress("0x5555555555555555555555555555555555555555") as Address;
const NOW = Math.floor(Date.parse("2026-11-18T12:34:00Z") / 1000); // Wednesday
const GRANT_TX = `0x${"11".repeat(32)}` as Hex;
const REVOKE_TX = `0x${"22".repeat(32)}` as Hex;

function setup() {
  const storage = new MemoryStorage();
  const chain = new FakeChain(NOW);
  chain.status = "revoked"; // nothing granted yet
  const deps: ServiceDeps = { storage, chain, encryptionKey: randomBytes(32), goldBuyer: GOLD_BUYER };
  return { storage, chain, deps };
}

const body = (over: Record<string, unknown> = {}) => ({
  wallet: WALLET,
  amountUsdt: 5,
  period: "week",
  dipBuy: false,
  expiresAt: NOW + PLAN_DURATION_SECS,
  ...over,
});

/** Puts the plan's grant onchain in the fake, as the owner's passkey would. */
function grantOnchain(chain: FakeChain, created: Awaited<ReturnType<typeof createPlanRequest>>) {
  chain.status = "active";
  chain.cap = BigInt(created.periodCap);
  chain.period = created.period;
  chain.expiry = created.expiry;
  chain.txs.set(GRANT_TX, { txHash: GRANT_TX, succeeded: true, blockNumber: 1n, timestamp: NOW, keysRegistered: [], touchedWallet: true });
}

async function rejects(p: Promise<unknown>, status: number, msg?: RegExp) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  if (msg) expect((err as Error).message).toMatch(msg);
}

describe("createPlanRequest", () => {
  it("returns only the public key and the exact grant, due at the current UTC weekday and hour", async () => {
    const { deps, storage } = setup();
    const r = await createPlanRequest(deps, body());
    expect(r.sessionPublicKey).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(JSON.stringify(r)).not.toMatch(/privateKey/i);
    expect(r).toMatchObject({ period: "week", periodCap: "5050000", buysPerPeriod: 1, expiry: NOW + PLAN_DURATION_SECS });
    expect(r.expected.permissions.spend).toEqual([{ limit: "5050000", period: "week", token: getAddress("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e") }]);
    const plan = (await storage.getPlan(r.planId))!;
    expect(plan).toMatchObject({ status: "pending_grant", dayOfWeek: 2, hourUtc: 12, createdBlock: 1_000n });
    expect(storage.keys.get(r.planId)?.ciphertext.length).toBe(32);
  });

  it("makes a daily plan with a daily cap, doubled by the dip rule", async () => {
    const { deps } = setup();
    const r = await createPlanRequest(deps, body({ period: "day", dipBuy: true, amountUsdt: 1 }));
    expect(r).toMatchObject({ period: "day", periodCap: "2100000", buysPerPeriod: 2 });
  });

  it("refuses amounts, periods and expiries the app does not offer", async () => {
    const { deps } = setup();
    await rejects(createPlanRequest(deps, body({ amountUsdt: 7 })), 400, /one of 1, 5, 10/);
    await rejects(createPlanRequest(deps, body({ amountUsdt: "5" })), 400);
    await rejects(createPlanRequest(deps, body({ period: "month" })), 400, /period/);
    await rejects(createPlanRequest(deps, body({ expiresAt: NOW + 365 * 86_400 })), 400, /12 weeks/);
    await rejects(createPlanRequest(deps, body({ wallet: "0x1234" })), 400, /wallet/);
    await rejects(createPlanRequest(deps, "nope"), 400);
  });

  it("limits unconfirmed plans per wallet per hour", async () => {
    const { deps } = setup();
    for (let i = 0; i < 5; i++) await createPlanRequest(deps, body());
    await rejects(createPlanRequest(deps, body()), 429);
    await createPlanRequest(deps, body({ wallet: OTHER })); // other wallets are not affected
  });
});

describe("activatePlanRequest", () => {
  it("activates only after the chain shows this wallet granted the server's key with the exact limits", async () => {
    const { deps, chain, storage } = setup();
    const created = await createPlanRequest(deps, body());
    chain.txs.set(GRANT_TX, { txHash: GRANT_TX, succeeded: true, blockNumber: 1n, timestamp: NOW, keysRegistered: [], touchedWallet: true });

    // Not granted onchain yet: refused, plan stays pending.
    await rejects(activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: GRANT_TX }), 409, /not active onchain/);
    expect((await storage.getPlan(created.planId))?.status).toBe("pending_grant");

    grantOnchain(chain, created);
    const view = await activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: GRANT_TX });
    expect(view).toMatchObject({ status: "active", grantTxHash: GRANT_TX, periodCap: "5050000" });
    // Idempotent.
    expect((await activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: GRANT_TX })).status).toBe("active");
  });

  it("refuses a session that claims wider limits than the plan, even if the chain matches the plan", async () => {
    const { deps, chain } = setup();
    const created = await createPlanRequest(deps, body());
    grantOnchain(chain, created);
    const wider = { ...created.expected, permissions: { ...created.expected.permissions, spend: [{ ...created.expected.permissions.spend![0]!, limit: "99000000" }] } };
    await rejects(activatePlanRequest(deps, created.planId, { session: wider, grantTxHash: GRANT_TX }), 409, /does not match/);
  });

  it("refuses when the onchain cap, period or expiry differs from the plan", async () => {
    const { deps, chain } = setup();
    const created = await createPlanRequest(deps, body());
    grantOnchain(chain, created);
    chain.cap += 1n;
    await rejects(activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: GRANT_TX }), 409, /weekly cap/);
    chain.cap -= 1n;
    chain.period = "day";
    await rejects(activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: GRANT_TX }), 409, /period/);
    chain.period = "week";
    chain.expiry += 60;
    await rejects(activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: GRANT_TX }), 409, /expiry/);
  });

  it("refuses another wallet's session, a missing or reverted grant transaction, and unknown plans", async () => {
    const { deps, chain } = setup();
    const created = await createPlanRequest(deps, body());
    grantOnchain(chain, created);
    await rejects(activatePlanRequest(deps, created.planId, { session: { ...created.expected, walletAddress: OTHER }, grantTxHash: GRANT_TX }), 403);
    await rejects(activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: `0x${"99".repeat(32)}` }), 409, /not visible/);
    chain.txs.set(GRANT_TX, { ...chain.txs.get(GRANT_TX)!, succeeded: false });
    await rejects(activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: GRANT_TX }), 409, /reverted/);
    await rejects(activatePlanRequest(deps, "00000000-0000-0000-0000-000000000000", { session: created.expected, grantTxHash: GRANT_TX }), 404);
    await rejects(activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: "0x12" }), 400);
  });

  it("keeps one running plan per wallet: a second activation waits for the first session to end onchain", async () => {
    const { deps, chain, storage } = setup();
    const first = await createPlanRequest(deps, body());
    grantOnchain(chain, first);
    await activatePlanRequest(deps, first.planId, { session: first.expected, grantTxHash: GRANT_TX });
    const second = await createPlanRequest(deps, body({ amountUsdt: 10 }));
    // The fake chain answers "active" for every key: the first session is still live.
    grantOnchain(chain, second);
    await rejects(activatePlanRequest(deps, second.planId, { session: second.expected, grantTxHash: GRANT_TX }), 409, /stop it first/);
    expect((await storage.getPlan(second.planId))?.status).toBe("pending_grant");
  });
});

describe("stopPlanRequest", () => {
  it("stops only once the chain shows the session revoked, and records the verified revoke", async () => {
    const { deps, chain } = setup();
    const created = await createPlanRequest(deps, body());
    grantOnchain(chain, created);
    await activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: GRANT_TX });

    await rejects(stopPlanRequest(deps, created.planId, { revokeTxHash: REVOKE_TX }), 409, /still active/);

    chain.status = "revoked";
    chain.txs.set(REVOKE_TX, { txHash: REVOKE_TX, succeeded: true, blockNumber: 2n, timestamp: NOW + 60, keysRegistered: [], touchedWallet: true });
    const v = await stopPlanRequest(deps, created.planId, { revokeTxHash: REVOKE_TX });
    expect(v).toMatchObject({ status: "stopped", stopTxHash: REVOKE_TX, stoppedAt: NOW, stoppedReason: "the owner revoked the session" });
  });

  it("refuses to stop a plan that was never activated (a never-granted key also reads as revoked)", async () => {
    const { deps, storage } = setup();
    const created = await createPlanRequest(deps, body());
    await rejects(stopPlanRequest(deps, created.planId, {}), 409, /never activated/);
    expect((await storage.getPlan(created.planId))?.status).toBe("pending_grant");
  });

  it("does not record a revoke transaction that did not succeed", async () => {
    const { deps, chain } = setup();
    const created = await createPlanRequest(deps, body());
    grantOnchain(chain, created);
    await activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: GRANT_TX });
    chain.status = "revoked";
    const v = await stopPlanRequest(deps, created.planId, { revokeTxHash: REVOKE_TX });
    expect(v).toMatchObject({ status: "stopped", stopTxHash: null });
  });
});

describe("walletViewRequest", () => {
  it("lists granted plans only, without key material, with their run log", async () => {
    const { deps, chain, storage } = setup();
    const created = await createPlanRequest(deps, body());
    await createPlanRequest(deps, body()); // pending, never granted
    grantOnchain(chain, created);
    await activatePlanRequest(deps, created.planId, { session: created.expected, grantTxHash: GRANT_TX });
    await storage.appendRunLog({ planId: created.planId, periodId: "2026-11-16", at: NOW, outcome: "bought", reason: "weekly purchase", amountIn: 5_000_000n, out: 1_400n, kind: "weekly" });
    const v = await walletViewRequest(deps, WALLET.toLowerCase());
    expect(v.plans.map((p) => p.id)).toEqual([created.planId]);
    expect(v.runLog).toEqual([expect.objectContaining({ planId: created.planId, amountIn: "5000000", out: "1400", kind: "weekly" })]);
    expect(JSON.stringify(v)).not.toMatch(/ciphertext|privateKey|authTag/);
  });
});

describe("cronAuthorized", () => {
  const secret = "s3cret-s3cret-s3cret";
  it("accepts exactly the Vercel Cron bearer header", () => {
    expect(cronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    expect(cronAuthorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(cronAuthorized(secret, secret)).toBe(false);
    expect(cronAuthorized(null, secret)).toBe(false);
  });
  it("refuses everything without a strong secret", () => {
    expect(cronAuthorized("Bearer ", undefined)).toBe(false);
    expect(cronAuthorized("Bearer short", "short")).toBe(false);
  });
});
