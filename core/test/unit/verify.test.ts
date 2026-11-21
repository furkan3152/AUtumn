import { describe, expect, it } from "vitest";
import { getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { SPEND_PERIOD } from "../../src/abis.js";
import { USDT } from "../../src/constants.js";
import { planToSessionGrant } from "../../src/grant.js";
import type { SessionState } from "../../src/readers.js";
import { sessionLimitsMismatch } from "../../src/verify.js";

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

  it("refuses a second cap or another token", () => {
    const s = stateFor();
    const other = { ...s.spend[0]!, token: getAddress("0x3333333333333333333333333333333333333333") };
    expect(sessionLimitsMismatch({ ...s, spend: [...s.spend, other] }, weekly, GB)).toMatch(/other than USD₮/);
    expect(sessionLimitsMismatch({ ...s, spend: [...s.spend, { ...s.spend[0]!, period: SPEND_PERIOD.day }] }, weekly, GB)).toMatch(/more than one/);
  });

  it("refuses a super admin key or a key of another type, even with the right limits", () => {
    expect(sessionLimitsMismatch(stateFor({ isSuperAdmin: true }), weekly, GB)).toMatch(/super admin/);
    expect(sessionLimitsMismatch(stateFor({ isSuperAdmin: undefined }), weekly, GB)).toMatch(/super admin/);
    expect(sessionLimitsMismatch(stateFor({ keyType: 1 }), weekly, GB)).toMatch(/secp256k1/);
  });
});
