/**
 * Sending funds out of the wallet with the owner's passkey (admin execute).
 * Pure helpers: destination checks, amount parsing, the call to send, and
 * the largest amount that still leaves room for the fee.
 */
import { encodeFunctionData, getAddress, isAddress, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { USDT, USDT_DECIMALS, XAUT0, XAUT0_DECIMALS } from "./constants.js";
import type { Call } from "./calls.js";

export type SendAsset = "USDT" | "XAUT0" | "CELO";

export const SEND_ASSETS: readonly SendAsset[] = ["USDT", "XAUT0", "CELO"];

/** Decimals and token address (null for native CELO) of each asset. */
export const SEND_ASSET_INFO: Record<SendAsset, { symbol: string; decimals: number; token: Address | null }> = {
  USDT: { symbol: "USD₮", decimals: USDT_DECIMALS, token: USDT },
  XAUT0: { symbol: "XAUt0", decimals: XAUT0_DECIMALS, token: XAUT0 },
  CELO: { symbol: "CELO", decimals: 18, token: null },
};

const transferAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

export type DestinationCheck = { ok: true; address: Address } | { ok: false; problem: string };

/**
 * Checks a destination typed by the owner. Accepts all-lowercase or
 * all-uppercase hex, or a correctly checksummed mixed-case address; a
 * mixed-case address with a wrong checksum is refused (it is usually a typo).
 * Refuses the zero address, the wallet itself, and contracts that would
 * swallow the funds (the token contracts, GoldBuyer).
 */
export function checkDestination(input: string, opts: { wallet: Address; contracts?: readonly Address[] }): DestinationCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, problem: "Enter the address to send to." };
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return { ok: false, problem: "That is not a Celo address. It must start with 0x followed by 40 letters and digits." };
  }
  const body = raw.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && !isAddress(raw, { strict: true })) {
    return { ok: false, problem: "The address has a typo: its capital letters do not match its checksum. Copy it again." };
  }
  const address = getAddress(raw.toLowerCase());
  if (address === zeroAddress) return { ok: false, problem: "That is the zero address. Funds sent there are lost." };
  if (address === getAddress(opts.wallet)) return { ok: false, problem: "That is this wallet's own address." };
  const blocked = [USDT, XAUT0, ...(opts.contracts ?? [])].map((a) => getAddress(a));
  if (blocked.includes(address)) return { ok: false, problem: "That is a token or Autumn contract, not a wallet. Funds sent there are lost." };
  return { ok: true, address };
}

export type AmountParse = { ok: true; value: bigint } | { ok: false; problem: string };

/**
 * Parses a decimal amount typed by the owner into base units. Accepts a dot or
 * a single decimal comma ("1,5" is 1.5): a comma followed by 1 to 6 digits and
 * no dot is a decimal separator. Anything ambiguous (both a dot and a comma,
 * more than one comma, a comma with 7 or more digits after it) is refused, so
 * "1,500" is never read as 1500 or as 1.5 by guesswork.
 */
export function parseAmountText(input: string, decimals: number): AmountParse {
  let raw = input.trim().replace(/\s+/g, "");
  if (raw === "") return { ok: false, problem: "Enter an amount." };
  const commas = (raw.match(/,/g) ?? []).length;
  if (commas > 0) {
    if (commas > 1 || raw.includes(".") || !/^\d*,\d{1,6}$/.test(raw)) {
      return { ok: false, problem: "Use one decimal separator, for example 1.5 or 1,5, without thousands separators." };
    }
    raw = raw.replace(",", ".");
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return { ok: false, problem: "Enter a positive number, for example 1.5." };
  const frac = m[2] ?? "";
  if (frac.length > decimals) return { ok: false, problem: `Enter at most ${decimals} decimals.` };
  const v = BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return v > 0n ? { ok: true, value: v } : { ok: false, problem: "Enter an amount above zero." };
}

/** parseAmountText's value, or null for anything that is not a positive, unambiguous amount. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const r = parseAmountText(input, decimals);
  return r.ok ? r.value : null;
}

/** The single call that sends `amount` of `asset` to `to`. */
export function buildSendCall(asset: SendAsset, to: Address, amount: bigint): Call {
  if (amount <= 0n) throw new Error("amount must be positive");
  const dest = getAddress(to);
  const token = SEND_ASSET_INFO[asset].token;
  if (token === null) return { to: dest, data: "0x" as Hex, value: amount };
  return { to: token, data: encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [dest, amount] }), value: 0n };
}

export type SendCost = {
  /** The relay's maximum fee, in `feeToken` base units. */
  fee: bigint;
  /** Fee token address; the zero address is native CELO. */
  feeToken: Address;
  /** Native CELO the intent carries besides the amount (the KeyStore registration on a wallet's first admin action). */
  extraNative: bigint;
};

/** Headroom on the quoted fee when computing "max": the fee is re-quoted at send time and can move. */
export const SEND_FEE_HEADROOM_PERCENT = 150n;

/**
 * The most of `asset` that can be sent from `balance` while leaving the fee
 * (with headroom) and any native value the intent carries. 0 when nothing fits.
 */
export function maxSendable(asset: SendAsset, balance: bigint, cost: SendCost): bigint {
  const token = SEND_ASSET_INFO[asset].token ?? zeroAddress;
  let reserve = 0n;
  if (getAddress(cost.feeToken) === getAddress(token)) reserve += (cost.fee * SEND_FEE_HEADROOM_PERCENT) / 100n;
  if (asset === "CELO") reserve += cost.extraNative;
  return balance > reserve ? balance - reserve : 0n;
}
