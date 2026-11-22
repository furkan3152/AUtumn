import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import type { ExecuteResult } from "@altananetwork/sdk";
import { PLAN_DURATION_SECS, USDT, stripAttribution } from "@autumn/core";
import { activatePlanRequest, createPlanRequest, HttpError, type ServiceDeps } from "../src/service.js";
import { parseProbeRequest, runAdminProbe, tryBuy, type AdminProbeDeps } from "../src/probe.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { FakeChain, GOLD_BUYER, type ExecCall } from "./fakes.js";
import type { SessionExecutor } from "../src/ports.js";

const WALLET = getAddress("0x2222222222222222222222222222222222222222") as Address;
const NOW = Math.floor(Date.parse("2026-11-18T12:34:00Z") / 1000);
const GRANT_TX = `0x${"11".repeat(32)}` as Hex;

/** An executor that records every call and answers like a relay that refused in simulation. */
class RefusingExecutor implements SessionExecutor {
  calls: ExecCall[] = [];
  answer: (c: ExecCall) => Promise<ExecuteResult> = async () => {
    throw Object.assign(new Error("Spend limit exceeded: ExceededSpendLimit(0x4806…)"), { name: "AltanaError", code: "spend_limit_exceeded" });
  };
  async quote() {
    return { fee: 3_000n, feeToken: getAddress(USDT) };
  }
  async execute(c: ExecCall): Promise<ExecuteResult> {
    this.calls.push(c);
    return this.answer(c);
  }
}

async function setup(opts: { period?: "day" | "week" } = {}) {
  const storage = new MemoryStorage();
  const chain = new FakeChain(NOW);
  chain.status = "revoked";
  const service: ServiceDeps = { storage, chain, encryptionKey: randomBytes(32), goldBuyer: GOLD_BUYER };
  const created = await createPlanRequest(service, {
    wallet: WALLET, amountUsdt: 1, period: opts.period ?? "day", dipBuy: false, expiresAt: NOW + PLAN_DURATION_SECS,
  });
  chain.status = "active";
  chain.cap = BigInt(created.periodCap);
  chain.period = created.period;
  chain.expiry = created.expiry;
  chain.txs.set(GRANT_TX, { txHash: GRANT_TX, succeeded: true, blockNumber: 1n, timestamp: NOW, keysRegistered: [], touchedWallet: true });
  await activatePlanRequest(service, created.planId, { session: created.expected, grantTxHash: GRANT_TX });
  const executor = new RefusingExecutor();
  const deps: AdminProbeDeps = { ...service, executor, settleMs: 0 };
  return { storage, chain, executor, deps, planId: created.planId, cap: BigInt(created.periodCap) };
}

async function rejects(p: Promise<unknown>, status: number, msg?: RegExp) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  if (msg) expect((err as Error).message).toMatch(msg);
}

const PLAN = "0b0b4e0e-4a49-4c1c-9a3c-8a3f4f1c2d3e";

describe("parseProbeRequest", () => {
  it("accepts exactly { planId: uuid, kind } with one of the four kinds", () => {
    for (const kind of ["over-cap", "outside-allowlist", "after-revoke", "status"]) {
      expect(parseProbeRequest({ planId: PLAN.toUpperCase(), kind })).toEqual({ planId: PLAN, kind });
    }
  });
  it("refuses anything else with 400, including extra fields such as an amount or a target", () => {
    const bad: unknown[] = [
      null, "x", [], {}, { planId: PLAN }, { kind: "status" },
      { planId: "1", kind: "status" }, { planId: `${PLAN}x`, kind: "status" }, { planId: 5, kind: "status" },
      { planId: PLAN, kind: "buy" }, { planId: PLAN, kind: "STATUS" },
      { planId: PLAN, kind: "over-cap", amount: "1000000" }, { planId: PLAN, kind: "over-cap", to: WALLET },
    ];
    for (const b of bad) {
      let err: unknown;
      try {
        parseProbeRequest(b);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(b)).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
    }
  });
});

describe("runAdminProbe", () => {
  it("status reads the session and balances and sends nothing", async () => {
    const { deps, executor, planId, cap } = await setup();
    const r = await runAdminProbe(deps, { planId, kind: "status" });
    expect(r).toMatchObject({ attempted: false, outcome: "not_attempted", request: null, wallet: WALLET });
    expect(r.sessionBefore).toMatchObject({ status: "active", limitsMatchPlan: true, cap: { limit: cap.toString(), remaining: cap.toString() } });
    expect(executor.calls).toHaveLength(0);
  });

  it("status works on a dry-run server; sending probes are refused there", async () => {
    const { deps, planId } = await setup();
    await runAdminProbe({ ...deps, executor: null }, { planId, kind: "status" });
    await rejects(runAdminProbe({ ...deps, executor: null }, { planId, kind: "over-cap" }), 409, /dry-run/);
  });

  it("over-cap sends one purchase above the whole period cap, built on the server, and reports the refusal", async () => {
    const { deps, executor, planId, cap, storage } = await setup();
    const r = await runAdminProbe(deps, { planId, kind: "over-cap" });
    expect(executor.calls).toHaveLength(1);
    const [approve, buy] = executor.calls[0]!.calls;
    expect(getAddress(approve!.to)).toBe(getAddress(USDT));
    expect(getAddress(buy!.to)).toBe(GOLD_BUYER);
    const { args } = decodeFunctionData({ abi: parseAbi(["function buy(uint256,uint256)"]), data: stripAttribution(buy!.data).body });
    expect(args[0]).toBe(cap + 1_000_000n); // above the whole cap: no reset can make it fit
    expect(r).toMatchObject({
      attempted: true, outcome: "refused", request: { amountIn: (cap + 1_000_000n).toString() },
      failure: { kind: "cap_exceeded", code: "spend_limit_exceeded", bought: "no" },
      sdkError: { name: "AltanaError", code: "spend_limit_exceeded" },
      onchain: { txHash: null, receipt: null, purchasesInTx: [], purchasesDuringProbe: [] },
      balancesUnchanged: true,
    });
    expect((await storage.lastRunLog(planId))?.reason).toMatch(/^probe: /);
  });

  it("outside-allowlist sends only USD₮.transfer(wallet itself, 0)", async () => {
    const { deps, executor, planId } = await setup();
    executor.answer = async () => {
      throw Object.assign(new Error("UnauthorizedCall(0xabc…, 0x4806…, 0xa9059cbb…)"), { name: "AltanaError", code: "call_not_permitted" });
    };
    const r = await runAdminProbe(deps, { planId, kind: "outside-allowlist" });
    expect(executor.calls).toHaveLength(1);
    const calls = executor.calls[0]!.calls;
    expect(calls).toHaveLength(1);
    expect(getAddress(calls[0]!.to)).toBe(getAddress(USDT));
    expect(calls[0]!.value).toBe(0n);
    const d = decodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), data: stripAttribution(calls[0]!.data).body });
    expect(d.args).toEqual([WALLET, 0n]);
    expect(r).toMatchObject({ outcome: "refused", failure: { kind: "call_not_permitted" }, request: { amountIn: null } });
  });

  it("refuses to send over-cap or outside-allowlist when the onchain limits are not the plan's", async () => {
    const { deps, chain, executor, planId } = await setup();
    chain.cap = 50_000_000n; // a bigger cap than the plan's
    await rejects(runAdminProbe(deps, { planId, kind: "over-cap" }), 409, /cap differs/);
    await rejects(runAdminProbe(deps, { planId, kind: "outside-allowlist" }), 409, /cap differs/);
    chain.cap = 1_050_000n;
    chain.allowedCalls = [...chain.allowedCalls, { target: getAddress(USDT), selector: "0xa9059cbb" }];
    await rejects(runAdminProbe(deps, { planId, kind: "outside-allowlist" }), 409, /allowlist/);
    expect(executor.calls).toHaveLength(0);
  });

  it("after-revoke needs the key inactive onchain, and still uses an amount above the whole cap", async () => {
    const { deps, chain, executor, planId, cap } = await setup();
    await rejects(runAdminProbe(deps, { planId, kind: "after-revoke" }), 409, /still active/);
    chain.status = "revoked";
    await rejects(runAdminProbe(deps, { planId, kind: "over-cap" }), 409, /not active/);
    executor.answer = async () => {
      throw Object.assign(new Error("key hash 0x1234 is unknown"), { name: "AltanaError", code: "session_expired" });
    };
    const r = await runAdminProbe(deps, { planId, kind: "after-revoke" });
    expect(r).toMatchObject({ outcome: "refused", failure: { kind: "session_ended" }, request: { amountIn: (cap + 1_000_000n).toString() } });
  });

  it("reports a transaction the submitter returned, its receipt and any purchase by the wallet in it", async () => {
    const { deps, chain, executor, planId } = await setup();
    const tx = keccak256(toHex("reverted"));
    chain.txs.set(tx, { txHash: tx, succeeded: false, blockNumber: 2n, timestamp: NOW, keysRegistered: [], touchedWallet: true });
    executor.answer = async () => ({ callsId: tx, transactionHash: tx, status: "FAILED", statusCode: 500 });
    const r = await runAdminProbe(deps, { planId, kind: "over-cap" });
    expect(r).toMatchObject({ outcome: "refused", onchain: { txHash: tx, receipt: "reverted", purchasesInTx: [] }, failure: { bought: "no" } });
  });

  it("404 for an unknown plan, 409 for a plan that was never granted", async () => {
    const { deps } = await setup();
    await rejects(runAdminProbe(deps, { planId: PLAN, kind: "status" }), 404);
    const created = await createPlanRequest(deps as ServiceDeps, {
      wallet: getAddress("0x3333333333333333333333333333333333333333"), amountUsdt: 1, period: "day", expiresAt: NOW + PLAN_DURATION_SECS,
    });
    await rejects(runAdminProbe(deps, { planId: created.planId, kind: "status" }), 409, /never granted/);
  });
});

describe("tryBuy (CLI)", () => {
  it("refuses an amount within the whole period cap of an active session, even when above what is left", async () => {
    const { deps, chain, planId, cap, executor } = await setup();
    chain.spent = cap; // nothing left this period
    await expect(tryBuy({ ...deps, executor }, planId, cap)).rejects.toThrow(/whole period cap/);
    expect(executor.calls).toHaveLength(0);
    const r = await tryBuy({ ...deps, executor }, planId, cap + 1n);
    expect(r).toMatchObject({ outcome: "refused", expectation: "over_cap" });
  });
});
