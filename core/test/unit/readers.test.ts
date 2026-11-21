import { describe, expect, it } from "vitest";
import { midPriceFromSqrtPriceX96 } from "../../src/readers.js";

describe("midPriceFromSqrtPriceX96", () => {
  it("turns the pool's sqrt price into USD₮ per XAUt0 (token0 = USD₮, token1 = XAUt0)", () => {
    // slot0 of 0xbb46…B4F9 read on 2026-11-21: tick -81761.
    const p = midPriceFromSqrtPriceX96(1329086276586022801936281996n);
    expect(p).toBeGreaterThan(3_500_000_000n);
    expect(p).toBeLessThan(3_600_000_000n);
    // 1.0001^81761 ≈ 3,553: the tick and the sqrt price agree.
    expect(Number(p) / 1e6).toBeCloseTo(Math.pow(1.0001, 81761), -1);
  });

  it("is exact for a price of 1", () => {
    expect(midPriceFromSqrtPriceX96(1n << 96n)).toBe(1_000_000n);
  });
});
