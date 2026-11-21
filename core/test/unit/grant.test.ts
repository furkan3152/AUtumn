import { describe, expect, it } from "vitest";
import { getAddress, toFunctionSelector, type Address } from "viem";
import { USDT } from "../../src/constants.js";
import {
  APPROVE_SIGNATURE,
  BUY_SIGNATURE,
  DEFAULT_FEE_ALLOWANCE_PER_BUY,
  expectedSerializedSession,
  planToSessionGrant,
  sessionMatchesGrant,
} from "../../src/grant.js";

const GB = "0x1111111111111111111111111111111111111111" as Address;
const NOW = 1_795_000_000;
const WALLET = "0x2222222222222222222222222222222222222222" as Address;
const PK = ("0x04" + "ab".repeat(64)) as `0x${string}`;

describe("planToSessionGrant", () => {
  it("caps USD₮ per calendar week at the plan amount plus an explicit fee allowance", () => {
    const g = planToSessionGrant({ amountPerBuy: 5_000_000n, expiresAt: NOW + 30 * 86400 }, GB, NOW);
    expect(g.permissions.spend).toEqual([{ token: USDT, limit: 5_050_000n, period: "week" }]);
    expect(g.periodCap).toBe(5_000_000n + DEFAULT_FEE_ALLOWANCE_PER_BUY);
    expect(g.feeAllowance).toBe(DEFAULT_FEE_ALLOWANCE_PER_BUY);
    expect(g.buysPerPeriod).toBe(1);
  });

  it("allows exactly USD₮.approve and GoldBuyer.buy", () => {
    const g = planToSessionGrant({ amountPerBuy: 5_000_000n, expiresAt: NOW + 86400 }, GB, NOW);
    expect(g.permissions.calls).toEqual([
      { to: USDT, signature: "approve(address,uint256)" },
      { to: getAddress(GB), signature: "buy(uint256,uint256)" },
    ]);
    expect(toFunctionSelector(APPROVE_SIGNATURE)).toBe("0x095ea7b3");
    expect(toFunctionSelector(BUY_SIGNATURE)).toBe(toFunctionSelector("function buy(uint256 amountIn, uint256 minOut)"));
  });

  it("sets expiry and the USD₮ fee token", () => {
    const g = planToSessionGrant({ amountPerBuy: 2_000_000n, expiresAt: NOW + 7 * 86400 }, GB, NOW);
    expect(g.expiry).toBe(NOW + 7 * 86400);
    expect(g.feeToken).toBe(USDT);
  });

  it("sizes the cap for two purchases only when the dip rule is on", () => {
    const g = planToSessionGrant({ amountPerBuy: 5_000_000n, expiresAt: NOW + 86400, dipBuy: true, feeAllowancePerBuy: 20_000n }, GB, NOW);
    expect(g.periodCap).toBe(10_040_000n);
    expect(g.buysPerPeriod).toBe(2);
  });

  it("meters a daily plan per UTC day, with the same per-buy budget", () => {
    const g = planToSessionGrant({ amountPerBuy: 1_000_000n, period: "day", expiresAt: NOW + 86400 }, GB, NOW);
    expect(g.permissions.spend).toEqual([{ token: USDT, limit: 1_050_000n, period: "day" }]);
    expect(g.period).toBe("day");
    const dip = planToSessionGrant({ amountPerBuy: 1_000_000n, period: "day", dipBuy: true, expiresAt: NOW + 86400 }, GB, NOW);
    expect(dip.periodCap).toBe(2_100_000n);
    expect(() => planToSessionGrant({ amountPerBuy: 1_000_000n, period: "month" as never, expiresAt: NOW + 86400 }, GB, NOW)).toThrow(/period/);
  });

  it("rejects unsafe plans", () => {
    expect(() => planToSessionGrant({ amountPerBuy: 999_999n, expiresAt: NOW + 86400 }, GB, NOW)).toThrow(/at least/);
    expect(() => planToSessionGrant({ amountPerBuy: 5_000_000n, expiresAt: NOW }, GB, NOW)).toThrow(/future/);
    expect(() => planToSessionGrant({ amountPerBuy: 5_000_000n, expiresAt: NOW + 400 * 86400 }, GB, NOW)).toThrow(/year/);
    expect(() => planToSessionGrant({ amountPerBuy: 5_000_000n, expiresAt: NOW + 86400, feeAllowancePerBuy: 600_000n }, GB, NOW)).toThrow(/10%/);
  });

  it("recognises exactly the expected serialized session", () => {
    const g = planToSessionGrant({ amountPerBuy: 5_000_000n, expiresAt: NOW + 86400 }, GB, NOW);
    const exp = expectedSerializedSession(g, WALLET, PK);
    expect(exp.permissions.spend?.[0]?.limit).toBe("5050000");
    expect(sessionMatchesGrant(JSON.parse(JSON.stringify(exp)), exp)).toBe(true);
    const wider = { ...exp, permissions: { ...exp.permissions, spend: [{ token: USDT, limit: "9000000", period: "week" as const }] } };
    expect(sessionMatchesGrant(wider, exp)).toBe(false);
    expect(sessionMatchesGrant({ ...exp, expiry: exp.expiry + 1 }, exp)).toBe(false);
    expect(sessionMatchesGrant({ ...exp, permissions: { ...exp.permissions, calls: [] } }, exp)).toBe(false);
  });
});
