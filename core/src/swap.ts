/**
 * Converting between the wallet's three assets (CELO, USD₮ and gold, XAUt0)
 * with the owner's passkey: the two calls (an exact approve of the asset sold
 * and one SwapRouter02 swap, through USD₮ for CELO ↔ gold), the price checks,
 * the fee token, and how much the wallet keeps. Pure helpers plus one chain
 * read (`quoteSwapRoute`).
 *
 * Routes (Uniswap v3 on Celo, verified read-only 2026-11-22):
 * - CELO ↔ USD₮: the 0.01% pool (`CELO_USDT_POOL`), token0 = CELO.
 * - USD₮ ↔ XAUt0: the 0.3% pool GoldBuyer uses (`USDT_XAUT0_POOL`), token0 = USD₮.
 * - CELO ↔ XAUt0: both, in one `exactInput` swap through USD₮.
 *
 * Reference prices: CELO ↔ USD₮ from Celo's FeeCurrencyDirectory (the rate
 * the app shows CELO's dollar value with); USD₮ ↔ XAUt0 from the gold pool's
 * own 30-minute average tick (the observations GoldBuyer's floor reads).
 */
import { concat, decodeFunctionData, encodeFunctionData, getAddress, numberToHex, parseEventLogs, type Address, type Hex, type Log, type PublicClient } from "viem";
import { erc20Abi, erc20TransferEvent, quoterV2Abi, swapRouter02Abi, uniswapV3PoolAbi } from "./abis.js";
import { pinnedBlock } from "./client.js";
import { CELO_TOKEN, CELO_USDT_POOL, CELO_USDT_POOL_FEE, POOL_FEE, QUOTER_V2, SWAP_ROUTER_02, USDT, USDT_XAUT0_POOL, XAUT0 } from "./constants.js";
import { celoToUsdt, readCeloUsdtRate, type CeloRate } from "./fees.js";
import { readTwapTick } from "./quote.js";
import { SEND_FEE_HEADROOM_PERCENT } from "./send.js";
import type { Call } from "./calls.js";

/** amountOutMinimum = quote − 1%. */
export const SWAP_SLIPPAGE_BPS = 100n;
/** The quote may be at most 3% worse than the reference value; further below, it is refused. */
export const SWAP_MAX_BELOW_REFERENCE_BPS = 300n;
/** Spare CELO kept on top of the next plan's registration, as a percentage of it: the fee is priced in dollars and moves with CELO. */
export const SWAP_KEEP_BUFFER_PERCENT = 10n;

export type SwapAsset = "CELO" | "USDT" | "XAUT0";
export const SWAP_ASSETS: readonly SwapAsset[] = ["CELO", "USDT", "XAUT0"];
export const SWAP_TOKEN: Readonly<Record<SwapAsset, Address>> = { CELO: CELO_TOKEN, USDT, XAUT0 };
export const SWAP_DECIMALS: Readonly<Record<SwapAsset, number>> = { CELO: 18, USDT: 6, XAUT0: 6 };

export type SwapHop = {
  tokenIn: Address;
  tokenOut: Address;
  /** Uniswap fee tier: 100 (0.01%) or 3000 (0.3%). */
  fee: number;
  pool: Address;
  /** True when tokenIn is the pool's token0 (the lower address). */
  zeroForOne: boolean;
};

export type SwapRoute = { from: SwapAsset; to: SwapAsset; hops: SwapHop[] };

function hop(a: SwapAsset, b: SwapAsset): SwapHop {
  const pair = [a, b].sort().join("/");
  const [fee, pool] =
    pair === "CELO/USDT" ? [CELO_USDT_POOL_FEE as number, CELO_USDT_POOL] : pair === "USDT/XAUT0" ? [POOL_FEE as number, USDT_XAUT0_POOL] : [0, null];
  if (!pool) throw new Error(`no pool for ${a} → ${b}`);
  const tokenIn = SWAP_TOKEN[a];
  const tokenOut = SWAP_TOKEN[b];
  return { tokenIn, tokenOut, fee, pool: getAddress(pool), zeroForOne: BigInt(tokenIn) < BigInt(tokenOut) };
}

/** The pools a conversion goes through: one for CELO ↔ USD₮ and USD₮ ↔ gold, two (via USD₮) for CELO ↔ gold. */
export function swapRoute(from: SwapAsset, to: SwapAsset): SwapRoute {
  if (from === to) throw new Error("choose two different assets");
  if (!SWAP_ASSETS.includes(from) || !SWAP_ASSETS.includes(to)) throw new Error("unknown asset");
  const hops = from === "USDT" || to === "USDT" ? [hop(from, to)] : [hop(from, "USDT"), hop("USDT", to)];
  return { from, to, hops };
}

/** Uniswap's packed path: token (20 bytes), fee (3 bytes), token, … */
export function encodeSwapPath(route: SwapRoute): Hex {
  const parts: Hex[] = [route.hops[0]!.tokenIn];
  for (const h of route.hops) parts.push(numberToHex(h.fee, { size: 3 }), h.tokenOut);
  return concat(parts);
}

/** The pool fees of a route, in plain words: "0.01%", "0.3%" or "0.01% and 0.3%". */
export function routeFeeText(route: SwapRoute): string {
  return route.hops.map((h) => `${h.fee / 10_000}%`).join(" and ");
}

function encodeApprove(amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SWAP_ROUTER_02, amount] });
}

function encodeSwap(route: SwapRoute, recipient: Address, amountIn: bigint, minOut: bigint): Hex {
  if (route.hops.length === 1) {
    const h = route.hops[0]!;
    return encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [{ tokenIn: h.tokenIn, tokenOut: h.tokenOut, fee: h.fee, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    });
  }
  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInput",
    args: [{ path: encodeSwapPath(route), recipient, amountIn, amountOutMinimum: minOut }],
  });
}

/**
 * The batch for one conversion: [approve(SwapRouter02, exactly amountIn) on the
 * asset sold, then one swap paying the wallet itself]. The exact approve also
 * overwrites any allowance left by an earlier attempt (both USD₮ and XAUt0 accept
 * a new non-zero approval over a non-zero one, checked on Celo), and the router
 * uses all of it, so none is left afterwards. No call carries value.
 */
export function buildSwapCalls(wallet: Address, from: SwapAsset, to: SwapAsset, amountIn: bigint, minOut: bigint): [Call, Call] {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  if (minOut <= 0n) throw new Error("minOut must be positive: a zero floor would accept any price");
  const route = swapRoute(from, to);
  return [
    { to: SWAP_TOKEN[from], data: encodeApprove(amountIn), value: 0n },
    { to: SWAP_ROUTER_02, data: encodeSwap(route, getAddress(wallet), amountIn, minOut), value: 0n },
  ];
}

/**
 * Decodes a conversion batch, refusing anything that is not exactly the two
 * calls `buildSwapCalls` makes for this wallet: the last check before the
 * owner signs.
 */
export function decodeSwapCalls(calls: readonly Call[], wallet: Address): { from: SwapAsset; to: SwapAsset; amountIn: bigint; minOut: bigint } {
  if (calls.length !== 2) throw new Error("a conversion is exactly two calls");
  const [approve, swap] = calls as [Call, Call];
  const from = SWAP_ASSETS.find((a) => SWAP_TOKEN[a] === getAddress(approve.to));
  if (!from || approve.value !== 0n) throw new Error("first call must approve CELO, USD₮ or XAUt0");
  if (getAddress(swap.to) !== SWAP_ROUTER_02 || swap.value !== 0n) throw new Error("second call must be a SwapRouter02 swap");
  const a = decodeFunctionData({ abi: erc20Abi, data: approve.data });
  if (a.functionName !== "approve") throw new Error("unexpected function");
  const s = decodeFunctionData({ abi: swapRouter02Abi, data: swap.data });
  let tokenOut: Address;
  let amountIn: bigint;
  let minOut: bigint;
  if (s.functionName === "exactInputSingle") {
    const p = s.args[0];
    tokenOut = p.tokenOut;
    amountIn = p.amountIn;
    minOut = p.amountOutMinimum;
  } else if (s.functionName === "exactInput") {
    const p = s.args[0];
    if (p.path.length < 2 + 2 * 20 + 2 * 3) throw new Error("path too short");
    tokenOut = getAddress(`0x${p.path.slice(-40)}`);
    amountIn = p.amountIn;
    minOut = p.amountOutMinimum;
  } else throw new Error("unexpected function");
  const to = SWAP_ASSETS.find((x) => SWAP_TOKEN[x] === getAddress(tokenOut));
  if (!to || to === from) throw new Error("the swap does not buy another of the wallet's assets");
  const [spender, approved] = a.args as readonly [Address, bigint];
  if (getAddress(spender) !== SWAP_ROUTER_02) throw new Error("approve spender is not SwapRouter02");
  if (approved !== amountIn) throw new Error("approve amount differs from the swap amount");
  // Everything else (route, fee tiers, recipient, no price limit) must be exactly what buildSwapCalls makes.
  const canonical = buildSwapCalls(wallet, from, to, amountIn, minOut);
  if (approve.data.toLowerCase() !== canonical[0].data.toLowerCase() || swap.data.toLowerCase() !== canonical[1].data.toLowerCase()) {
    throw new Error("calldata is not the canonical conversion for this wallet");
  }
  return { from, to, amountIn, minOut };
}

/* ---------- Prices ---------- */

const Q192 = 1n << 192n;
const MAX_UINT256 = (1n << 256n) - 1n;
const TICK_FACTORS: readonly bigint[] = [
  0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n, 0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n, 0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n, 0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n,
];

/** Uniswap's TickMath.getSqrtRatioAtTick, exactly, in integers. */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887_272) throw new Error("tick out of range");
  const abs = BigInt(Math.abs(tick));
  let ratio = (abs & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  TICK_FACTORS.forEach((f, i) => {
    if ((abs & (1n << BigInt(i + 1))) !== 0n) ratio = (ratio * f) >> 128n;
  });
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** What `amount` (base units of the hop's input) is worth in the output token at a pool price, before fees. Rounded down. */
export function valueAtSqrtPrice(amount: bigint, sqrtPriceX96: bigint, zeroForOne: boolean): bigint {
  if (sqrtPriceX96 <= 0n) throw new Error("sqrtPriceX96 must be positive");
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne ? (amount * p2) / Q192 : (amount * Q192) / p2;
}

/** USD₮ base units → CELO wei at the fee-currency directory's rate. Rounded down. */
export function usdtToCelo(usdtUnits: bigint, rate: Pick<CeloRate, "numerator" | "denominator">): bigint {
  return (usdtUnits * 10n ** 12n * rate.denominator) / rate.numerator;
}

export type SwapReferenceInputs = {
  /** Celo's FeeCurrencyDirectory rate for USD₮ (needed when CELO is on the route). */
  celoRate: Pick<CeloRate, "numerator" | "denominator"> | null;
  /** The gold pool's 30-minute average tick (needed when gold is on the route); null when the pool cannot report it. */
  goldTwapTick: number | null;
};

/**
 * What `amountIn` is worth in the asset bought at the reference prices, hop by
 * hop: CELO ↔ USD₮ at Celo's rate, USD₮ ↔ XAUt0 at the gold pool's 30-minute
 * average. Pool fees are not taken off: they count toward the 3%. Null when a
 * needed reference is missing.
 */
export function referenceValue(route: SwapRoute, amountIn: bigint, ref: SwapReferenceInputs): bigint | null {
  let v = amountIn;
  for (const h of route.hops) {
    if (h.pool === getAddress(CELO_USDT_POOL)) {
      if (!ref.celoRate) return null;
      v = h.tokenIn === CELO_TOKEN ? celoToUsdt(v, ref.celoRate) : usdtToCelo(v, ref.celoRate);
    } else {
      if (ref.goldTwapTick === null) return null;
      v = valueAtSqrtPrice(v, sqrtRatioAtTick(ref.goldTwapTick), h.zeroForOne);
    }
  }
  return v;
}

/** What `amountIn` is worth at each pool's current price (slot0), before fees and price impact. */
export function spotValue(route: SwapRoute, amountIn: bigint, sqrtPricesX96: readonly bigint[]): bigint {
  if (sqrtPricesX96.length !== route.hops.length) throw new Error("one price per hop");
  return route.hops.reduce((v, h, i) => valueAtSqrtPrice(v, sqrtPricesX96[i]!, h.zeroForOne), amountIn);
}

export type SwapRefusal =
  /** The amount is worth nothing at the reference price, the floor would be zero, or rounding of a tiny amount costs more than 3%. */
  | "too-small"
  /** The pool's quote is more than 3% under the reference although the pool's current price is not: this amount moves the price. */
  | "impact"
  /** The pool's price itself is more than 3% under the reference. */
  | "price";

export type SwapPriceCheck = {
  /** Base units of the asset bought the amount is worth at the reference prices (rounded down). */
  referenceOut: bigint;
  /** How far the quote is below the reference, in basis points (negative: above). */
  belowReferenceBps: number;
} & ({ ok: true; minOut: bigint } | { ok: false; refusal: SwapRefusal; reason: string });

/** Below this many base units of input or of output, one unit of rounding is over 0.1%: a refusal is then called "too small". */
export const SWAP_ROUNDING_UNITS = 1_000n;

const isWithin = (value: bigint, reference: bigint) => value * 10_000n >= reference * (10_000n - SWAP_MAX_BELOW_REFERENCE_BPS);

/**
 * The price rules, fail closed: refuse when the reference value or the quote
 * is zero, or when the quote is more than 3% below the reference (exactly 3%
 * is accepted). A refusal says whether the amount itself moves the pool's
 * price (`spotOut`, the value at the pools' current prices, is within 3%) or
 * the pool's price is off, or (input or reference output below SWAP_ROUNDING_UNITS base units, which
 * matters for gold: 1,000 base units is 0.001 XAUt0) the pools' integer rounding
 * of a tiny amount costs more than 3%. Otherwise amountOutMinimum is the quote less 1%,
 * rounded down.
 */
export function swapPriceCheck(args: { quotedOut: bigint; referenceOut: bigint; spotOut?: bigint | null; amountIn?: bigint }): SwapPriceCheck {
  const { quotedOut, referenceOut } = args;
  if (referenceOut <= 0n) return { ok: false, refusal: "too-small", reason: "the amount is too small to convert", referenceOut, belowReferenceBps: 0 };
  const belowReferenceBps = Number(((referenceOut - quotedOut) * 10_000n) / referenceOut);
  if (quotedOut <= 0n) return { ok: false, refusal: "too-small", reason: "the amount is too small to convert", referenceOut, belowReferenceBps };
  if (!isWithin(quotedOut, referenceOut)) {
    const pct = `${(belowReferenceBps / 100).toFixed(2)}%`;
    if ((args.amountIn !== undefined && args.amountIn < SWAP_ROUNDING_UNITS) || referenceOut < SWAP_ROUNDING_UNITS) {
      return { ok: false, refusal: "too-small", reason: `this amount is too small to convert at a fair price (the pools round it, so you would get ${pct} less than the reference price); try a larger amount`, referenceOut, belowReferenceBps };
    }
    if (args.spotOut != null && isWithin(args.spotOut, referenceOut)) {
      return { ok: false, refusal: "impact", reason: `this amount moves the pool's price too much (you would get ${pct} less than the reference price); try a smaller amount`, referenceOut, belowReferenceBps };
    }
    return { ok: false, refusal: "price", reason: `the pool's price is ${pct} below the reference price (the limit is ${Number(SWAP_MAX_BELOW_REFERENCE_BPS) / 100}%)`, referenceOut, belowReferenceBps };
  }
  const minOut = (quotedOut * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n;
  if (minOut <= 0n) return { ok: false, refusal: "too-small", reason: "the amount is too small to convert", referenceOut, belowReferenceBps };
  return { ok: true, minOut, referenceOut, belowReferenceBps };
}

/**
 * The lowest amountOutMinimum the rules can ever produce for a reference value:
 * 3% below it, less 1%. A signed swap with a lower floor is refused.
 */
export function lowestAllowedMinOut(referenceOut: bigint): bigint {
  return (referenceOut * (10_000n - SWAP_MAX_BELOW_REFERENCE_BPS) * (10_000n - SWAP_SLIPPAGE_BPS)) / 100_000_000n;
}

export type SwapRouteQuote = SwapPriceCheck & {
  route: SwapRoute;
  amountIn: bigint;
  /** Base units of the asset bought QuoterV2 says the swap returns now. */
  quotedOut: bigint;
  blockNumber: bigint;
};

/** Thrown by quoteSwapRoute when the gold pool cannot report its 30-minute average: its price cannot be checked. */
export class NoGoldAverageError extends Error {
  readonly name = "NoGoldAverageError";
  constructor() {
    super("the gold pool has less than 30 minutes of price history, so its price cannot be checked right now");
  }
}

/**
 * Quotes a conversion with QuoterV2 (eth_call) and reads, at the same block,
 * the references it needs (Celo's rate, the gold pool's 30-minute average)
 * and each pool's current price, then applies `swapPriceCheck`. Throws when a
 * read fails, and NoGoldAverageError when the gold average is not available:
 * no reference means no conversion.
 */
export async function quoteSwapRoute(client: PublicClient, from: SwapAsset, to: SwapAsset, amountIn: bigint, opts: { blockNumber?: bigint } = {}): Promise<SwapRouteQuote> {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  const route = swapRoute(from, to);
  const blockNumber = opts.blockNumber ?? (await pinnedBlock(client));
  const usesCelo = route.hops.some((h) => h.pool === getAddress(CELO_USDT_POOL));
  const usesGold = route.hops.some((h) => h.pool === getAddress(USDT_XAUT0_POOL));
  const quoted =
    route.hops.length === 1
      ? client
          .simulateContract({
            address: QUOTER_V2,
            abi: quoterV2Abi,
            functionName: "quoteExactInputSingle",
            args: [{ tokenIn: route.hops[0]!.tokenIn, tokenOut: route.hops[0]!.tokenOut, amountIn, fee: route.hops[0]!.fee, sqrtPriceLimitX96: 0n }],
            blockNumber,
          })
          .then((r) => r.result[0])
      : client
          .simulateContract({ address: QUOTER_V2, abi: quoterV2Abi, functionName: "quoteExactInput", args: [encodeSwapPath(route), amountIn], blockNumber })
          .then((r) => r.result[0]);
  const [quotedOut, rate, twap, spots] = await Promise.all([
    quoted,
    usesCelo ? readCeloUsdtRate(client, blockNumber) : Promise.resolve(null),
    usesGold ? readTwapTick(client, blockNumber) : Promise.resolve(null),
    Promise.all(route.hops.map((h) => client.readContract({ address: h.pool, abi: uniswapV3PoolAbi, functionName: "slot0", blockNumber }).then((s) => s[0]))),
  ]);
  if (usesGold && twap === null) throw new NoGoldAverageError();
  const referenceOut = referenceValue(route, amountIn, { celoRate: rate, goldTwapTick: twap });
  if (referenceOut === null) throw new Error("a reference price is missing");
  const check = swapPriceCheck({ quotedOut, referenceOut, spotOut: spotValue(route, amountIn, spots), amountIn });
  return { ...check, route, amountIn, quotedOut, blockNumber };
}

/* ---------- What the wallet keeps, the fee token, Max ---------- */

export type SwapKeepInput = {
  /** The wallet's own key (the passkey) is already registered in the KeyStore. */
  walletRegistered: boolean;
  /** KeyStore registration of one key now, with the SDK's 10% headroom, in CELO wei. */
  perKeyFee: bigint;
  /** CELO this conversion carries for registering the wallet's own key (its first passkey transaction), from the relay's quote. */
  swapRegistration: bigint;
  /** The relay's maximum fee for this conversion when it is paid in CELO; 0 when it is paid in USD₮. */
  swapFeeCelo: bigint;
};

export type SwapKeep = {
  /** The next plan's KeyStore registration: the agent's key, plus the wallet's own key if still unregistered after this conversion. */
  nextPlan: bigint;
  /** What this conversion itself costs in CELO: its registration value and its CELO fee with headroom. */
  thisTransaction: bigint;
  /** Spare CELO on top of the next plan's registration. */
  buffer: bigint;
  /** All of the above: Max converts the balance less this. */
  total: bigint;
};

/**
 * The CELO a conversion that sells CELO leaves in the wallet so a plan can
 * still start. After a conversion that registers the wallet's own key (or when
 * it is registered already), the next plan registers one key; otherwise two.
 * The next plan's relay fee is paid in USD₮, so it needs no CELO.
 */
export function celoToKeep(i: SwapKeepInput): SwapKeep {
  const registeredAfter = i.walletRegistered || i.swapRegistration > 0n;
  const nextPlan = i.perKeyFee * (registeredAfter ? 1n : 2n);
  const thisTransaction = i.swapRegistration + (i.swapFeeCelo * SEND_FEE_HEADROOM_PERCENT) / 100n;
  const buffer = (nextPlan * SWAP_KEEP_BUFFER_PERCENT) / 100n;
  return { nextPlan, thisTransaction, buffer, total: nextPlan + thisTransaction + buffer };
}

/** The most CELO Max converts: the balance less everything kept. 0 when nothing fits. */
export function maxSwappable(celoBalance: bigint, keep: SwapKeep): bigint {
  return celoBalance > keep.total ? celoBalance - keep.total : 0n;
}

/** True when `usdtBalance` holds the relay's USD₮ fee with the same headroom Send out uses. */
export function swapFeeInUsdt(usdtBalance: bigint, usdtFee: bigint): boolean {
  return usdtFee > 0n && usdtBalance >= (usdtFee * SEND_FEE_HEADROOM_PERCENT) / 100n;
}

export type SwapBalances = { celo: bigint; usdt: bigint; xaut0: bigint };

/** The relay's quotes for one conversion: its maximum fee in each token it was asked for (null: not quoted), and the registration value. */
export type SwapFees = { usdt: bigint | null; celo: bigint | null; registration: bigint };

export const swapBalanceOf = (b: SwapBalances, a: SwapAsset) => (a === "CELO" ? b.celo : a === "USDT" ? b.usdt : b.xaut0);

/**
 * The fee token for converting `amountIn` of `from`: USD₮ when the USD₮ left
 * after this conversion's own spend still holds the fee with headroom,
 * otherwise CELO. Null when neither was quoted.
 */
export function swapFeeToken(from: SwapAsset, amountIn: bigint, balances: SwapBalances, fees: SwapFees): "USDT" | "CELO" | null {
  const usdtLeft = balances.usdt - (from === "USDT" ? amountIn : 0n);
  if (fees.usdt !== null && swapFeeInUsdt(usdtLeft, fees.usdt)) return "USDT";
  return fees.celo !== null ? "CELO" : null;
}

/** CELO this conversion needs besides any CELO it sells: the registration, and the fee with headroom when paid in CELO. */
export function celoForTransaction(feeToken: "USDT" | "CELO", fees: SwapFees): bigint {
  return fees.registration + (feeToken === "CELO" ? ((fees.celo ?? 0n) * SEND_FEE_HEADROOM_PERCENT) / 100n : 0n);
}

/**
 * The most Max converts, and (when CELO is sold) the CELO kept for the next plan.
 * - CELO sold: the balance less `celoToKeep`.
 * - USD₮ sold: the balance less the USD₮ fee with headroom, so the fee can still be paid in USD₮ (the whole
 *   balance when the fee was not quoted in USD₮).
 * - Gold sold: the whole balance (the fee is never paid in gold).
 */
export function swapMax(from: SwapAsset, balances: SwapBalances, fees: SwapFees, plan: { walletRegistered: boolean; perKeyFee: bigint }): { max: bigint; keep: SwapKeep | null } {
  if (from === "CELO") {
    const feeToken = swapFeeToken("CELO", 0n, balances, fees) ?? "CELO";
    const keep = celoToKeep({ walletRegistered: plan.walletRegistered, perKeyFee: plan.perKeyFee, swapRegistration: fees.registration, swapFeeCelo: feeToken === "CELO" ? (fees.celo ?? 0n) : 0n });
    return { max: maxSwappable(balances.celo, keep), keep };
  }
  if (from === "USDT" && fees.usdt !== null) {
    const reserve = (fees.usdt * SEND_FEE_HEADROOM_PERCENT) / 100n;
    return { max: balances.usdt > reserve ? balances.usdt - reserve : 0n, keep: null };
  }
  return { max: swapBalanceOf(balances, from), keep: null };
}

export type SwapAmountCheck =
  | {
      ok: true;
      feeToken: "USDT" | "CELO";
      /** CELO sold above Max: the next plan's registration would not be covered. */
      leavesTooLittle: boolean;
    }
  | { ok: false; problem: string };

/**
 * Whether `amount` of `from` can be converted. Refused: zero, more than the
 * balance, or an amount that leaves too little to pay this transaction (its
 * fee in USD₮ or CELO, and the registration in CELO on a wallet's first passkey
 * transaction). Selling all USD₮ moves the fee to CELO; when CELO cannot pay it
 * either, it is refused, so no intent is built whose fee and amount exceed the
 * balance. CELO above Max is allowed (it is the owner's money) with a warning.
 */
export function checkSwapAmount(from: SwapAsset, amount: bigint, balances: SwapBalances, fees: SwapFees, plan: { walletRegistered: boolean; perKeyFee: bigint }): SwapAmountCheck {
  const sym = from === "CELO" ? "CELO" : from === "USDT" ? "USD₮" : "gold";
  if (amount <= 0n) return { ok: false, problem: "Enter an amount above zero." };
  if (amount > swapBalanceOf(balances, from)) return { ok: false, problem: `That is more ${sym} than the wallet holds.` };
  const feeToken = swapFeeToken(from, amount, balances, fees);
  if (!feeToken) return { ok: false, problem: "The network fee could not be quoted." };
  const celoLeft = balances.celo - (from === "CELO" ? amount : 0n);
  const celoNeeded = celoForTransaction(feeToken, fees);
  if (celoLeft < celoNeeded) {
    if (from === "CELO") return { ok: false, problem: "That leaves too little CELO for this conversion's network fee." };
    if (fees.registration > 0n && feeToken === "USDT") return { ok: false, problem: "The wallet needs a little CELO for Altana's one-time registration of the wallet." };
    return { ok: false, problem: from === "USDT" ? "That leaves too little USD₮ or CELO for the network fee." : "The wallet does not hold enough USD₮ or CELO for the network fee." };
  }
  const leavesTooLittle = from === "CELO" && amount > swapMax("CELO", balances, fees, plan).max;
  return { ok: true, feeToken, leavesTooLittle };
}

/* ---------- After the transaction ---------- */

export type SwapReceiptCheck = { ok: true; amountIn: bigint; amountOut: bigint } | { ok: false; reason: string };

/**
 * What a confirmed transaction's logs show of the conversion: exactly
 * `amountIn` of the asset sold from the wallet to the route's first pool, and
 * at least `minOut` of the asset bought from the route's last pool to the
 * wallet. Fee transfers to the relay's recipient are not counted. The relay's
 * transaction can succeed while the intent inside it fails, so a missing
 * transfer is not a conversion.
 */
export function checkSwapLogs(logs: readonly Log[], req: { wallet: Address; from: SwapAsset; to: SwapAsset; amountIn: bigint; minOut: bigint }): SwapReceiptCheck {
  const route = swapRoute(req.from, req.to);
  const wallet = getAddress(req.wallet);
  const firstPool = route.hops[0]!.pool;
  const lastPool = route.hops[route.hops.length - 1]!.pool;
  const transfers = parseEventLogs({ abi: [erc20TransferEvent], eventName: "Transfer", logs: logs as Log[] });
  let paid = 0n;
  let got = 0n;
  for (const t of transfers) {
    const token = getAddress(t.address);
    const from = getAddress(t.args.from);
    const to = getAddress(t.args.to);
    if (token === SWAP_TOKEN[req.from] && from === wallet && to === firstPool) paid += t.args.value;
    if (token === SWAP_TOKEN[req.to] && from === lastPool && to === wallet) got += t.args.value;
  }
  if (paid === 0n && got === 0n) return { ok: false, reason: "the transaction holds no conversion" };
  if (paid !== req.amountIn) return { ok: false, reason: `the pool received ${paid} base units, not ${req.amountIn}` };
  if (got < req.minOut) return { ok: false, reason: `the wallet received ${got} base units, less than the minimum ${req.minOut}` };
  return { ok: true, amountIn: paid, amountOut: got };
}
