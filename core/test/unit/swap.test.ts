import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, pad, type Address, type Log } from "viem";
import { erc20Abi, erc20TransferEvent, swapRouter02Abi } from "../../src/abis.js";
import { CELO_TOKEN, CELO_USDT_POOL, SWAP_ROUTER_02, USDT } from "../../src/constants.js";
import { celoToUsdt } from "../../src/fees.js";
import { parseAmountText } from "../../src/send.js";
import {
  buildSwapCalls,
  celoToKeep,
  checkSwapAmount,
  checkSwapLogs,
  decodeSwapCalls,
  lowestAllowedMinOut,
  maxSwappable,
  swapFeeInUsdt,
  swapPriceCheck,
} from "../../src/swap.js";

const WALLET = getAddress("0x15855ae2e04fd00efa45cb70d2c29e5777925429") as Address;
const OTHER = getAddress("0x2222222222222222222222222222222222222222") as Address;
const CELO = 10n ** 18n;
// FeeCurrencyDirectory.getExchangeRate(USD₮ adapter) on Celo mainnet, 2026-11-22: 0.05384742 USD₮ per CELO.
const RATE = { numerator: 53_847_420_000_000_000_000_000n, denominator: 10n ** 24n };

describe("buildSwapCalls", () => {
  const calls = buildSwapCalls(WALLET, 100n * CELO, 5_345_000n);

  it("is [CELO.approve(SwapRouter02, exactly amountIn), SwapRouter02.exactInputSingle] with no value", () => {
    expect(calls.map((c) => c.to)).toEqual([CELO_TOKEN, SWAP_ROUTER_02]);
    expect(calls.every((c) => c.value === 0n)).toBe(true);
    expect(calls[0].data.slice(0, 10)).toBe("0x095ea7b3");
    expect(calls[1].data.slice(0, 10)).toBe("0x04e45aaf"); // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
    const a = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
    expect(a.args).toEqual([SWAP_ROUTER_02, 100n * CELO]);
  });

  it("swaps CELO for USD₮ on the 0.01% pool, pays the wallet itself, and carries the floor", () => {
    const s = decodeFunctionData({ abi: swapRouter02Abi, data: calls[1].data });
    expect(s.args[0]).toEqual({
      tokenIn: CELO_TOKEN,
      tokenOut: USDT,
      fee: 100,
      recipient: WALLET,
      amountIn: 100n * CELO,
      amountOutMinimum: 5_345_000n,
      sqrtPriceLimitX96: 0n,
    });
  });

  it("decodes back, and refuses a zero amount or a zero floor", () => {
    expect(decodeSwapCalls(calls, WALLET)).toEqual({ amountIn: 100n * CELO, minOut: 5_345_000n });
    expect(() => buildSwapCalls(WALLET, 0n, 1n)).toThrow();
    expect(() => buildSwapCalls(WALLET, CELO, 0n)).toThrow(/floor/);
  });
});

describe("decodeSwapCalls refuses anything else", () => {
  const [approve, swap] = buildSwapCalls(WALLET, CELO, 50_000n);
  const approveMore = { ...approve, data: buildSwapCalls(WALLET, 2n * CELO, 50_000n)[0].data };
  const cases: [string, Parameters<typeof decodeSwapCalls>[0], RegExp][] = [
    ["one call", [swap], /exactly two/],
    ["an approval larger than the swap", [approveMore, swap], /differs/],
    ["another recipient", [approve, buildSwapCalls(OTHER, CELO, 50_000n)[1]], /does not pay the wallet/],
    ["value on a call", [approve, { ...swap, value: 1n }], /SwapRouter02/],
    ["another token contract", [{ ...approve, to: USDT }, swap], /CELO.approve/],
    ["trailing bytes", [approve, { ...swap, data: `${swap.data}00` as `0x${string}` }], /canonical/],
  ];
  for (const [name, calls, re] of cases) it(name, () => expect(() => decodeSwapCalls(calls, WALLET)).toThrow(re));
});

describe("swapPriceCheck", () => {
  const amount = 100n * CELO;
  const ref = celoToUsdt(amount, RATE); // 5.384742 USD₮

  it("values the amount at the reference rate", () => {
    expect(ref).toBe(5_384_742n);
  });

  it("accepts a quote at or above the reference and sets the floor 1% under the quote", () => {
    const at = swapPriceCheck(amount, ref, RATE);
    expect(at).toMatchObject({ ok: true, referenceOut: ref, belowReferenceBps: 0, minOut: (ref * 99n) / 100n });
    const above = swapPriceCheck(amount, 5_398_941n, RATE); // the mainnet quote for 100 CELO on 2026-11-22
    expect(above).toMatchObject({ ok: true, minOut: 5_344_951n }); // 5,398,941 × 0.99, rounded down
    expect(above.belowReferenceBps).toBeLessThan(0);
  });

  it("accepts exactly 3% below the reference and refuses one unit further down", () => {
    const r = 10_000_000n; // pick an amount worth exactly 10 USD₮ at a round rate
    const rate = { numerator: 10n ** 22n, denominator: 10n ** 24n }; // 0.01 USD₮ per CELO
    const amt = 1000n * CELO;
    expect(celoToUsdt(amt, rate)).toBe(r);
    const edge = (r * 97n) / 100n;
    expect(swapPriceCheck(amt, edge, rate)).toMatchObject({ ok: true, belowReferenceBps: 300, minOut: (edge * 99n) / 100n });
    const below = swapPriceCheck(amt, edge - 1n, rate);
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.reason).toMatch(/below Celo's reference rate/);
  });

  it("refuses a zero quote and an amount too small to value", () => {
    expect(swapPriceCheck(amount, 0n, RATE).ok).toBe(false);
    expect(swapPriceCheck(1n, 1n, RATE)).toMatchObject({ ok: false, reason: expect.stringMatching(/too small/) });
    expect(() => swapPriceCheck(0n, 1n, RATE)).toThrow();
  });

  it("never lets a floor below 3% then 1% under the reference", () => {
    expect(lowestAllowedMinOut(10_000_000n)).toBe(9_603_000n);
    const worst = swapPriceCheck(1000n * CELO, 9_700_000n, { numerator: 10n ** 22n, denominator: 10n ** 24n });
    expect(worst.ok && worst.minOut).toBe(lowestAllowedMinOut(10_000_000n));
  });
});

describe("celoToKeep and maxSwappable", () => {
  const perKey = 9n * CELO + CELO / 2n; // 9.5 CELO with the 10% headroom
  const fee = CELO / 20n; // 0.05 CELO relay fee

  it("registered wallet, fee in USD₮: keeps one key's registration plus 10%", () => {
    const k = celoToKeep({ walletRegistered: true, perKeyFee: perKey, swapRegistration: 0n, swapFeeCelo: 0n });
    expect(k).toEqual({ nextPlan: perKey, thisTransaction: 0n, buffer: perKey / 10n, total: perKey + perKey / 10n });
    expect(maxSwappable(100n * CELO, k)).toBe(100n * CELO - k.total);
  });

  it("registered wallet, fee in CELO: also keeps the fee with 50% headroom", () => {
    const k = celoToKeep({ walletRegistered: true, perKeyFee: perKey, swapRegistration: 0n, swapFeeCelo: fee });
    expect(k.thisTransaction).toBe((fee * 3n) / 2n);
    expect(k.total).toBe(perKey + perKey / 10n + (fee * 3n) / 2n);
  });

  it("first passkey transaction: this swap pays the wallet's registration, the next plan needs one key", () => {
    const k = celoToKeep({ walletRegistered: false, perKeyFee: perKey, swapRegistration: perKey, swapFeeCelo: fee });
    expect(k.nextPlan).toBe(perKey);
    expect(k.thisTransaction).toBe(perKey + (fee * 3n) / 2n);
    expect(k.total).toBe(2n * perKey + perKey / 10n + (fee * 3n) / 2n);
  });

  it("unregistered wallet whose swap does not register it: the next plan needs two keys", () => {
    const k = celoToKeep({ walletRegistered: false, perKeyFee: perKey, swapRegistration: 0n, swapFeeCelo: 0n });
    expect(k.nextPlan).toBe(2n * perKey);
    expect(k.buffer).toBe((2n * perKey) / 10n);
  });

  it("Max is zero when the balance does not cover what is kept", () => {
    const k = celoToKeep({ walletRegistered: true, perKeyFee: perKey, swapRegistration: 0n, swapFeeCelo: fee });
    expect(maxSwappable(k.total, k)).toBe(0n);
    expect(maxSwappable(k.total - 1n, k)).toBe(0n);
    expect(maxSwappable(k.total + 1n, k)).toBe(1n);
  });
});

describe("checkSwapAmount", () => {
  const keep = celoToKeep({ walletRegistered: true, perKeyFee: 10n * CELO, swapRegistration: 0n, swapFeeCelo: CELO / 10n });
  const balance = 50n * CELO;
  const max = maxSwappable(balance, keep);

  it("accepts up to Max without a warning, and above it with one", () => {
    expect(checkSwapAmount(max, balance, keep)).toEqual({ ok: true, leavesTooLittle: false });
    expect(checkSwapAmount(max + 1n, balance, keep)).toEqual({ ok: true, leavesTooLittle: true });
    expect(checkSwapAmount(balance - keep.thisTransaction, balance, keep)).toEqual({ ok: true, leavesTooLittle: true });
  });

  it("refuses zero, more than the balance, and an amount that leaves no room for this transaction's fee", () => {
    expect(checkSwapAmount(0n, balance, keep).ok).toBe(false);
    expect(checkSwapAmount(balance + 1n, balance, keep)).toMatchObject({ ok: false, problem: expect.stringMatching(/more CELO than/) });
    expect(checkSwapAmount(balance - keep.thisTransaction + 1n, balance, keep)).toMatchObject({ ok: false, problem: expect.stringMatching(/network fee/) });
  });

  it("works on amounts typed with a decimal comma (the shared parser)", () => {
    const typed = parseAmountText("1,5", 18);
    expect(typed).toEqual({ ok: true, value: 1_500_000_000_000_000_000n });
    if (typed.ok) expect(checkSwapAmount(typed.value, balance, keep).ok).toBe(true);
    expect(parseAmountText("1,500", 18)).toEqual({ ok: true, value: 1_500_000_000_000_000_000n });
    expect(parseAmountText("1.000,5", 18).ok).toBe(false);
  });
});

describe("swapFeeInUsdt", () => {
  it("pays in USD₮ only when the wallet holds the fee with 50% headroom", () => {
    expect(swapFeeInUsdt(15_000n, 10_000n)).toBe(true);
    expect(swapFeeInUsdt(14_999n, 10_000n)).toBe(false);
    expect(swapFeeInUsdt(0n, 10_000n)).toBe(false);
    expect(swapFeeInUsdt(1_000_000n, 0n)).toBe(false);
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
  const req = { wallet: WALLET, amountIn: 100n * CELO, minOut: 5_344_951n };
  const FEE_RECIPIENT = getAddress("0xaF089b4ECA94A4B2f51D8F5668cFf244f2c6C4bC");

  it("finds the CELO in and the USD₮ out, ignoring the relay fee transfer", () => {
    const logs = [
      transfer(USDT, WALLET, FEE_RECIPIENT, 9_000n, 0),
      transfer(USDT, CELO_USDT_POOL, WALLET, 5_398_941n, 1),
      transfer(CELO_TOKEN, WALLET, CELO_USDT_POOL, 100n * CELO, 2),
    ];
    expect(checkSwapLogs(logs, req)).toEqual({ ok: true, celoIn: 100n * CELO, usdtOut: 5_398_941n });
  });

  it("refuses a transaction without the conversion, a different amount in, or less than the floor out", () => {
    expect(checkSwapLogs([transfer(USDT, WALLET, FEE_RECIPIENT, 9_000n, 0)], req)).toMatchObject({ ok: false, reason: expect.stringMatching(/no conversion/) });
    expect(checkSwapLogs([transfer(USDT, CELO_USDT_POOL, WALLET, 5_398_941n, 0), transfer(CELO_TOKEN, WALLET, CELO_USDT_POOL, CELO, 1)], req).ok).toBe(false);
    expect(checkSwapLogs([transfer(USDT, CELO_USDT_POOL, WALLET, 5_344_950n, 0), transfer(CELO_TOKEN, WALLET, CELO_USDT_POOL, 100n * CELO, 1)], req).ok).toBe(false);
    // USD₮ paid to someone else does not count.
    expect(checkSwapLogs([transfer(USDT, CELO_USDT_POOL, OTHER, 5_398_941n, 0), transfer(CELO_TOKEN, WALLET, CELO_USDT_POOL, 100n * CELO, 1)], req).ok).toBe(false);
  });
});
