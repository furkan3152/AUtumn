import { BaseError, ContractFunctionRevertedError, type PublicClient } from "viem";
import { pinnedBlock } from "./client.js";
import { quoterV2Abi, uniswapV3PoolAbi } from "./abis.js";
import {
  GOLD_BUYER_MAX_TICK_DROP,
  GOLD_BUYER_TWAP_WINDOW_SECS,
  POOL_FEE,
  QUOTER_V2,
  USDT,
  USDT_XAUT0_POOL,
  XAUT0,
} from "./constants.js";

export type QuoteOptions = {
  /** minOut = quoted out × (1 − slippageBps). Default 50 (0.5%). */
  slippageBps?: number;
  /**
   * How far the quote may fall short of the 30-minute TWAP price after the
   * 0.3% pool fee before the purchase is skipped. Default 100 (1%), the same
   * width as GoldBuyer's own onchain floor.
   */
  maxTwapDeviationBps?: number;
  blockNumber?: bigint;
};

export type BuyQuote = {
  amountIn: bigint;
  /** XAUt0 base units QuoterV2 says the swap returns now. */
  amountOut: bigint;
  /** The floor passed to GoldBuyer.buy. */
  minOut: bigint;
  /** XAUt0 the same amount would buy at the 30-minute average price, after the pool fee; null without a TWAP. */
  twapAmountOut: bigint | null;
  /** How much worse than the TWAP price the quote is, in bps (negative = better); null without a TWAP. */
  twapDeviationBps: number | null;
  /** null when the pool cannot report a 30-minute average. */
  twapTick: number | null;
  /** Pool tick after the quoted swap; GoldBuyer reverts if it ends below twapTick − 100. */
  tickAfter: number;
  /** True when the quote is inside both bounds and GoldBuyer's floor is predicted to pass. */
  withinBound: boolean;
  /** Why the quote is outside the bound, when it is. */
  reason?: string;
  /** USD₮ base units per 1 XAUt0 (1e6 base units), from this quote: amountIn × 1e6 / amountOut. */
  priceUsdtPerXaut: bigint;
  blockNumber: bigint;
};

const LOG_TICK_BASE = Math.log(1.0001);

/** Pool tick for a sqrtPriceX96 (floor, as TickMath does). */
export function tickFromSqrtPriceX96(sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return Math.floor(Math.log(ratio * ratio) / LOG_TICK_BASE);
}

/** Effective USD₮ price of one whole XAUt0 for a trade, in USD₮ base units. Both tokens have 6 decimals. */
export function priceUsdtPerXaut(amountIn: bigint, amountOut: bigint): bigint {
  if (amountOut <= 0n) throw new Error("amountOut must be positive");
  return (amountIn * 1_000_000n) / amountOut;
}

function bps(n: number | undefined, dflt: number, name: string): bigint {
  const v = n ?? dflt;
  if (!Number.isInteger(v) || v < 0 || v >= 10_000) throw new Error(`${name} must be an integer in [0, 10000)`);
  return BigInt(v);
}

/**
 * Average tick over GoldBuyer's TWAP window, truncated toward zero like
 * Solidity. Returns null when the pool cannot report it: the pool reverts
 * "OLD" when its oracle holds less than 30 minutes of history (on 2026-11-21
 * its observation cardinality was 1, so this happens whenever someone swapped
 * in the last 30 minutes). GoldBuyer.buy reverts in exactly that case.
 */
export async function readTwapTick(client: PublicClient, blockNumber?: bigint): Promise<number | null> {
  try {
    const [cumulatives] = await client.readContract({
      address: USDT_XAUT0_POOL,
      abi: uniswapV3PoolAbi,
      functionName: "observe",
      args: [[GOLD_BUYER_TWAP_WINDOW_SECS, 0]],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    const [c0, c1] = cumulatives as readonly [bigint, bigint];
    return Number((c1 - c0) / BigInt(GOLD_BUYER_TWAP_WINDOW_SECS));
  } catch (err) {
    if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError)) return null;
    throw err;
  }
}

/**
 * Quotes a USD₮ → XAUt0 purchase on the 0.3% pool with QuoterV2 (eth_call),
 * derives minOut from the slippage bound, and checks the quote against the
 * pool's 30-minute TWAP and GoldBuyer's onchain floor.
 */
export async function quoteBuy(client: PublicClient, amountIn: bigint, opts: QuoteOptions = {}): Promise<BuyQuote> {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  const slippage = bps(opts.slippageBps, 50, "slippageBps");
  const maxDev = bps(opts.maxTwapDeviationBps, 100, "maxTwapDeviationBps");
  const blockNumber = opts.blockNumber ?? (await pinnedBlock(client));

  const [{ result }, twapTick] = await Promise.all([
    client.simulateContract({
      address: QUOTER_V2,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: USDT, tokenOut: XAUT0, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
      blockNumber,
    }),
    readTwapTick(client, blockNumber),
  ]);
  const [amountOut, sqrtPriceX96After] = result;
  const tickAfter = tickFromSqrtPriceX96(sqrtPriceX96After);
  const minOut = (amountOut * (10_000n - slippage)) / 10_000n;
  const priceUsdt = amountOut > 0n ? priceUsdtPerXaut(amountIn, amountOut) : 0n;

  if (twapTick === null) {
    return {
      amountIn,
      amountOut,
      minOut,
      twapAmountOut: null,
      twapDeviationBps: null,
      twapTick: null,
      tickAfter,
      withinBound: false,
      reason: "the pool has less than 30 minutes of price history, so GoldBuyer would refuse the purchase",
      priceUsdtPerXaut: priceUsdt,
      blockNumber,
    };
  }

  // Out at the TWAP price (token1 per token0 = 1.0001^tick), less the pool fee.
  const twapOutFloat = Number(amountIn) * Math.pow(1.0001, twapTick) * (1 - POOL_FEE / 1_000_000);
  const twapAmountOut = BigInt(Math.floor(twapOutFloat));
  const twapDeviationBps = twapOutFloat > 0 ? Math.round(((twapOutFloat - Number(amountOut)) / twapOutFloat) * 10_000) : 0;

  let reason: string | undefined;
  if (amountOut === 0n || minOut === 0n) reason = "the quote returns no gold for this amount";
  else if (twapDeviationBps > Number(maxDev))
    reason = `the quote is ${(twapDeviationBps / 100).toFixed(2)}% below the 30-minute average price (limit ${(Number(maxDev) / 100).toFixed(2)}%)`;
  else if (tickAfter < twapTick - GOLD_BUYER_MAX_TICK_DROP)
    reason = "the swap would move the price below GoldBuyer's TWAP floor";

  return {
    amountIn,
    amountOut,
    minOut,
    twapAmountOut,
    twapDeviationBps,
    twapTick,
    tickAfter,
    withinBound: reason === undefined,
    ...(reason ? { reason } : {}),
    priceUsdtPerXaut: priceUsdt,
    blockNumber,
  };
}
