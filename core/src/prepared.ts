/**
 * Intents prepared by Altana's relay (`wallet_prepareCalls`), signed with the
 * session key and submitted by our own EOA instead of the relay
 * (`AUTUMN_SUBMITTER=direct-prepared`, docs/direct-submit.md).
 *
 * The relay's answer carries the complete `ICommon.Intent` in
 * `context.quote.quotes[0].intent`, with an empty `signature`. Nothing in it
 * is trusted: every field is parsed strictly and checked against what we
 * asked for, and the digest the session key signs is computed here from
 * those checked fields, never taken from the relay.
 *
 * Pure functions only; nothing here reads the chain, calls the relay or signs.
 */
import { getAddress, isAddress, keccak256, zeroAddress, type Address, type Hex } from "viem";
import type { Call } from "./calls.js";
import { ALTANA_FEE_RECIPIENT, ALTANA_ORCHESTRATOR, CELO_CHAIN_ID, USDT } from "./constants.js";
import {
  ALTANA_ACCOUNT_IMPLEMENTATION,
  encodeExecutionData,
  intentDigest,
  isMultichainNonce,
  sdkLaneSeqKey,
  type Intent,
} from "./intent.js";

/** Relay JSON-RPC methods the prepared-intent submitter may call. Nothing that submits is on this list. */
export const RELAY_READ_ONLY_METHODS = ["wallet_prepareCalls", "wallet_getCapabilities"] as const;

/** Upper bound on the signed `combinedGas` we accept (the agent EOA pays for it). Our buys use about 450k. */
export const MAX_PREPARED_COMBINED_GAS = 2_000_000n;

/** A non-zero expiry must leave at least this long to land, seconds. */
export const MIN_PREPARED_EXPIRY_HEADROOM_SECS = 60n;

/**
 * The `wallet_prepareCalls` parameters for a session-key intent, as
 * `@altananetwork/sdk` 1.1.0 sends them through porto 0.2.37
 * (`RelayActions.prepareCalls`: `key` is `Key.toRelay` of the session key,
 * whose public key for secp256k1 is its address left-padded to 32 bytes;
 * `meta.nonce` is the SDK's per-key lane nonce).
 */
export function prepareCallsParams(args: {
  wallet: Address;
  calls: readonly Call[];
  sessionKeyAddress: Address;
  feeToken: Address;
  nonce: bigint;
  chainId?: number;
}) {
  const hex = (v: bigint) => `0x${v.toString(16)}`;
  return {
    calls: args.calls.map((c) => ({ to: getAddress(c.to), data: c.data, value: hex(c.value) })),
    capabilities: { authorizeKeys: [], meta: { feeToken: getAddress(args.feeToken), nonce: hex(args.nonce) }, preCall: false },
    chainId: hex(BigInt(args.chainId ?? CELO_CHAIN_ID)),
    from: getAddress(args.wallet),
    key: { prehash: false, publicKey: `0x${args.sessionKeyAddress.slice(2).toLowerCase().padStart(64, "0")}`, type: "secp256k1" },
  };
}

/** The parts of a relay quote we use. */
export type PreparedIntent = {
  intent: Intent;
  /** The digest the relay asked the key to sign. Recorded for comparison only; never signed. */
  relayDigest: Hex | undefined;
  /** The Orchestrator the relay quoted for. */
  orchestrator: Address;
  chainId: number;
};

export class PreparedIntentError extends Error {
  override readonly name = "PreparedIntentError";
}

type Json = Record<string, unknown>;

function obj(v: unknown, what: string): Json {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PreparedIntentError(`the relay's answer has no ${what}`);
  return v as Json;
}
function hexOf(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new PreparedIntentError(`${what} is not hex bytes`);
  return v.toLowerCase() as Hex;
}
function quantity(v: unknown, what: string): bigint {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new PreparedIntentError(`${what} is not a hex quantity`);
  return BigInt(v);
}
function address(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new PreparedIntentError(`${what} is not an address`);
  return getAddress(v);
}
function bytesArray(v: unknown, what: string): Hex[] {
  if (!Array.isArray(v)) throw new PreparedIntentError(`${what} is not an array`);
  return v.map((x, i) => hexOf(x, `${what}[${i}]`));
}

const INTENT_KEYS = [
  "eoa", "executionData", "nonce", "payer", "paymentToken", "paymentMaxAmount", "combinedGas", "encodedPreCalls",
  "encodedFundTransfers", "settler", "expiry", "isMultichain", "funder", "funderSignature", "settlerContext",
  "paymentAmount", "paymentRecipient", "signature", "paymentSignature", "supportedAccountImplementation",
] as const;

/**
 * Reads the intent out of a `wallet_prepareCalls` answer. Refuses anything
 * but a single-chain answer with exactly one quote whose intent has exactly
 * the 20 fields of Orchestrator 0.5.5's `ICommon.Intent` (the newer relay
 * shape with `totalPaymentMaxAmount`/`prePayment*` is not what this
 * Orchestrator decodes), and no pre-call context.
 */
export function parsePreparedCalls(raw: unknown): PreparedIntent {
  const res = obj(raw, "result");
  const context = obj(res.context, "context");
  if (context.preCall !== undefined && context.preCall !== null) throw new PreparedIntentError("the relay prepared a pre-call, not an intent");
  const quote = obj(context.quote, "quote");
  if (quote.multiChainRoot !== undefined && quote.multiChainRoot !== null) throw new PreparedIntentError("the relay prepared a multichain intent");
  const quotes = quote.quotes;
  if (!Array.isArray(quotes) || quotes.length !== 1) throw new PreparedIntentError("the relay's answer must carry exactly one quote");
  const q = obj(quotes[0], "quote entry");
  const raw_ = obj(q.intent, "intent");
  const keys = Object.keys(raw_).sort();
  const expected = [...INTENT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new PreparedIntentError(`the prepared intent's fields are not Orchestrator 0.5.5's Intent: ${keys.join(",")}`);
  }
  if (typeof raw_.isMultichain !== "boolean") throw new PreparedIntentError("isMultichain is not a boolean");
  const intent: Intent = {
    eoa: address(raw_.eoa, "eoa"),
    executionData: hexOf(raw_.executionData, "executionData"),
    nonce: quantity(raw_.nonce, "nonce"),
    payer: address(raw_.payer, "payer"),
    paymentToken: address(raw_.paymentToken, "paymentToken"),
    paymentMaxAmount: quantity(raw_.paymentMaxAmount, "paymentMaxAmount"),
    combinedGas: quantity(raw_.combinedGas, "combinedGas"),
    encodedPreCalls: bytesArray(raw_.encodedPreCalls, "encodedPreCalls"),
    encodedFundTransfers: bytesArray(raw_.encodedFundTransfers, "encodedFundTransfers"),
    settler: address(raw_.settler, "settler"),
    expiry: quantity(raw_.expiry, "expiry"),
    isMultichain: raw_.isMultichain,
    funder: address(raw_.funder, "funder"),
    funderSignature: hexOf(raw_.funderSignature, "funderSignature"),
    settlerContext: hexOf(raw_.settlerContext, "settlerContext"),
    paymentAmount: quantity(raw_.paymentAmount, "paymentAmount"),
    paymentRecipient: address(raw_.paymentRecipient, "paymentRecipient"),
    signature: hexOf(raw_.signature, "signature"),
    paymentSignature: hexOf(raw_.paymentSignature, "paymentSignature"),
    supportedAccountImplementation: address(raw_.supportedAccountImplementation, "supportedAccountImplementation"),
  };
  const chainId = Number(quantity(q.chainId, "chainId"));
  const orchestrator = address(q.orchestrator, "orchestrator");
  const relayDigest = typeof res.digest === "string" && /^0x[0-9a-fA-F]{64}$/.test(res.digest) ? (res.digest.toLowerCase() as Hex) : undefined;
  return { intent, relayDigest, orchestrator, chainId };
}

export type PreparedIntentExpectation = {
  wallet: Address;
  calls: readonly Call[];
  /** The session key's account key hash: the nonce must be on the SDK's lane for it. */
  keyHash: Hex;
  /** The exact nonce we asked the relay to use (`getNonce` of that lane). */
  nonce: bigint;
  /** Chain time, seconds. */
  now: bigint;
  /**
   * The most the wallet may pay for this intent, in `feeToken` base units:
   * the plan's per-buy fee allowance. `null` skips the fee bound only (used
   * by `quote`, which returns the fee so the runner's own allowance check
   * decides); the token and recipient are still checked.
   */
  maxFee: bigint | null;
  feeToken?: Address;
  feeRecipient?: Address;
  orchestrator?: Address;
  accountImplementation?: Address;
  chainId?: number;
};

/**
 * Every field of a relay-prepared intent, checked against what we asked for.
 * Returns the problems found (empty when the intent may be signed). Nothing
 * is assumed: an intent with a field this function does not expect is refused.
 */
export function preparedIntentProblems(p: PreparedIntent, e: PreparedIntentExpectation): string[] {
  const i = p.intent;
  const problems: string[] = [];
  const eq = (a: Address, b: Address) => getAddress(a) === getAddress(b);
  const orchestrator = e.orchestrator ?? ALTANA_ORCHESTRATOR;
  const impl = e.accountImplementation ?? ALTANA_ACCOUNT_IMPLEMENTATION;
  const feeToken = e.feeToken ?? USDT;
  const recipient = e.feeRecipient ?? ALTANA_FEE_RECIPIENT;

  if (p.chainId !== (e.chainId ?? CELO_CHAIN_ID)) problems.push(`quoted for chain ${p.chainId}`);
  if (!eq(p.orchestrator, orchestrator)) problems.push(`quoted for Orchestrator ${p.orchestrator}, not ${orchestrator}`);

  // What is executed, and for whom.
  if (!eq(i.eoa, e.wallet)) problems.push(`eoa is ${i.eoa}, not the plan's wallet ${getAddress(e.wallet)}`);
  if (i.executionData !== encodeExecutionData(e.calls).toLowerCase()) {
    problems.push(`executionData is not exactly our calls (got ${keccak256(i.executionData)})`);
  }
  if (i.encodedPreCalls.length !== 0) problems.push("carries pre-calls");
  if (i.encodedFundTransfers.length !== 0) problems.push("carries fund transfers");
  if (i.isMultichain) problems.push("is multichain");
  if (!eq(i.settler, zeroAddress) || i.settlerContext !== "0x") problems.push("names a settler");
  if (!eq(i.funder, zeroAddress) || i.funderSignature !== "0x") problems.push("names a funder");

  // Nonce: exactly the one we asked for, on the SDK's lane for this key, never multichain.
  if (isMultichainNonce(i.nonce)) problems.push("has a multichain nonce");
  if (i.nonce !== e.nonce) problems.push(`nonce is 0x${i.nonce.toString(16)}, not the 0x${e.nonce.toString(16)} we asked for`);
  if (i.nonce >> 64n !== sdkLaneSeqKey(e.keyHash)) problems.push("nonce is not on the session key's lane");

  // Payment: the wallet pays Altana's fee recipient, in the fee token, within the allowance.
  if (!eq(i.payer, zeroAddress)) problems.push(`payer is ${i.payer}, not the wallet`);
  if (!eq(i.paymentToken, feeToken)) problems.push(`fee token is ${i.paymentToken}, not ${getAddress(feeToken)}`);
  if (!eq(i.paymentRecipient, recipient)) problems.push(`fee recipient is ${i.paymentRecipient}, not Altana's ${getAddress(recipient)}`);
  if (i.paymentAmount > i.paymentMaxAmount) problems.push("paymentAmount is above paymentMaxAmount");
  if (e.maxFee !== null && i.paymentMaxAmount > e.maxFee) {
    problems.push(`maximum fee ${i.paymentMaxAmount} is above the plan's allowance ${e.maxFee}`);
  }
  if (i.paymentSignature !== "0x") problems.push("carries a payment signature");

  // Gas, expiry, signature, account.
  if (i.combinedGas <= 0n || i.combinedGas > MAX_PREPARED_COMBINED_GAS) problems.push(`combinedGas ${i.combinedGas} is outside (0, ${MAX_PREPARED_COMBINED_GAS}]`);
  if (i.expiry !== 0n && i.expiry < e.now + MIN_PREPARED_EXPIRY_HEADROOM_SECS) problems.push(`expires at ${i.expiry}, too soon to land`);
  if (i.signature !== "0x") problems.push("already carries a signature");
  if (!eq(i.supportedAccountImplementation, impl)) {
    problems.push(`supportedAccountImplementation is ${i.supportedAccountImplementation}, not ${getAddress(impl)}`);
  }
  return problems;
}

/**
 * The checked intent and the digest to sign: `Orchestrator._computeDigest` of
 * it, computed locally. Throws PreparedIntentError listing every problem.
 */
export function checkPreparedIntent(p: PreparedIntent, e: PreparedIntentExpectation): { intent: Intent; digest: Hex; relayDigestMatches: boolean } {
  const problems = preparedIntentProblems(p, e);
  if (problems.length) throw new PreparedIntentError(`refusing the relay's prepared intent: ${problems.join("; ")}`);
  const digest = intentDigest({ ...p.intent, calls: e.calls }, { chainId: e.chainId ?? CELO_CHAIN_ID, orchestrator: e.orchestrator ?? ALTANA_ORCHESTRATOR });
  return { intent: { ...p.intent }, digest, relayDigestMatches: p.relayDigest === digest.toLowerCase() };
}
