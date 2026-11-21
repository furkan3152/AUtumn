import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { SPEND_PERIOD } from "../../src/abis.js";
import { ALTANA_ORCHESTRATOR, ANY_SELECTOR, ANY_TARGET, USDT } from "../../src/constants.js";
import { planToSessionGrant } from "../../src/grant.js";
import { unpackCanExecute, type SessionState } from "../../src/readers.js";
import { sessionLimitsMismatch } from "../../src/verify.js";

/** Four live Celo mainnet session keys (not ours), read-only: see the fixture's `source`. */
const MAINNET = JSON.parse(readFileSync(new URL("../fixtures/mainnet-session-allowlists.json", import.meta.url), "utf8")) as {
  orchestrator: Address;
  sessions: { wallet: Address; keyHash: Hex; accountOrchestrator: Address; canExecutePackedInfos: Hex[] }[];
};
const ORCH_ENTRY = { target: getAddress(ALTANA_ORCHESTRATOR), selector: ANY_SELECTOR as Hex };

const GB = getAddress("0x1111111111111111111111111111111111111111") as Address;
const NOW = 1_795_000_000;

function stateFor(over: Partial<SessionState> = {}, cap = 5_050_000n, period: number = SPEND_PERIOD.week): SessionState {
  return {
    status: "active",
    keyId: "0x01" as Hex,
    keyHash: "0x02" as Hex,
    keyStoreValid: true,
    onAccount: true,
    accountExpiry: NOW + 86_400,
    keyType: 2,
    isSuperAdmin: false,
    spend: [{ token: getAddress(USDT), period, limit: cap, spentThisPeriod: 0n, periodStart: NOW }],
    allowedCalls: [
      { target: getAddress(USDT), selector: toFunctionSelector("approve(address,uint256)") },
      { target: GB, selector: toFunctionSelector("buy(uint256,uint256)") },
      ORCH_ENTRY,
    ],
    blockNumber: 1n,
    blockTimestamp: NOW,
    ...over,
  };
}

describe("sessionLimitsMismatch", () => {
  const weekly = planToSessionGrant({ amountPerBuy: 5_000_000n, expiresAt: NOW + 86_400 }, GB, NOW);
  const daily = planToSessionGrant({ amountPerBuy: 5_000_000n, period: "day", expiresAt: NOW + 86_400 }, GB, NOW);

  it("accepts exactly the granted limits", () => {
    expect(sessionLimitsMismatch(stateFor(), weekly, GB)).toBeUndefined();
    expect(sessionLimitsMismatch(stateFor({}, 5_050_000n, SPEND_PERIOD.day), daily, GB)).toBeUndefined();
  });

  it("refuses an inactive key", () => {
    expect(sessionLimitsMismatch(stateFor({ status: "revoked" }), weekly, GB)).toMatch(/not active/);
  });

  it("refuses a different period, cap or expiry", () => {
    expect(sessionLimitsMismatch(stateFor(), daily, GB)).toMatch(/period/);
    expect(sessionLimitsMismatch(stateFor({}, 5_050_001n), weekly, GB)).toMatch(/weekly cap/);
    expect(sessionLimitsMismatch(stateFor({ accountExpiry: NOW + 86_401 }), weekly, GB)).toMatch(/expiry/);
  });

  it("refuses an extra call, a missing call, or a duplicated call", () => {
    const s = stateFor();
    expect(sessionLimitsMismatch({ ...s, allowedCalls: [...s.allowedCalls, { target: GB, selector: "0xdeadbeef" }] }, weekly, GB)).toMatch(/allowlist/);
    expect(sessionLimitsMismatch({ ...s, allowedCalls: s.allowedCalls.slice(0, 1) }, weekly, GB)).toMatch(/allowlist/);
    expect(sessionLimitsMismatch({ ...s, allowedCalls: [s.allowedCalls[0]!, s.allowedCalls[0]!] }, weekly, GB)).toMatch(/allowlist/);
  });

  it("refuses the plan's two calls without the Orchestrator entry a real grant carries", () => {
    const s = stateFor();
    expect(sessionLimitsMismatch({ ...s, allowedCalls: s.allowedCalls.slice(0, 2) }, weekly, GB)).toMatch(/allowlist differs/);
  });

  it("refuses any wildcard other than the pinned Orchestrator's any-selector entry", () => {
    const s = stateFor();
    const plus = (c: { target: Address; selector: Hex }) => ({ ...s, allowedCalls: [...s.allowedCalls, c] });
    const swap = (c: { target: Address; selector: Hex }) => ({ ...s, allowedCalls: [...s.allowedCalls.slice(0, 2), c] });
    // Any function of GoldBuyer, of USD₮ (transfer!), or any contract at all.
    expect(sessionLimitsMismatch(plus({ target: GB, selector: ANY_SELECTOR }), weekly, GB)).toMatch(/any function of/);
    expect(sessionLimitsMismatch(swap({ target: getAddress(USDT), selector: ANY_SELECTOR }), weekly, GB)).toMatch(/any function of/);
    expect(sessionLimitsMismatch(swap({ target: ANY_TARGET, selector: toFunctionSelector("buy(uint256,uint256)") }), weekly, GB)).toMatch(/wildcard target/);
    expect(sessionLimitsMismatch(swap({ target: ANY_TARGET, selector: ANY_SELECTOR }), weekly, GB)).toMatch(/wildcard target/);
    // Another "Orchestrator" (a different address) with any selector.
    expect(sessionLimitsMismatch(swap({ target: getAddress("0xcb5cef3c00000000000000000000000000062b9a"), selector: ANY_SELECTOR }), weekly, GB)).toMatch(/any function of/);
    // The Orchestrator with one specific selector instead of the any-selector entry.
    expect(sessionLimitsMismatch(swap({ target: ORCH_ENTRY.target, selector: "0x09c5eabe" }), weekly, GB)).toMatch(/allowlist differs/);
    // A fourth entry next to the three, and the Orchestrator entry twice.
    expect(sessionLimitsMismatch(plus({ target: getAddress(USDT), selector: toFunctionSelector("transfer(address,uint256)") }), weekly, GB)).toMatch(/allowlist differs/);
    expect(sessionLimitsMismatch(plus(ORCH_ENTRY), weekly, GB)).toMatch(/allowlist differs/);
  });

  it("matches the Orchestrator entry exactly as live mainnet session keys store it", () => {
    expect(MAINNET.sessions).toHaveLength(4);
    for (const k of MAINNET.sessions) {
      const calls = k.canExecutePackedInfos.map(unpackCanExecute);
      // Same pinned Orchestrator, any selector, on every wallet; and it is the account implementation's own ORCHESTRATOR().
      expect(calls.filter((c) => c.selector === ANY_SELECTOR && c.target === ORCH_ENTRY.target)).toEqual([ORCH_ENTRY]);
      expect(getAddress(k.accountOrchestrator)).toBe(ORCH_ENTRY.target);
      // Those keys are other people's grants (USD₮.transfer and more): ours refuses them as they are.
      expect(sessionLimitsMismatch(stateFor({ allowedCalls: calls }), weekly, GB)).toBeDefined();
    }
    // Our plan's two calls plus the entry copied byte for byte from a live key: accepted, in either order.
    const live = unpackCanExecute(MAINNET.sessions[0]!.canExecutePackedInfos[0]!);
    expect(live).toEqual(ORCH_ENTRY);
    const s = stateFor();
    expect(sessionLimitsMismatch({ ...s, allowedCalls: [live, ...s.allowedCalls.slice(0, 2)] }, weekly, GB)).toBeUndefined();
  });

  it("refuses a second cap or another token", () => {
    const s = stateFor();
    const other = { ...s.spend[0]!, token: getAddress("0x3333333333333333333333333333333333333333") };
    expect(sessionLimitsMismatch({ ...s, spend: [...s.spend, other] }, weekly, GB)).toMatch(/other than USD₮/);
    // A native CELO limit (token 0x0) would let calls and fees carry CELO value.
    const native = { ...s.spend[0]!, token: getAddress("0x0000000000000000000000000000000000000000") };
    expect(sessionLimitsMismatch({ ...s, spend: [...s.spend, native] }, weekly, GB)).toMatch(/other than USD₮/);
    expect(sessionLimitsMismatch({ ...s, spend: [...s.spend, { ...s.spend[0]!, period: SPEND_PERIOD.day }] }, weekly, GB)).toMatch(/more than one/);
  });

  it("refuses a super admin key or a key of another type, even with the right limits", () => {
    expect(sessionLimitsMismatch(stateFor({ isSuperAdmin: true }), weekly, GB)).toMatch(/super admin/);
    expect(sessionLimitsMismatch(stateFor({ isSuperAdmin: undefined }), weekly, GB)).toMatch(/super admin/);
    expect(sessionLimitsMismatch(stateFor({ keyType: 1 }), weekly, GB)).toMatch(/secp256k1/);
  });
});
