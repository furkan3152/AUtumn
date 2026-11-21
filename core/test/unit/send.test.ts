import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { USDT, XAUT0 } from "../../src/constants.js";
import { buildSendCall, checkDestination, maxSendable, parseAmount } from "../../src/send.js";

const WALLET = getAddress("0x2222222222222222222222222222222222222222") as Address;
const GB = getAddress("0x1111111111111111111111111111111111111111") as Address;
const DEST = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // EIP-55 example

describe("checkDestination", () => {
  it("accepts a checksummed, lowercase or uppercase address and returns it checksummed", () => {
    expect(checkDestination(DEST, { wallet: WALLET })).toEqual({ ok: true, address: DEST });
    expect(checkDestination(DEST.toLowerCase(), { wallet: WALLET })).toEqual({ ok: true, address: DEST });
    expect(checkDestination(` 0x${DEST.slice(2).toUpperCase()} `, { wallet: WALLET })).toEqual({ ok: true, address: DEST });
  });

  it("refuses a mixed-case address with a wrong checksum", () => {
    const typo = DEST.replace("aAeb", "aaEb");
    expect(checkDestination(typo, { wallet: WALLET })).toMatchObject({ ok: false, problem: expect.stringMatching(/checksum/) });
  });

  it("refuses malformed input, the zero address, the wallet itself and known contracts", () => {
    expect(checkDestination("0x1234", { wallet: WALLET }).ok).toBe(false);
    expect(checkDestination("alice.celo", { wallet: WALLET }).ok).toBe(false);
    expect(checkDestination(zeroAddress, { wallet: WALLET }).ok).toBe(false);
    expect(checkDestination(WALLET.toLowerCase(), { wallet: WALLET }).ok).toBe(false);
    expect(checkDestination(USDT, { wallet: WALLET }).ok).toBe(false);
    expect(checkDestination(XAUT0.toLowerCase(), { wallet: WALLET }).ok).toBe(false);
    expect(checkDestination(GB, { wallet: WALLET, contracts: [GB] }).ok).toBe(false);
  });
});

describe("parseAmount", () => {
  it("parses decimals exactly into base units", () => {
    expect(parseAmount("12.5", 6)).toBe(12_500_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount(".5", 6)).toBe(500_000n);
    expect(parseAmount("1,000", 6)).toBe(1_000_000_000n);
    expect(parseAmount("1.5", 18)).toBe(1_500_000_000_000_000_000n);
  });

  it("refuses zero, negatives, too many decimals and junk", () => {
    for (const bad of ["", "0", "0.0", "-1", "1e3", "abc", "1.0000001", ".", "1.2.3"]) expect(parseAmount(bad, 6)).toBeNull();
  });
});

describe("buildSendCall", () => {
  const abi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
  it("sends tokens with transfer and CELO as plain value", () => {
    const usdt = buildSendCall("USDT", DEST as Address, 5n);
    expect(usdt.to).toBe(USDT);
    expect(usdt.value).toBe(0n);
    expect(decodeFunctionData({ abi, data: usdt.data }).args).toEqual([DEST, 5n]);
    expect(buildSendCall("XAUT0", DEST as Address, 7n).to).toBe(XAUT0);
    expect(buildSendCall("CELO", DEST as Address, 9n)).toEqual({ to: DEST, data: "0x", value: 9n });
    expect(() => buildSendCall("CELO", DEST as Address, 0n)).toThrow();
  });
});

describe("maxSendable", () => {
  it("leaves the fee with headroom when the fee is paid in the same asset", () => {
    expect(maxSendable("USDT", 10_000_000n, { fee: 10_000n, feeToken: USDT, extraNative: 0n })).toBe(9_985_000n);
    expect(maxSendable("XAUT0", 1_000n, { fee: 10_000n, feeToken: USDT, extraNative: 0n })).toBe(1_000n);
  });

  it("leaves the native fee and the registration value for CELO", () => {
    const celo = 25n * 10n ** 18n;
    const fee = 10n ** 16n;
    const reg = 20n * 10n ** 18n;
    expect(maxSendable("CELO", celo, { fee, feeToken: zeroAddress, extraNative: reg })).toBe(celo - reg - (fee * 3n) / 2n);
    expect(maxSendable("CELO", celo, { fee: 10_000n, feeToken: USDT, extraNative: 0n })).toBe(celo);
    expect(maxSendable("CELO", reg, { fee, feeToken: zeroAddress, extraNative: reg })).toBe(0n);
  });
});
