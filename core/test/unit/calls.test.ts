import { describe, expect, it } from "vitest";
import { fromDataSuffix } from "@celo/attribution-tags";
import { decodeFunctionData, getAddress, slice, type Address } from "viem";
import { erc20Abi, goldBuyerAbi } from "../../src/abis.js";
import { ATTRIBUTION_SUFFIX, buildBuyCalls, decodeBuyCalls, stripAttribution } from "../../src/calls.js";
import { ATTRIBUTION_CODE, USDT } from "../../src/constants.js";

const GB = "0x1111111111111111111111111111111111111111" as Address;

describe("buildBuyCalls", () => {
  const calls = buildBuyCalls(5_000_000n, 1_393n, GB);

  it("is the batch [USD₮.approve(GoldBuyer, x), GoldBuyer.buy(x, minOut)] with no value", () => {
    expect(calls.map((c) => c.to)).toEqual([USDT, getAddress(GB)]);
    expect(calls.every((c) => c.value === 0n)).toBe(true);
    expect(calls[0].data.slice(0, 10)).toBe("0x095ea7b3");
  });

  it("appends the ERC-8021 suffix for celo_c24c5a65e5a3 to each call", () => {
    expect(ATTRIBUTION_SUFFIX).toBe("0x63656c6f5f633234633561363565356133110080218021802180218021802180218021");
    for (const c of calls) {
      expect(c.data.toLowerCase().endsWith(ATTRIBUTION_SUFFIX.slice(2).toLowerCase())).toBe(true);
      expect(fromDataSuffix(c.data)?.codes).toEqual([ATTRIBUTION_CODE]);
    }
  });

  it("decodes back to the same calls", () => {
    expect(decodeBuyCalls(calls, GB)).toEqual({ amountIn: 5_000_000n, minOut: 1_393n, tagged: true });
    const a = decodeFunctionData({ abi: erc20Abi, data: stripAttribution(calls[0].data).body });
    expect(a.args).toEqual([getAddress(GB), 5_000_000n]);
    const b = decodeFunctionData({ abi: goldBuyerAbi, data: stripAttribution(calls[1].data).body });
    expect(b).toMatchObject({ functionName: "buy", args: [5_000_000n, 1_393n] });
    // The session guard reads the amount at offset 0x24 of the approve calldata: still intact.
    expect(BigInt(slice(calls[0].data, 36, 68))).toBe(5_000_000n);
  });

  it("refuses a zero floor or a zero amount", () => {
    expect(() => buildBuyCalls(5_000_000n, 0n, GB)).toThrow(/floor/);
    expect(() => buildBuyCalls(0n, 1n, GB)).toThrow();
  });

  it("decodeBuyCalls rejects a tampered batch", () => {
    const other = "0x3333333333333333333333333333333333333333" as Address;
    expect(() => decodeBuyCalls([calls[0], { ...calls[1], to: other }], GB)).toThrow();
    const mismatched = buildBuyCalls(6_000_000n, 1n, GB);
    expect(() => decodeBuyCalls([mismatched[0], calls[1]], GB)).toThrow(/differs/);
  });
});
