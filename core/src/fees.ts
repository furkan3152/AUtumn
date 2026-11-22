/**
 * Fees in plain numbers: the relay fee a session purchase may pay, the CELO
 * price from Celo's own fee-currency directory, and an all-in cost estimate.
 */
import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import { pinnedBlock } from "./client.js";
import { FEE_CURRENCY_DIRECTORY, POOL_FEE, USDT, USDT_FEE_ADAPTER } from "./constants.js";

export type RelayFeeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether a relay fee quote is acceptable for one purchase: it must be in
 * USD₮ (the session has no other spend cap) and no more than the plan's
 * per-buy fee allowance. A fee above the allowance is refused, not paid:
 * the purchase is retried later in the period.
 */
export function relayFeeVerdict(quote: { fee: bigint; feeToken: Address }, allowancePerBuy: bigint): RelayFeeVerdict {
  if (getAddress(quote.feeToken) !== getAddress(USDT)) {
    return { ok: false, reason: "the relay asked for its fee in a token other than USD₮" };
  }
  if (quote.fee > allowancePerBuy) {
    return {
      ok: false,
      reason: `the relay asked ${quote.fee} USD₮ base units in fees, more than the plan's ${allowancePerBuy} per purchase`,
    };
  }
  return { ok: true };
}

/** Uniswap pool fee in basis points (0.3%). */
export const POOL_FEE_BPS = BigInt(POOL_FEE / 100);

/**
 * Gas the relay's fee for a session purchase corresponds to, used to estimate
 * that fee before any plan exists. The fees the relay prepared for purchases
 * on mainnet (0.016328 and 0.019648 USD₮ at about 200 gwei) work out to 1.5
 * to 1.8 million gas at the CELO rate; the purchase itself uses about 340,000.
 * An estimate only: the relay's own quote is what the agent checks before
 * each buy.
 */
export const PURCHASE_GAS_ESTIMATE = 1_800_000n;

const directoryAbi = parseAbi(["function getExchangeRate(address token) view returns (uint256 numerator, uint256 denominator)"]);

/** USD₮ per CELO as Celo's FeeCurrencyDirectory reports it for the USD₮ adapter: price = numerator / denominator. */
export type CeloRate = { numerator: bigint; denominator: bigint; blockNumber: bigint };

export async function readCeloUsdtRate(client: PublicClient, blockNumber?: bigint): Promise<CeloRate> {
  const bn = blockNumber ?? (await pinnedBlock(client));
  const [numerator, denominator] = await client.readContract({
    address: FEE_CURRENCY_DIRECTORY,
    abi: directoryAbi,
    functionName: "getExchangeRate",
    args: [USDT_FEE_ADAPTER],
    blockNumber: bn,
  });
  if (numerator === 0n || denominator === 0n) throw new Error("the fee-currency directory has no USD₮ rate");
  return { numerator, denominator, blockNumber: bn };
}

/** CELO wei → USD₮ base units (6 decimals), rounded down. */
export function celoToUsdt(wei: bigint, rate: Pick<CeloRate, "numerator" | "denominator">): bigint {
  return (wei * rate.numerator) / rate.denominator / 10n ** 12n;
}

export type BuyCostEstimate = {
  /** The 0.3% the pool keeps, in USD₮ base units. */
  poolFee: bigint;
  /** Estimated relay fee in USD₮ base units. */
  relayFee: bigint;
  /** poolFee + relayFee. */
  total: bigint;
  /** total as basis points of the purchase amount. */
  totalBps: number;
};

/** All-in cost of one purchase of `amount` USD₮ base units, given a relay fee estimate. */
export function estimateBuyCost(amount: bigint, relayFee: bigint): BuyCostEstimate {
  if (amount <= 0n) throw new Error("amount must be positive");
  const poolFee = (amount * POOL_FEE_BPS) / 10_000n;
  const total = poolFee + relayFee;
  return { poolFee, relayFee, total, totalBps: Number((total * 10_000n) / amount) };
}

/** A relay fee estimate in USD₮ base units from the gas price (wei) and the CELO rate. */
export function estimateRelayFeeUsdt(gasPriceWei: bigint, rate: Pick<CeloRate, "numerator" | "denominator">, gas = PURCHASE_GAS_ESTIMATE): bigint {
  return celoToUsdt(gasPriceWei * gas, rate);
}
