import { toDataSuffix } from "@celo/attribution-tags";
import { concat, decodeFunctionData, encodeFunctionData, getAddress, size, slice, type Address, type Hex } from "viem";
import { erc20Abi, goldBuyerAbi } from "./abis.js";
import { ATTRIBUTION_CODE, USDT } from "./constants.js";

/** A call as the Altana SDK takes it. */
export type Call = { to: Address; data: Hex; value: bigint };

/** ERC-8021 suffix for this project's code (35 bytes). */
export const ATTRIBUTION_SUFFIX: Hex = toDataSuffix(ATTRIBUTION_CODE) as Hex;

export function withAttribution(data: Hex): Hex {
  return concat([data, ATTRIBUTION_SUFFIX]);
}

/**
 * The batch for one purchase: [USD₮.approve(GoldBuyer, amountIn), GoldBuyer.buy(amountIn, minOut)].
 * The account resets approvals after every session batch, so the approve must
 * be in the same batch as the buy. The attribution suffix is appended to each
 * call's data; ERC-20s and GoldBuyer ignore trailing calldata, and the
 * session guards read only the selector and the amount at offset 0x24.
 */
export function buildBuyCalls(amountIn: bigint, minOut: bigint, goldBuyer: Address): [Call, Call] {
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  if (minOut <= 0n) throw new Error("minOut must be positive: a zero floor would accept any price");
  const buyer = getAddress(goldBuyer);
  return [
    {
      to: USDT,
      data: withAttribution(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [buyer, amountIn] })),
      value: 0n,
    },
    {
      to: buyer,
      data: withAttribution(encodeFunctionData({ abi: goldBuyerAbi, functionName: "buy", args: [amountIn, minOut] })),
      value: 0n,
    },
  ];
}

/** Splits calldata into the ABI part and the attribution suffix, if the suffix is present. */
export function stripAttribution(data: Hex): { body: Hex; tagged: boolean } {
  const n = size(ATTRIBUTION_SUFFIX);
  if (size(data) > n && slice(data, size(data) - n).toLowerCase() === ATTRIBUTION_SUFFIX.toLowerCase()) {
    return { body: slice(data, 0, size(data) - n), tagged: true };
  }
  return { body: data, tagged: false };
}

/**
 * Decodes a purchase batch back into its parameters, refusing anything that is
 * not exactly the two expected calls. Used by tests and as a last check before
 * the runner submits.
 */
export function decodeBuyCalls(calls: readonly Call[], goldBuyer: Address): {
  amountIn: bigint;
  minOut: bigint;
  tagged: boolean;
} {
  if (calls.length !== 2) throw new Error("a purchase is exactly two calls");
  const [approve, buy] = calls as [Call, Call];
  if (getAddress(approve.to) !== USDT || approve.value !== 0n) throw new Error("first call must be USD₮.approve");
  if (getAddress(buy.to) !== getAddress(goldBuyer) || buy.value !== 0n) throw new Error("second call must be GoldBuyer.buy");
  const a = stripAttribution(approve.data);
  const b = stripAttribution(buy.data);
  const ad = decodeFunctionData({ abi: erc20Abi, data: a.body });
  const bd = decodeFunctionData({ abi: goldBuyerAbi, data: b.body });
  if (ad.functionName !== "approve" || bd.functionName !== "buy") throw new Error("unexpected function");
  const [spender, approved] = ad.args as readonly [Address, bigint];
  const [amountIn, minOut] = bd.args as readonly [bigint, bigint];
  if (getAddress(spender) !== getAddress(goldBuyer)) throw new Error("approve spender is not GoldBuyer");
  if (approved !== amountIn) throw new Error("approve amount differs from buy amount");
  return { amountIn, minOut, tagged: a.tagged && b.tagged };
}
