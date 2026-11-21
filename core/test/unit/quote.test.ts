import { describe, expect, it } from "vitest";
import { priceUsdtPerXaut, tickFromSqrtPriceX96 } from "../../src/quote.js";

describe("quote math", () => {
  it("converts sqrtPriceX96 to a tick", () => {
    expect(tickFromSqrtPriceX96(2n ** 96n)).toBe(0);
    // price 1.0001^-81700 ≈ 2.83e-4 XAUt0 per USD₮
    const sqrt = BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, -81700.5)) * 2 ** 96));
    expect(tickFromSqrtPriceX96(sqrt)).toBe(-81701);
  });

  it("computes the effective price per whole XAUt0", () => {
    expect(priceUsdtPerXaut(5_000_000n, 1_407n)).toBe(3_553_660_270n);
    expect(() => priceUsdtPerXaut(1n, 0n)).toThrow();
  });
});
