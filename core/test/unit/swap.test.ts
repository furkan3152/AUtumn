import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, pad, type Address, type Log } from "viem";
import { erc20Abi, erc20TransferEvent, swapRouter02Abi } from "../../src/abis.js";
import { CELO_TOKEN, CELO_USDT_POOL, SWAP_ROUTER_02, USDT, USDT_XAUT0_POOL, XAUT0 } from "../../src/constants.js";
import { celoToUsdt } from "../../src/fees.js";
import { parseAmountText } from "../../src/send.js";
import {
  SWAP_ASSETS,
  buildSwapCalls,
  celoToKeep,
  checkSwapAmount,
  checkSwapLogs,
  decodeSwapCalls,
  encodeSwapPath,
  lowestAllowedMinOut,
  maxSwappable,
  referenceValue,
  routeFeeText,
  spotValue,
  sqrtRatioAtTick,
  swapFeeInUsdt,
  swapFeeToken,
  swapMax,
  swapPriceCheck,
  swapRoute,
  usdtToCelo,
  valueAtSqrtPrice,
  type SwapAsset,
  type SwapFees,
} from "../../src/swap.js";

const WALLET = getAddress("0x15855ae2e04fd00efa45cb70d2c29e5777925429") as Address;
const OTHER = getAddress("0x2222222222222222222222222222222222222222") as Address;
const CELO = 10n ** 18n;
const USD = 10n ** 6n;
// FeeCurrencyDirectory.getExchangeRate(USD₮ adapter) on Celo mainnet, 2026-11-22: 0.05384742 USD₮ per CELO.
const RATE = { numerator: 53_847_420_000_000_000_000_000n, denominator: 10n ** 24n };
// The USD₮/XAUt0 pool's tick on 2026-11-22 (slot0): -81770, sqrtPriceX96 1328493075683621728037229051.
const GOLD_TICK = -81_770;
const GOLD_SQRT = 1_328_493_075_683_621_728_037_229_051n;
const PAIRS: [SwapAsset, SwapAsset][] = SWAP_ASSETS.flatMap((a) => SWAP_ASSETS.filter((b) => b !== a).map((b) => [a, b] as [SwapAsset, SwapAsset]));

describe("swapRoute and the packed path", () => {
  it("goes direct for CELO ↔ USD₮ and USD₮ ↔ gold, through USD₮ for CELO ↔ gold", () => {
    expect(swapRoute("CELO", "USDT").hops).toEqual([{ tokenIn: CELO_TOKEN, tokenOut: USDT, fee: 100, pool: getAddress(CELO_USDT_POOL), zeroForOne: true }]);
    expect(swapRoute("USDT", "CELO").hops[0]).toMatchObject({ fee: 100, zeroForOne: false });
    expect(swapRoute("USDT", "XAUT0").hops).toEqual([{ tokenIn: USDT, tokenOut: XAUT0, fee: 3000, pool: getAddress(USDT_XAUT0_POOL), zeroForOne: true }]);
    expect(swapRoute("XAUT0", "USDT").hops[0]).toMatchObject({ fee: 3000, zeroForOne: false });
    expect(swapRoute("CELO", "XAUT0").hops.map((h) => [h.tokenIn, h.fee, h.tokenOut])).toEqual([[CELO_TOKEN, 100, USDT], [USDT, 3000, XAUT0]]);
    expect(swapRoute("XAUT0", "CELO").hops.map((h) => [h.tokenIn, h.fee, h.tokenOut])).toEqual([[XAUT0, 3000, USDT], [USDT, 100, CELO_TOKEN]]);
    expect(() => swapRoute("USDT", "USDT")).toThrow(/different/);
    expect(routeFeeText(swapRoute("CELO", "XAUT0"))).toBe("0.01% and 0.3%");
  });

  it("packs token, 3-byte fee, token, … (the path used on mainnet read-only)", () => {
    expect(encodeSwapPath(swapRoute("CELO", "XAUT0")).toLowerCase()).toBe(
      "0x471ece3750da237f93b8e339c536989b8978a43800006448065fbbe25f71c9282ddf5e1cd6d6a887483d5e000bb8af37e8b6c9ed7f6318979f56fc287d76c30847ff",
    );
    expect(encodeSwapPath(swapRoute("XAUT0", "CELO")).toLowerCase()).toBe(
      "0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff000bb848065fbbe25f71c9282ddf5e1cd6d6a887483d5e000064471ece3750da237f93b8e339c536989b8978a438",
    );
  });
});

describe("buildSwapCalls", () => {
  it("approves exactly amountIn of the asset sold to SwapRouter02, then swaps paying the wallet, for every direction", () => {
    for (const [from, to] of PAIRS) {
      const amount = from === "CELO" ? 3n * CELO : 2n * USD;
      const calls = buildSwapCalls(WALLET, from, to, amount, 77n);
      expect(calls.every((c) => c.value === 0n)).toBe(true);
      expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([SWAP_ROUTER_02, amount]);
      expect(calls[1].to).toBe(SWAP_ROUTER_02);
      expect(decodeSwapCalls(calls, WALLET)).toEqual({ from, to, amountIn: amount, minOut: 77n });
    }
  });

  it("uses exactInputSingle for one pool and exactInput with the path for two", () => {
    const single = decodeFunctionData({ abi: swapRouter02Abi, data: buildSwapCalls(WALLET, "XAUT0", "USDT", 200n, 600_000n)[1].data });
    expect(single.functionName).toBe("exactInputSingle");
    expect(single.args[0]).toEqual({ tokenIn: XAUT0, tokenOut: USDT, fee: 3000, recipient: WALLET, amountIn: 200n, amountOutMinimum: 600_000n, sqrtPriceLimitX96: 0n });
    const multi = decodeFunctionData({ abi: swapRouter02Abi, data: buildSwapCalls(WALLET, "CELO", "XAUT0", 20n * CELO, 290n)[1].data });
    expect(multi.functionName).toBe("exactInput");
    expect({ ...multi.args[0], path: multi.args[0].path.toLowerCase() }).toEqual({ path: encodeSwapPath(swapRoute("CELO", "XAUT0")).toLowerCase(), recipient: WALLET, amountIn: 20n * CELO, amountOutMinimum: 290n });
    expect(buildSwapCalls(WALLET, "CELO", "XAUT0", 1n, 1n)[1].data.slice(0, 10)).toBe("0xb858183f");
  });

  it("refuses a zero amount or a zero floor", () => {
    expect(() => buildSwapCalls(WALLET, "USDT", "XAUT0", 0n, 1n)).toThrow();
    expect(() => buildSwapCalls(WALLET, "USDT", "XAUT0", 1n, 0n)).toThrow(/floor/);
  });
});

describe("decodeSwapCalls refuses anything else", () => {
  const [approve, swap] = buildSwapCalls(WALLET, "CELO", "XAUT0", CELO, 15n);
  const cases: [string, Parameters<typeof decodeSwapCalls>[0], RegExp][] = [
    ["one call", [swap], /exactly two/],
    ["an approval larger than the swap", [{ ...approve, data: buildSwapCalls(WALLET, "CELO", "XAUT0", 2n * CELO, 15n)[0].data }, swap], /differs/],
    ["another recipient", [approve, buildSwapCalls(OTHER, "CELO", "XAUT0", CELO, 15n)[1]], /canonical/],
    ["approving another token than the swap sells", [{ ...approve, to: USDT }, swap], /canonical/],
    ["value on a call", [approve, { ...swap, value: 1n }], /SwapRouter02/],
    ["an unknown token", [{ ...approve, to: OTHER }, swap], /first call/],
    ["trailing bytes", [approve, { ...swap, data: `${swap.data}00` as `0x${string}` }], /canonical/],
  ];
  for (const [name, calls, re] of cases) it(name, () => expect(() => decodeSwapCalls(calls, WALLET)).toThrow(re));
});

describe("prices", () => {
  it("computes TickMath's sqrt ratios exactly", () => {
    expect(sqrtRatioAtTick(0)).toBe(1n << 96n);
    expect(sqrtRatioAtTick(-887_272)).toBe(4_295_128_739n);
    expect(sqrtRatioAtTick(887_272)).toBe(1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n);
    // The pool's slot0 price lies between its tick and the next.
    expect(sqrtRatioAtTick(GOLD_TICK) <= GOLD_SQRT && GOLD_SQRT < sqrtRatioAtTick(GOLD_TICK + 1)).toBe(true);
  });

  it("values gold legs at the pool price in both directions, and CELO legs at Celo's rate", () => {
    // 1 USD₮ buys about 0.000281 XAUt0 at this tick (gold at about $3,560 an ounce).
    expect(valueAtSqrtPrice(USD, GOLD_SQRT, true)).toBe(281n);
    expect(valueAtSqrtPrice(281n, GOLD_SQRT, false)).toBe(999_417n);
    expect(usdtToCelo(celoToUsdt(100n * CELO, RATE), RATE)).toBeLessThanOrEqual(100n * CELO);
    expect(usdtToCelo(5_384_742n, RATE)).toBe(100n * CELO);
    const ref = { celoRate: RATE, goldTwapTick: GOLD_TICK };
    expect(referenceValue(swapRoute("CELO", "USDT"), 100n * CELO, ref)).toBe(5_384_742n);
    expect(referenceValue(swapRoute("CELO", "XAUT0"), 100n * CELO, ref)).toBe(valueAtSqrtPrice(5_384_742n, sqrtRatioAtTick(GOLD_TICK), true));
    expect(referenceValue(swapRoute("XAUT0", "CELO"), 1_000n, ref)).toBe(usdtToCelo(valueAtSqrtPrice(1_000n, sqrtRatioAtTick(GOLD_TICK), false), RATE));
    // A missing reference is null, never a guess.
    expect(referenceValue(swapRoute("USDT", "XAUT0"), USD, { celoRate: RATE, goldTwapTick: null })).toBeNull();
    expect(referenceValue(swapRoute("USDT", "CELO"), USD, { celoRate: null, goldTwapTick: GOLD_TICK })).toBeNull();
    expect(spotValue(swapRoute("USDT", "XAUT0"), USD, [GOLD_SQRT])).toBe(281n);
  });
});

describe("swapPriceCheck", () => {
  it("accepts exactly 3% below the reference, refuses one unit further down, and sets the floor 1% under the quote", () => {
    const ref = 10_000_000n;
    expect(swapPriceCheck({ quotedOut: 9_700_000n, referenceOut: ref })).toMatchObject({ ok: true, belowReferenceBps: 300, minOut: 9_603_000n });
    expect(swapPriceCheck({ quotedOut: 9_699_999n, referenceOut: ref })).toMatchObject({ ok: false, refusal: "price" });
    // The floor is the quote less 1%, rounded down: 5,398,941 × 0.99 = 5,344,951.59.
    expect(swapPriceCheck({ quotedOut: 5_398_941n, referenceOut: 5_384_742n })).toMatchObject({ ok: true, minOut: 5_344_951n });
    expect(lowestAllowedMinOut(ref)).toBe(9_603_000n);
  });

  it("the same boundaries hold for a gold amount (6 decimals, small numbers)", () => {
    expect(swapPriceCheck({ quotedOut: 291n, referenceOut: 300n })).toMatchObject({ ok: true, minOut: 288n });
    expect(swapPriceCheck({ quotedOut: 290n, referenceOut: 300n }).ok).toBe(false);
  });

  it("tells a price-moving amount from a pool that is off its reference", () => {
    const impact = swapPriceCheck({ quotedOut: 900n, referenceOut: 1_000n, spotOut: 999n });
    expect(swapPriceCheck({ quotedOut: 900_000n, referenceOut: 1_000_000n, spotOut: 999_000n })).toMatchObject({ ok: false, refusal: "impact" });
    expect(impact).toMatchObject({ ok: false, refusal: "impact", reason: expect.stringMatching(/moves the pool's price too much.*try a smaller amount/) });
    const off = swapPriceCheck({ quotedOut: 900n, referenceOut: 1_000n, spotOut: 920n });
    expect(off).toMatchObject({ ok: false, refusal: "price", reason: expect.stringMatching(/below the reference price/) });
    expect(swapPriceCheck({ quotedOut: 900n, referenceOut: 1_000n })).toMatchObject({ ok: false, refusal: "price" });
  });

  it("calls a refusal of a tiny amount (rounding) too small, not price impact", () => {
    // 30 base units of XAUt0 → USD₮ on 2026-11-22: the pool rounds its 0.3% fee up to a whole unit, 3.33% of the amount.
    expect(swapPriceCheck({ quotedOut: 103_142n, referenceOut: 106_701n, spotOut: 106_701n, amountIn: 30n })).toMatchObject({ ok: false, refusal: "too-small", reason: expect.stringMatching(/try a larger amount/) });
    expect(swapPriceCheck({ quotedOut: 103_142n, referenceOut: 106_701n, spotOut: 106_701n, amountIn: 1_000n })).toMatchObject({ ok: false, refusal: "impact" });
    // 0.01 USD₮ buys 2 base units of XAUt0 where 2.8 are due: rounding of the output, also too small.
    expect(swapPriceCheck({ quotedOut: 2n, referenceOut: 3n, spotOut: 3n, amountIn: 10_000n })).toMatchObject({ ok: false, refusal: "too-small" });
  });

  it("refuses a zero quote and an amount worth nothing", () => {
    expect(swapPriceCheck({ quotedOut: 0n, referenceOut: 10n })).toMatchObject({ ok: false, refusal: "too-small" });
    expect(swapPriceCheck({ quotedOut: 1n, referenceOut: 0n })).toMatchObject({ ok: false, refusal: "too-small" });
    expect(swapPriceCheck({ quotedOut: 1n, referenceOut: 1n })).toMatchObject({ ok: false, refusal: "too-small" });
  });
});

describe("celoToKeep", () => {
  const perKey = 9n * CELO + CELO / 2n;
  const fee = CELO / 20n;
  it("registered or not, fee in CELO or USD₮", () => {
    expect(celoToKeep({ walletRegistered: true, perKeyFee: perKey, swapRegistration: 0n, swapFeeCelo: 0n })).toEqual({ nextPlan: perKey, thisTransaction: 0n, buffer: perKey / 10n, total: perKey + perKey / 10n });
    expect(celoToKeep({ walletRegistered: true, perKeyFee: perKey, swapRegistration: 0n, swapFeeCelo: fee }).thisTransaction).toBe((fee * 3n) / 2n);
    const first = celoToKeep({ walletRegistered: false, perKeyFee: perKey, swapRegistration: perKey, swapFeeCelo: fee });
    expect(first).toMatchObject({ nextPlan: perKey, thisTransaction: perKey + (fee * 3n) / 2n });
    expect(celoToKeep({ walletRegistered: false, perKeyFee: perKey, swapRegistration: 0n, swapFeeCelo: 0n }).nextPlan).toBe(2n * perKey);
    const k = celoToKeep({ walletRegistered: true, perKeyFee: perKey, swapRegistration: 0n, swapFeeCelo: fee });
    expect(maxSwappable(k.total, k)).toBe(0n);
    expect(maxSwappable(k.total + 1n, k)).toBe(1n);
  });
});

describe("fee token, Max and amount checks per asset", () => {
  const plan = { walletRegistered: true, perKeyFee: 10n * CELO };
  const fees: SwapFees = { usdt: 10_000n, celo: CELO / 10n, registration: 0n }; // 0.01 USD₮ or 0.1 CELO
  const b = { celo: 50n * CELO, usdt: 20n * USD, xaut0: 3_000n };

  it("pays in USD₮ only when the USD₮ left after the swap holds the fee with 50% headroom", () => {
    expect(swapFeeInUsdt(15_000n, 10_000n)).toBe(true);
    expect(swapFeeInUsdt(14_999n, 10_000n)).toBe(false);
    expect(swapFeeToken("XAUT0", 3_000n, b, fees)).toBe("USDT");
    expect(swapFeeToken("USDT", 20n * USD - 15_000n, b, fees)).toBe("USDT");
    expect(swapFeeToken("USDT", 20n * USD - 14_999n, b, fees)).toBe("CELO");
    expect(swapFeeToken("USDT", 1n, b, { ...fees, usdt: null })).toBe("CELO");
    expect(swapFeeToken("USDT", 1n, b, { ...fees, usdt: null, celo: null })).toBeNull();
  });

  it("Max: CELO keeps the next plan's registration; USD₮ leaves the USD₮ fee; gold is the whole balance", () => {
    expect(swapMax("CELO", b, fees, plan)).toEqual({ max: 50n * CELO - 11n * CELO, keep: { nextPlan: 10n * CELO, thisTransaction: 0n, buffer: CELO, total: 11n * CELO } });
    const noUsdt = { ...b, usdt: 0n };
    const viaCelo = swapMax("CELO", noUsdt, fees, plan);
    expect(viaCelo.keep?.thisTransaction).toBe((CELO * 15n) / 100n);
    expect(swapMax("USDT", b, fees, plan)).toEqual({ max: 20n * USD - 15_000n, keep: null });
    expect(swapMax("USDT", { ...b, usdt: 10_000n }, fees, plan).max).toBe(0n);
    expect(swapMax("USDT", b, { ...fees, usdt: null }, plan).max).toBe(20n * USD);
    expect(swapMax("XAUT0", b, fees, plan)).toEqual({ max: 3_000n, keep: null });
  });

  it("selling all USD₮ moves the fee to CELO, and is refused when CELO cannot pay it either", () => {
    expect(checkSwapAmount("USDT", 20n * USD, b, fees, plan)).toEqual({ ok: true, feeToken: "CELO", leavesTooLittle: false });
    const noCelo = { ...b, celo: (CELO * 15n) / 100n - 1n };
    expect(checkSwapAmount("USDT", 20n * USD, noCelo, fees, plan)).toMatchObject({ ok: false, problem: expect.stringMatching(/network fee/) });
    // At Max the fee stays in USD₮, and amount + fee never exceeds the balance.
    const atMax = checkSwapAmount("USDT", 20n * USD - 15_000n, noCelo, fees, plan);
    expect(atMax).toEqual({ ok: true, feeToken: "USDT", leavesTooLittle: false });
  });

  it("CELO above Max warns, CELO past the fee is refused; gold and others refuse zero and over-balance", () => {
    expect(checkSwapAmount("CELO", 39n * CELO, b, fees, plan)).toEqual({ ok: true, feeToken: "USDT", leavesTooLittle: false });
    expect(checkSwapAmount("CELO", 45n * CELO, b, fees, plan)).toEqual({ ok: true, feeToken: "USDT", leavesTooLittle: true });
    const noUsdt = { ...b, usdt: 0n };
    expect(checkSwapAmount("CELO", 50n * CELO, noUsdt, fees, plan)).toMatchObject({ ok: false, problem: expect.stringMatching(/too little CELO/) });
    expect(checkSwapAmount("XAUT0", 0n, b, fees, plan).ok).toBe(false);
    expect(checkSwapAmount("XAUT0", 3_001n, b, fees, plan)).toMatchObject({ ok: false, problem: expect.stringMatching(/more gold/) });
    expect(checkSwapAmount("XAUT0", 3_000n, b, fees, plan)).toMatchObject({ ok: true, feeToken: "USDT" });
  });

  it("a first passkey transaction needs CELO for the registration whatever is sold", () => {
    const reg = { ...fees, registration: 10n * CELO };
    expect(checkSwapAmount("XAUT0", 1_000n, { ...b, celo: 10n * CELO - 1n }, reg, { ...plan, walletRegistered: false })).toMatchObject({ ok: false, problem: expect.stringMatching(/registration/) });
    expect(checkSwapAmount("XAUT0", 1_000n, { ...b, celo: 10n * CELO }, reg, { ...plan, walletRegistered: false }).ok).toBe(true);
  });

  it("parses amounts with the shared parser at each asset's decimals", () => {
    expect(parseAmountText("1,5", 18)).toEqual({ ok: true, value: 1_500_000_000_000_000_000n });
    expect(parseAmountText("1,5", 6)).toEqual({ ok: true, value: 1_500_000n });
    expect(parseAmountText("0,000281", 6)).toEqual({ ok: true, value: 281n });
    expect(parseAmountText("0.0000001", 6)).toEqual({ ok: false, problem: "Enter at most 6 decimals." });
    expect(parseAmountText("1.000,5", 18).ok).toBe(false);
  });
});

describe("checkSwapLogs", () => {
  const transfer = (token: Address, from: Address, to: Address, value: bigint, i: number): Log =>
    ({
      address: token,
      topics: encodeEventTopics({ abi: [erc20TransferEvent], eventName: "Transfer", args: { from, to } }),
      data: encodeAbiParameters([{ type: "uint256" }], [value]),
      blockHash: pad("0x01", { size: 32 }),
      blockNumber: 1n,
      logIndex: i,
      transactionHash: pad("0x02", { size: 32 }),
      transactionIndex: 0,
      removed: false,
    }) as Log;
  const FEE_RECIPIENT = getAddress("0xaF089b4ECA94A4B2f51D8F5668cFf244f2c6C4bC");
  const CP = getAddress(CELO_USDT_POOL);
  const GP = getAddress(USDT_XAUT0_POOL);

  it("CELO → USD₮: CELO in, USD₮ out, ignoring the relay fee", () => {
    const req = { wallet: WALLET, from: "CELO" as const, to: "USDT" as const, amountIn: 100n * CELO, minOut: 5_344_951n };
    const logs = [transfer(USDT, WALLET, FEE_RECIPIENT, 9_000n, 0), transfer(USDT, CP, WALLET, 5_398_941n, 1), transfer(CELO_TOKEN, WALLET, CP, 100n * CELO, 2)];
    expect(checkSwapLogs(logs, req)).toEqual({ ok: true, amountIn: 100n * CELO, amountOut: 5_398_941n });
    expect(checkSwapLogs([transfer(USDT, WALLET, FEE_RECIPIENT, 9_000n, 0)], req)).toMatchObject({ ok: false, reason: expect.stringMatching(/no conversion/) });
    expect(checkSwapLogs([transfer(USDT, CP, WALLET, 5_344_950n, 0), transfer(CELO_TOKEN, WALLET, CP, 100n * CELO, 1)], req).ok).toBe(false);
    expect(checkSwapLogs([transfer(USDT, CP, OTHER, 5_398_941n, 0), transfer(CELO_TOKEN, WALLET, CP, 100n * CELO, 1)], req).ok).toBe(false);
  });

  it("USD₮ → gold with the fee in USD₮: the fee transfer does not count as the amount in", () => {
    const req = { wallet: WALLET, from: "USDT" as const, to: "XAUT0" as const, amountIn: USD, minOut: 277n };
    const logs = [transfer(USDT, WALLET, FEE_RECIPIENT, 9_000n, 0), transfer(XAUT0, GP, WALLET, 280n, 1), transfer(USDT, WALLET, GP, USD, 2)];
    expect(checkSwapLogs(logs, req)).toEqual({ ok: true, amountIn: USD, amountOut: 280n });
    expect(checkSwapLogs([transfer(XAUT0, GP, WALLET, 280n, 1), transfer(USDT, WALLET, GP, USD + 1n, 2)], req).ok).toBe(false);
  });

  it("CELO → gold through USD₮: CELO to the first pool, gold from the last", () => {
    const req = { wallet: WALLET, from: "CELO" as const, to: "XAUT0" as const, amountIn: 20n * CELO, minOut: 299n };
    const logs = [
      transfer(CELO_TOKEN, WALLET, CP, 20n * CELO, 0),
      transfer(USDT, CP, SWAP_ROUTER_02, 1_079_000n, 1),
      transfer(USDT, SWAP_ROUTER_02, GP, 1_079_000n, 2),
      transfer(XAUT0, GP, WALLET, 302n, 3),
    ];
    expect(checkSwapLogs(logs, req)).toEqual({ ok: true, amountIn: 20n * CELO, amountOut: 302n });
    expect(checkSwapLogs(logs.slice(0, 3), req).ok).toBe(false);
  });
});
