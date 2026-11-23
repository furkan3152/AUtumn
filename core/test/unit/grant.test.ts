import { describe, expect, it } from "vitest";
import { getAddress, toFunctionSelector, type Address } from "viem";
// The SDK's own Porto layer (porto 0.2.37, a dependency of @altananetwork/sdk): what it really asks the relay to authorize.
import * as PortoKey from "porto/viem/Key";
import { ALTANA_ORCHESTRATOR, ANY_SELECTOR, USDT } from "../../src/constants.js";
import {
  APPROVE_SIGNATURE,
  BUY_SIGNATURE,
  DEFAULT_FEE_ALLOWANCE_PER_BUY,
  PLAN_PRESETS_USDT,
  expectedSerializedSession,
  parsePlanAmountText,
  planAmountFromUsdt,
  planAmountProblem,
  planAmountToUsdt,
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

  it("expects onchain exactly what Porto will authorize: the two calls plus the Orchestrator any-selector entry", () => {
    const g = planToSessionGrant({ amountPerBuy: 5_000_000n, expiresAt: NOW + 86400 }, GB, NOW);
    expect(g.onchainCalls).toEqual([
      { target: getAddress(USDT), selector: "0x095ea7b3" },
      { target: getAddress(GB), selector: toFunctionSelector(BUY_SIGNATURE) },
      { target: getAddress(ALTANA_ORCHESTRATOR), selector: ANY_SELECTOR },
    ]);
    // Porto's Key.toRelay, with the orchestrator the relay's capabilities give for Celo, over our requested permissions.
    const key = PortoKey.fromSecp256k1({ address: WALLET, role: "session", expiry: g.expiry, permissions: g.permissions });
    const relay = PortoKey.toRelay(key, { orchestrator: ALTANA_ORCHESTRATOR });
    const relayCalls = relay.permissions.flatMap((p) => (p.type === "call" ? [{ target: getAddress(p.to), selector: p.selector }] : []));
    expect(relayCalls).toEqual(g.onchainCalls);
    expect(relay.permissions.filter((p) => p.type === "spend")).toEqual([{ type: "spend", token: USDT, limit: 5_050_000n, period: "week" }]);
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

describe("grants for preset and custom amounts", () => {
  const EXP = NOW + 84 * 86400;
  /** The exact bytes the browser compares with the server's proposal and the SDK serializes. */
  const bytes = (amountPerBuy: bigint, period: "week" | "day", dipBuy: boolean) =>
    JSON.stringify(expectedSerializedSession(planToSessionGrant({ amountPerBuy, period, dipBuy, expiresAt: EXP }, GB, NOW), WALLET, PK));
  const literal = (limit: string, period: string) =>
    `{"walletAddress":"${WALLET}","publicKey":"${PK}","permissions":{"calls":[{"to":"${USDT}","signature":"approve(address,uint256)"},` +
    `{"to":"${getAddress(GB)}","signature":"buy(uint256,uint256)"}],"spend":[{"limit":"${limit}","period":"${period}","token":"${USDT}"}]},"expiry":${EXP}}`;

  it("leaves the grant of the 1, 5 and 10 USD₮ presets byte for byte as before", () => {
    expect(PLAN_PRESETS_USDT).toEqual([1, 5, 10]);
    // Caps as granted before custom amounts existed (1 USD₮ daily is the 1.05 USD₮ cap of the mainnet grant 0x4ad6…603e).
    const before: Record<string, string> = {
      "1/day/false": "1050000", "1/day/true": "2100000", "1/week/false": "1050000", "1/week/true": "2100000",
      "5/day/false": "5050000", "5/day/true": "10100000", "5/week/false": "5050000", "5/week/true": "10100000",
      "10/day/false": "10050000", "10/day/true": "20100000", "10/week/false": "10050000", "10/week/true": "20100000",
    };
    for (const usdt of PLAN_PRESETS_USDT) {
      for (const period of ["day", "week"] as const) {
        for (const dip of [false, true]) {
          const amount = planAmountFromUsdt(usdt);
          expect(amount).toEqual({ ok: true, value: BigInt(usdt) * 1_000_000n });
          expect(bytes(BigInt(usdt) * 1_000_000n, period, dip)).toBe(literal(before[`${usdt}/${period}/${dip}`]!, period));
        }
      }
    }
  });

  it("grants a custom amount as that amount plus the fee allowance, doubled with the dip rule", () => {
    expect(bytes(4_000_000n, "day", false)).toBe(literal("4050000", "day"));
    expect(bytes(4_000_000n, "day", true)).toBe(literal("8100000", "day"));
    expect(bytes(4_500_000n, "week", false)).toBe(literal("4550000", "week"));
    expect(bytes(4_500_000n, "week", true)).toBe(literal("9100000", "week"));
    expect(bytes(100_000_000n, "day", true)).toBe(literal("200100000", "day"));
    // What Porto asks the relay to authorize for 4.5 USD₮ a day.
    const g = planToSessionGrant({ amountPerBuy: 4_500_000n, period: "day", expiresAt: EXP }, GB, NOW);
    const relay = PortoKey.toRelay(PortoKey.fromSecp256k1({ address: WALLET, role: "session", expiry: g.expiry, permissions: g.permissions }), {
      orchestrator: ALTANA_ORCHESTRATOR,
    });
    expect(relay.permissions.filter((p) => p.type === "spend")).toEqual([{ type: "spend", token: USDT, limit: 4_550_000n, period: "day" }]);
  });

  it("refuses to build a grant above 100 USD₮ or off the 0.01 USD₮ step", () => {
    expect(() => planToSessionGrant({ amountPerBuy: 100_010_000n, expiresAt: NOW + 86400 }, GB, NOW)).toThrow(/at most/);
    expect(() => planToSessionGrant({ amountPerBuy: 4_555_000n, expiresAt: NOW + 86400 }, GB, NOW)).toThrow(/multiple of 10000/);
    expect(() => planToSessionGrant({ amountPerBuy: 4_500_001n, expiresAt: NOW + 86400 }, GB, NOW)).toThrow(/multiple/);
  });
});

describe("plan amounts", () => {
  it("states why an amount in base units is not allowed", () => {
    expect(planAmountProblem(1_000_000n)).toBeNull();
    expect(planAmountProblem(100_000_000n)).toBeNull();
    expect(planAmountProblem(4_550_000n)).toBeNull();
    expect(planAmountProblem(990_000n)).toBe("Enter at least 1 USD₮.");
    expect(planAmountProblem(100_010_000n)).toBe("Enter at most 100 USD₮.");
    expect(planAmountProblem(4_555_000n)).toBe("Enter at most 2 decimals.");
  });

  it("converts the API's JSON number to base units from its decimal string, never by multiplying a float", () => {
    const ok: [unknown, bigint][] = [[1, 1_000_000n], [100, 100_000_000n], [4, 4_000_000n], [4.5, 4_500_000n], [4.55, 4_550_000n], [1.1, 1_100_000n], [99.99, 99_990_000n]];
    for (const [v, want] of ok) expect(planAmountFromUsdt(v)).toEqual({ ok: true, value: want });
    // 2.01 * 1e6 is 2009999.9999999998 as a float; the decimal string gives the exact amount.
    expect(2.01 * 1e6).not.toBe(2_010_000);
    expect(planAmountFromUsdt(2.01)).toEqual({ ok: true, value: 2_010_000n });
    for (const v of [0.99, 100.01, 4.555, 1.1 * 3, 0, -0, -4, 1e-7, 1e21, NaN, Infinity, -Infinity, "4", "4.5", null, undefined, true, 4n]) {
      expect(planAmountFromUsdt(v)).toMatchObject({ ok: false, problem: expect.stringMatching(/from 1 to 100, with at most 2 decimals/) });
    }
  });

  it("round-trips every allowed amount through the JSON number the browser sends", () => {
    for (let cents = 100n; cents <= 10_000n; cents++) {
      const base = cents * 10_000n;
      const sent: unknown = JSON.parse(JSON.stringify({ a: planAmountToUsdt(base) })).a;
      expect(planAmountFromUsdt(sent)).toEqual({ ok: true, value: base });
    }
    expect(planAmountToUsdt(4_500_000n)).toBe(4.5);
    expect(planAmountToUsdt(5_000_000n)).toBe(5);
    expect(() => planAmountToUsdt(4_555_000n)).toThrow(/2 decimals/);
    expect(() => planAmountToUsdt(500_000n)).toThrow(/at least 1/);
  });

  it("parses the typed amount with the app's decimal parser and the plan rules", () => {
    expect(parsePlanAmountText("4")).toEqual({ ok: true, value: 4_000_000n });
    expect(parsePlanAmountText("4,5")).toEqual({ ok: true, value: 4_500_000n });
    expect(parsePlanAmountText(" 4.50 ")).toEqual({ ok: true, value: 4_500_000n });
    expect(parsePlanAmountText("100")).toEqual({ ok: true, value: 100_000_000n });
    expect(parsePlanAmountText("")).toEqual({ ok: false, problem: "Enter an amount." });
    expect(parsePlanAmountText("0.5")).toEqual({ ok: false, problem: "Enter at least 1 USD₮." });
    expect(parsePlanAmountText("0")).toEqual({ ok: false, problem: "Enter an amount above zero." });
    expect(parsePlanAmountText("150")).toEqual({ ok: false, problem: "Enter at most 100 USD₮." });
    expect(parsePlanAmountText("4.555")).toEqual({ ok: false, problem: "Enter at most 2 decimals." });
    expect(parsePlanAmountText("4.5555555")).toEqual({ ok: false, problem: "Enter at most 2 decimals." });
    expect(parsePlanAmountText("-4")).toMatchObject({ ok: false });
    expect(parsePlanAmountText("1,000.5")).toMatchObject({ ok: false, problem: expect.stringMatching(/one decimal separator/) });
  });
});
