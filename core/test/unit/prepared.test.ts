/**
 * Relay-prepared intents (core/src/prepared.ts). The fixture holds a real
 * `wallet_prepareCalls` answer from Altana's relay and the decoded intents
 * of real Celo mainnet transactions (core/test/fixtures/relay-prepared-intents.json).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  decodeAbiParameters,
  getAddress,
  hashTypedData,
  size,
  slice,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { buildBuyCalls, type Call } from "../../src/calls.js";
import { ALTANA_FEE_RECIPIENT, ALTANA_ORCHESTRATOR, USDT } from "../../src/constants.js";
import { DEFAULT_FEE_ALLOWANCE_PER_BUY } from "../../src/grant.js";
import { ALTANA_ACCOUNT_IMPLEMENTATION, encodeExecutionData, intentDigest, laneNonce, sdkLaneSeqKey } from "../../src/intent.js";
import {
  checkPreparedIntent,
  MAX_PREPARED_COMBINED_GAS,
  parsePreparedCalls,
  prepareCallsParams,
  PreparedIntentError,
  preparedIntentProblems,
  type PreparedIntentExpectation,
} from "../../src/prepared.js";

type RawIntent = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL("../fixtures/relay-prepared-intents.json", import.meta.url), "utf8")) as {
  prepareCalls: { params: Record<string, unknown>; result: Record<string, unknown> & { context: { quote: { quotes: { intent: RawIntent }[] } }; typedData: Record<string, unknown> } };
  mainnetIntents: { hash: Hex; from: Address; intent: RawIntent; note: string }[];
};
const CALLS_TUPLE = [{ type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }] as const;
const callsOf = (executionData: Hex): Call[] => decodeAbiParameters(CALLS_TUPLE, executionData)[0].map((c) => ({ to: c.to, value: c.value, data: c.data }));
const mainnet = (prefix: string) => fixture.mainnetIntents.find((m) => m.hash.startsWith(prefix))!;

/**
 * A relay answer in the exact envelope the relay returned on 2026-11-22, with
 * `intent` in place of the quoted one. A mainnet intent becomes what the relay
 * prepared before it was sent: no signature yet, and paymentAmount equal to
 * paymentMaxAmount (as in every prepared answer we read; the relay lowers the
 * amount only when it submits itself).
 */
function answerWith(intent: RawIntent, patch: (q: Record<string, unknown>) => void = () => {}): unknown {
  const a = structuredClone(fixture.prepareCalls.result);
  const q = a.context.quote.quotes[0] as unknown as Record<string, unknown>;
  q.intent = { ...intent };
  patch(q);
  return a;
}
const asPrepared = (i: RawIntent): RawIntent => ({ ...i, signature: "0x", paymentAmount: i.paymentMaxAmount });

/** Autumn's own relay-sent purchase (tx 0xe6f4…), as the relay prepared it. */
const ours = mainnet("0xe6f4");
const ourKeyHash = slice(ours.intent.signature as Hex, 65, 97);
const ourCalls = callsOf(ours.intent.executionData as Hex);
const expectOurs = (over: Partial<PreparedIntentExpectation> = {}): PreparedIntentExpectation => ({
  wallet: getAddress(ours.intent.eoa as Address),
  calls: ourCalls,
  keyHash: ourKeyHash,
  nonce: BigInt(ours.intent.nonce as string),
  now: 1_795_000_000n,
  maxFee: DEFAULT_FEE_ALLOWANCE_PER_BUY,
  ...over,
});

describe("the relay's wallet_prepareCalls answer", () => {
  it("carries the complete Orchestrator 0.5.5 intent, unsigned, paying Altana's recipient, with no expiry", () => {
    const p = parsePreparedCalls(fixture.prepareCalls.result);
    expect(p.chainId).toBe(42220);
    expect(p.orchestrator).toBe(ALTANA_ORCHESTRATOR);
    expect(p.intent.signature).toBe("0x");
    expect(p.intent.paymentToken).toBe(USDT);
    expect(p.intent.paymentAmount).toBe(p.intent.paymentMaxAmount);
    expect(p.intent.paymentRecipient).toBe(ALTANA_FEE_RECIPIENT);
    expect(p.intent.expiry).toBe(0n);
    expect(p.intent.supportedAccountImplementation).toBe(ALTANA_ACCOUNT_IMPLEMENTATION);
    expect(p.intent.payer).toBe(zeroAddress);
    // Our digest is the EIP-712 hash of the relay's own typed data for the intent.
    const td = fixture.prepareCalls.result.typedData as { domain: Record<string, unknown>; types: Record<string, unknown>; message: Record<string, unknown> };
    const { EIP712Domain: _d, ...types } = td.types;
    const theirs = hashTypedData({ domain: { ...td.domain, chainId: Number(td.domain.chainId) }, types: types as never, primaryType: "Intent", message: td.message as never });
    expect(intentDigest({ ...p.intent, calls: callsOf(p.intent.executionData) })).toBe(theirs);
  });

  it("is refused when it is not one single-chain quote of exactly that intent", () => {
    const real = fixture.prepareCalls.result;
    const q0 = real.context.quote.quotes[0]!.intent;
    expect(() => parsePreparedCalls({ ...real, context: { quote: { ...real.context.quote, quotes: [] } } })).toThrow(PreparedIntentError);
    expect(() => parsePreparedCalls({ ...real, context: { quote: { ...real.context.quote, quotes: [real.context.quote.quotes[0], real.context.quote.quotes[0]] } } })).toThrow(/exactly one quote/);
    expect(() => parsePreparedCalls({ ...real, context: { ...real.context, preCall: {} } })).toThrow(/pre-call/);
    expect(() => parsePreparedCalls({ ...real, context: { quote: { ...real.context.quote, multiChainRoot: "0x01" } } })).toThrow(/multichain/);
    // The newer relay shape (totalPaymentMaxAmount, prePayment*) is not what Orchestrator 0.5.5 decodes.
    const { paymentMaxAmount: _m, paymentAmount: _a, ...rest } = q0;
    expect(() => parsePreparedCalls(answerWith({ ...rest, totalPaymentMaxAmount: "0x1", totalPaymentAmount: "0x1", prePaymentAmount: "0x0", prePaymentMaxAmount: "0x0" }))).toThrow(/fields/);
    expect(() => parsePreparedCalls(answerWith({ ...q0, extra: "0x" }))).toThrow(/fields/);
    expect(() => parsePreparedCalls(answerWith({ ...q0, nonce: 1 }))).toThrow(/nonce/);
    expect(() => parsePreparedCalls(answerWith({ ...q0, isMultichain: "false" }))).toThrow(/isMultichain/);
  });

  it("is asked for with the parameters the SDK sends (session key as its padded address, the lane nonce, the fee token)", () => {
    const keyAddress = getAddress("0x33dDA651Fa95EF713bB1028baEEb47aD8F66Ef15");
    const nonce = laneNonce(sdkLaneSeqKey(ourKeyHash), 3n);
    const p = prepareCallsParams({ wallet: ours.intent.eoa as Address, calls: ourCalls, sessionKeyAddress: keyAddress, feeToken: USDT, nonce });
    expect(p.key).toEqual({ prehash: false, publicKey: `0x000000000000000000000000${keyAddress.slice(2).toLowerCase()}`, type: "secp256k1" });
    expect(p.chainId).toBe("0xa4ec");
    expect(p.capabilities.meta).toEqual({ feeToken: USDT, nonce: `0x${nonce.toString(16)}` });
    expect(p.calls.map((c) => c.value)).toEqual(["0x0", "0x0"]);
    expect(p.calls.map((c) => c.data)).toEqual(ourCalls.map((c) => c.data));
    // Same envelope as the request the relay answered in the fixture.
    expect(Object.keys(p).sort()).toEqual(Object.keys(fixture.prepareCalls.params).sort());
  });
});

describe("checking a prepared intent field by field", () => {
  it("accepts our relay-sent purchase as the relay prepared it, and the nonce is the SDK lane of the key that signed it", () => {
    const p = parsePreparedCalls(answerWith(asPrepared(ours.intent)));
    expect(preparedIntentProblems(p, expectOurs())).toEqual([]);
    const { digest } = checkPreparedIntent(p, expectOurs());
    expect(digest).toBe(intentDigest({ ...p.intent, calls: ourCalls }));
    expect(BigInt(ours.intent.nonce as string) >> 64n).toBe(sdkLaneSeqKey(ourKeyHash));
  });

  it("the credited third-party intents are the same shape; those paying Altana in CELO are refused for the fee token", () => {
    for (const m of fixture.mainnetIntents) {
      const p = parsePreparedCalls(answerWith(asPrepared(m.intent)));
      const sig = m.intent.signature as Hex;
      const keyHash = size(sig) === 98 ? slice(sig, 65, 97) : ourKeyHash;
      const problems = preparedIntentProblems(p, {
        wallet: getAddress(m.intent.eoa as Address), calls: callsOf(m.intent.executionData as Hex), keyHash,
        nonce: BigInt(m.intent.nonce as string), now: 1_795_000_000n, maxFee: null,
      });
      const paysCelo = getAddress(m.intent.paymentToken as Address) === zeroAddress;
      const rootSigned = size(sig) === 65; // signed by the wallet's own EOA key: its lane is not derivable from a key hash here
      expect(p.intent.paymentRecipient).toBe(ALTANA_FEE_RECIPIENT);
      expect(p.intent.expiry).toBe(0n);
      expect(problems.filter((x) => !(rootSigned && /lane/.test(x)))).toEqual(paysCelo ? [`fee token is ${zeroAddress}, not ${USDT}`] : []);
    }
  });

  it("refuses every field we did not ask for", () => {
    const base = asPrepared(ours.intent);
    const otherWallet = "0x2222222222222222222222222222222222222222";
    const cases: [string, RawIntent | ((q: Record<string, unknown>) => void), RegExp][] = [
      ["eoa", { ...base, eoa: otherWallet }, /eoa is/],
      ["one call more", { ...base, executionData: encodeExecutionData([...ourCalls, ourCalls[0]!]) }, /executionData/],
      ["a different minOut", { ...base, executionData: encodeExecutionData(buildBuyCalls(1_000_000n, 1n, ourCalls[1]!.to)) }, /executionData/],
      ["untagged calls", { ...base, executionData: encodeExecutionData(ourCalls.map((c) => ({ ...c, data: slice(c.data, 0, size(c.data) - 35) }))) }, /executionData/],
      ["pre-calls", { ...base, encodedPreCalls: ["0x01"] }, /pre-calls/],
      ["fund transfers", { ...base, encodedFundTransfers: ["0x01"] }, /fund transfers/],
      ["multichain", { ...base, isMultichain: true }, /is multichain/],
      ["settler", { ...base, settler: otherWallet }, /settler/],
      ["funder", { ...base, funder: otherWallet }, /funder/],
      ["another nonce", { ...base, nonce: `0x${(BigInt(base.nonce as string) + 1n).toString(16)}` }, /not the 0x/],
      ["the relay's lane 0", { ...base, nonce: "0x1" }, /lane/],
      ["a multichain nonce", { ...base, nonce: `0x${((0xc1d0n << 240n) | 1n).toString(16)}` }, /multichain nonce/],
      ["a payer", { ...base, payer: otherWallet }, /payer/],
      ["fee in CELO", { ...base, paymentToken: zeroAddress }, /fee token/],
      ["another recipient", { ...base, paymentRecipient: otherWallet }, /fee recipient/],
      ["a fee above the allowance", { ...base, paymentMaxAmount: "0xc351", paymentAmount: "0xc351" }, /above the plan's allowance/],
      ["an amount above the maximum", { ...base, paymentAmount: `0x${(BigInt(base.paymentMaxAmount as string) + 1n).toString(16)}` }, /above paymentMaxAmount/],
      ["a payment signature", { ...base, paymentSignature: "0x01" }, /payment signature/],
      ["no gas", { ...base, combinedGas: "0x0" }, /combinedGas/],
      ["too much gas", { ...base, combinedGas: `0x${(MAX_PREPARED_COMBINED_GAS + 1n).toString(16)}` }, /combinedGas/],
      ["an expiry too soon", { ...base, expiry: `0x${(1_795_000_030n).toString(16)}` }, /too soon/],
      ["a signature already", { ...base, signature: "0x01" }, /already carries a signature/],
      ["any account implementation", { ...base, supportedAccountImplementation: zeroAddress }, /supportedAccountImplementation/],
      ["another Orchestrator", (q) => (q.orchestrator = otherWallet), /Orchestrator/],
      ["another chain", (q) => (q.chainId = "0xaa044c"), /chain/],
    ];
    for (const [label, change, msg] of cases) {
      const answer = typeof change === "function" ? answerWith(base, change) : answerWith(change);
      const problems = preparedIntentProblems(parsePreparedCalls(answer), expectOurs());
      expect(problems.join("; "), label).toMatch(msg);
      expect(() => checkPreparedIntent(parsePreparedCalls(answer), expectOurs()), label).toThrow(PreparedIntentError);
    }
    // A future expiry with room to land is accepted; so is the relay's usual 0 (never expires).
    expect(preparedIntentProblems(parsePreparedCalls(answerWith({ ...base, expiry: `0x${(1_795_000_600n).toString(16)}` })), expectOurs())).toEqual([]);
  });

  it("without a fee bound (quote) still checks the token and the recipient", () => {
    const over = { ...asPrepared(ours.intent), paymentMaxAmount: "0xc351", paymentAmount: "0xc351" };
    expect(preparedIntentProblems(parsePreparedCalls(answerWith(over)), expectOurs({ maxFee: null }))).toEqual([]);
    expect(preparedIntentProblems(parsePreparedCalls(answerWith({ ...over, paymentRecipient: zeroAddress })), expectOurs({ maxFee: null }))).not.toEqual([]);
  });
});
