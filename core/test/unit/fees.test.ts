import { describe, expect, it } from "vitest";
import { getAddress, zeroAddress } from "viem";
import { USDT } from "../../src/constants.js";
import { celoToUsdt, estimateBuyCost, estimateRelayFeeUsdt, relayFeeVerdict } from "../../src/fees.js";

// FeeCurrencyDirectory.getExchangeRate(USD₮ adapter) on Celo mainnet, 2026-11-21: 0.0522142 USD₮ per CELO.
const RATE = { numerator: 52_214_200_000_000_000_000_000n, denominator: 10n ** 24n };

describe("relayFeeVerdict", () => {
  it("accepts a USD₮ fee up to the per-buy allowance, inclusive", () => {
    expect(relayFeeVerdict({ fee: 5_000n, feeToken: USDT }, 50_000n)).toEqual({ ok: true });
    expect(relayFeeVerdict({ fee: 50_000n, feeToken: getAddress(USDT.toLowerCase()) }, 50_000n)).toEqual({ ok: true });
  });

  it("refuses a fee above the allowance, or in another token", () => {
    expect(relayFeeVerdict({ fee: 50_001n, feeToken: USDT }, 50_000n)).toMatchObject({ ok: false, reason: expect.stringMatching(/more than/) });
    expect(relayFeeVerdict({ fee: 1n, feeToken: zeroAddress }, 50_000n)).toMatchObject({ ok: false, reason: expect.stringMatching(/other than USD₮/) });
  });
});

describe("CELO price and cost estimates", () => {
  it("converts CELO to USD₮ with the onchain rate", () => {
    expect(celoToUsdt(20n * 10n ** 18n, RATE)).toBe(1_044_284n); // 20 CELO ≈ $1.04
  });

  it("estimates the relay fee from gas price, and the all-in cost of a buy", () => {
    const relay = estimateRelayFeeUsdt(202_500_000_000n, RATE); // 202.5 gwei × 1.8M gas
    expect(relay).toBe(19_032n);
    expect(estimateBuyCost(5_000_000n, relay)).toEqual({ poolFee: 15_000n, relayFee: 19_032n, total: 34_032n, totalBps: 68 });
    expect(estimateBuyCost(1_000_000n, relay).totalBps).toBe(220);
  });
});
