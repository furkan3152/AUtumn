/**
 * Converting the wallet's CELO into USD₮ with the owner's passkey: the two
 * calls (an exact CELO approve and SwapRouter02.exactInputSingle on the
 * CELO/USD₮ 0.01% pool), the price checks, and how much CELO the wallet keeps
 * for its next plan. Pure helpers plus one chain read (`quoteCeloToUsdt`).
 */
import { decodeFunctionData, encodeFunctionData, getAddress, parseEventLogs, type Address, type Hex, type Log, type PublicClient } from "viem";
import { erc20Abi, erc20TransferEvent, quoterV2Abi, swapRouter02Abi } from "./abis.js";
import { pinnedBlock } from "./client.js";
import { CELO_TOKEN, CELO_USDT_POOL, CELO_USDT_POOL_FEE, QUOTER_V2, SWAP_ROUTER_02, USDT } from "./constants.js";
import { celoToUsdt, readCeloUsdtRate, type CeloRate } from "./fees.js";
import { SEND_FEE_HEADROOM_PERCENT } from "./send.js";
import type { Call } from "./calls.js";

/** amountOutMinimum = quote − 1%. */
export const SWAP_SLIPPAGE_BPS = 100n;
/** The quote may be at most 3% below the reference rate (Celo's fee-currency directory); further below, it is refused. */
export const SWAP_MAX_BELOW_REFERENCE_BPS = 300n;
/** The pool's fee in basis points (fee tier 100 = 0.01%). */
export const CELO_USDT_POOL_FEE_BPS = 1;
/** Spare CELO kept on top of the next plan's registration, as a percentage of it: the fee is priced in dollars and moves with CELO. */
export const SWAP_KEEP_BUFFER_PERCENT = 10n;

/**
 * The batch for one conversion: [CELO.approve(SwapRouter02, amountIn),
 * SwapRouter02.exactInputSingle(CELO → USD₮, fee 100, recipient = wallet,
 * amountIn, minOut, no price limit)]. The approve is exactly the amount the
 * router pulls, so no allowance is left afterwards. No call carries value.
 */
export function buildSwapCalls(wallet: Address, amountIn: bigint, minOut: bigint): [Call, Call] {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  if (minOut <= 0n) throw new Error("minOut must be positive: a zero floor would accept any price");
  const recipient = getAddress(wallet);
  return [
    { to: CELO_TOKEN, data: encodeApprove(amountIn), value: 0n },
    { to: SWAP_ROUTER_02, data: encodeSwap(recipient, amountIn, minOut), value: 0n },
  ];
}

function encodeApprove(amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SWAP_ROUTER_02, amount] });
}

function encodeSwap(recipient: Address, amountIn: bigint, minOut: bigint): Hex {
  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [{ tokenIn: CELO_TOKEN, tokenOut: USDT, fee: CELO_USDT_POOL_FEE, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
  });
}

/**
 * Decodes a conversion batch, refusing anything that is not exactly the two
 * calls `buildSwapCalls` makes for this wallet: the last check before the
 * owner signs.
 */
export function decodeSwapCalls(calls: readonly Call[], wallet: Address): { amountIn: bigint; minOut: bigint } {
  if (calls.length !== 2) throw new Error("a conversion is exactly two calls");
  const [approve, swap] = calls as [Call, Call];
  if (getAddress(approve.to) !== CELO_TOKEN || approve.value !== 0n) throw new Error("first call must be CELO.approve");
  if (getAddress(swap.to) !== SWAP_ROUTER_02 || swap.value !== 0n) throw new Error("second call must be SwapRouter02.exactInputSingle");
  const a = decodeFunctionData({ abi: erc20Abi, data: approve.data });
  const s = decodeFunctionData({ abi: swapRouter02Abi, data: swap.data });
  if (a.functionName !== "approve" || s.functionName !== "exactInputSingle") throw new Error("unexpected function");
  const [spender, approved] = a.args as readonly [Address, bigint];
  const p = s.args[0];
  if (getAddress(spender) !== SWAP_ROUTER_02) throw new Error("approve spender is not SwapRouter02");
  if (getAddress(p.tokenIn) !== CELO_TOKEN || getAddress(p.tokenOut) !== USDT) throw new Error("the swap is not CELO → USD₮");
  if (p.fee !== CELO_USDT_POOL_FEE) throw new Error("the swap is not on the 0.01% pool");
  if (getAddress(p.recipient) !== getAddress(wallet)) throw new Error("the swap does not pay the wallet");
  if (p.sqrtPriceLimitX96 !== 0n) throw new Error("unexpected price limit");
  if (approved !== p.amountIn) throw new Error("approve amount differs from the swap amount");
  if (p.amountIn <= 0n || p.amountOutMinimum <= 0n) throw new Error("zero amount or zero floor");
  // Encoding is canonical: anything appended or altered would not round-trip.
  if (approve.data.toLowerCase() !== encodeApprove(approved).toLowerCase() || swap.data.toLowerCase() !== encodeSwap(getAddress(wallet), p.amountIn, p.amountOutMinimum).toLowerCase()) {
    throw new Error("calldata is not the canonical encoding");
  }
  return { amountIn: p.amountIn, minOut: p.amountOutMinimum };
}

export type SwapPriceCheck = {
  /** USD₮ base units the amount is worth at the reference rate (rounded down). */
  referenceOut: bigint;
  /** How far the quote is below the reference, in basis points (negative: above). */
  belowReferenceBps: number;
} & ({ ok: true; minOut: bigint } | { ok: false; reason: string });

/**
 * The price rules, fail closed: refuse when the reference value or the quote
 * is zero, or when the quote is more than 3% below the reference (a thin or
 * moved pool). Otherwise amountOutMinimum is the quote less 1%, rounded down.
 * Exactly 3% below is still accepted.
 */
export function swapPriceCheck(amountIn: bigint, quotedOut: bigint, rate: Pick<CeloRate, "numerator" | "denominator">): SwapPriceCheck {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  const referenceOut = celoToUsdt(amountIn, rate);
  if (referenceOut <= 0n) return { ok: false, reason: "the amount is too small to convert", referenceOut, belowReferenceBps: 0 };
  const belowReferenceBps = Number(((referenceOut - quotedOut) * 10_000n) / referenceOut);
  if (quotedOut <= 0n) return { ok: false, reason: "the pool quotes no USD₮ for this amount", referenceOut, belowReferenceBps };
  if (quotedOut * 10_000n < referenceOut * (10_000n - SWAP_MAX_BELOW_REFERENCE_BPS)) {
    return {
      ok: false,
      reason: `the pool's price is ${(belowReferenceBps / 100).toFixed(2)}% below Celo's reference rate (the limit is ${Number(SWAP_MAX_BELOW_REFERENCE_BPS) / 100}%)`,
      referenceOut,
      belowReferenceBps,
    };
  }
  const minOut = (quotedOut * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n;
  if (minOut <= 0n) return { ok: false, reason: "the amount is too small to convert", referenceOut, belowReferenceBps };
  return { ok: true, minOut, referenceOut, belowReferenceBps };
}

/**
 * The lowest amountOutMinimum the rules can ever produce for a reference value:
 * 3% below it, less 1%. A signed swap with a lower floor is refused.
 */
export function lowestAllowedMinOut(referenceOut: bigint): bigint {
  return (referenceOut * (10_000n - SWAP_MAX_BELOW_REFERENCE_BPS) * (10_000n - SWAP_SLIPPAGE_BPS)) / 100_000_000n;
}

export type CeloSwapQuote = SwapPriceCheck & {
  amountIn: bigint;
  /** USD₮ base units QuoterV2 says the swap returns now. */
  quotedOut: bigint;
  rate: CeloRate;
  blockNumber: bigint;
};

/**
 * Quotes CELO → USD₮ on the 0.01% pool with QuoterV2 (eth_call) and reads the
 * reference rate at the same block, then applies `swapPriceCheck`. Throws when
 * either read fails: no reference or no quote means no conversion.
 */
export async function quoteCeloToUsdt(client: PublicClient, amountIn: bigint, opts: { blockNumber?: bigint } = {}): Promise<CeloSwapQuote> {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  const blockNumber = opts.blockNumber ?? (await pinnedBlock(client));
  const [{ result }, rate] = await Promise.all([
    client.simulateContract({
      address: QUOTER_V2,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: CELO_TOKEN, tokenOut: USDT, amountIn, fee: CELO_USDT_POOL_FEE, sqrtPriceLimitX96: 0n }],
      blockNumber,
    }),
    readCeloUsdtRate(client, blockNumber),
  ]);
  const quotedOut = result[0];
  return { ...swapPriceCheck(amountIn, quotedOut, rate), amountIn, quotedOut, rate, blockNumber };
}

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
 * The CELO a conversion leaves in the wallet so a plan can still start.
 * After a conversion that registers the wallet's own key (or when it is
 * registered already), the next plan registers one key; otherwise two.
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

export type SwapAmountCheck =
  | { ok: true; /** True when the amount is above Max: the next plan's registration would not be covered. */ leavesTooLittle: boolean }
  | { ok: false; problem: string };

/**
 * Whether `amount` can be converted from `celoBalance`. Refused: zero, more
 * than the balance, or more than the balance less this transaction's own CELO
 * cost. Above Max it is allowed (it is the owner's money) with a warning.
 */
export function checkSwapAmount(amount: bigint, celoBalance: bigint, keep: SwapKeep): SwapAmountCheck {
  if (amount <= 0n) return { ok: false, problem: "Enter an amount above zero." };
  if (amount > celoBalance) return { ok: false, problem: "That is more CELO than the wallet holds." };
  if (amount + keep.thisTransaction > celoBalance) return { ok: false, problem: "That leaves too little CELO for this conversion's network fee." };
  return { ok: true, leavesTooLittle: amount > maxSwappable(celoBalance, keep) };
}

/**
 * Fee token for a conversion: USD₮ when the wallet holds the relay's USD₮ fee
 * with the same headroom Send out uses, otherwise CELO.
 */
export function swapFeeInUsdt(usdtBalance: bigint, usdtFee: bigint): boolean {
  return usdtFee > 0n && usdtBalance >= (usdtFee * SEND_FEE_HEADROOM_PERCENT) / 100n;
}

export type SwapReceiptCheck =
  | { ok: true; celoIn: bigint; usdtOut: bigint }
  | { ok: false; reason: string };

/**
 * What a confirmed transaction's logs show of the conversion: exactly
 * `amountIn` CELO from the wallet to the pool, and at least `minOut` USD₮ from
 * the pool to the wallet. The relay's transaction can succeed while the
 * intent inside it fails, so a missing transfer is not a conversion.
 */
export function checkSwapLogs(logs: readonly Log[], req: { wallet: Address; amountIn: bigint; minOut: bigint }): SwapReceiptCheck {
  const wallet = getAddress(req.wallet);
  const transfers = parseEventLogs({ abi: [erc20TransferEvent], eventName: "Transfer", logs: logs as Log[] });
  let celoIn = 0n;
  let usdtOut = 0n;
  for (const t of transfers) {
    const token = getAddress(t.address);
    const from = getAddress(t.args.from);
    const to = getAddress(t.args.to);
    if (token === CELO_TOKEN && from === wallet && to === getAddress(CELO_USDT_POOL)) celoIn += t.args.value;
    if (token === USDT && from === getAddress(CELO_USDT_POOL) && to === wallet) usdtOut += t.args.value;
  }
  if (celoIn === 0n && usdtOut === 0n) return { ok: false, reason: "the transaction holds no conversion" };
  if (celoIn !== req.amountIn) return { ok: false, reason: `the pool received ${celoIn} CELO wei, not ${req.amountIn}` };
  if (usdtOut < req.minOut) return { ok: false, reason: `the wallet received ${usdtOut} USD₮ base units, less than the minimum ${req.minOut}` };
  return { ok: true, celoIn, usdtOut };
}
