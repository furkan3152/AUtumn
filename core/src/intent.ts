/**
 * Ithaca/Porto intents for the Altana Orchestrator on Celo, built and signed
 * locally so that a submitter of our own ("plan B", docs/direct-submit.md) can
 * call `Orchestrator.execute(bytes)` with the ERC-8021 tag at the very end of
 * the outer transaction's calldata.
 *
 * Every layout below is taken from the verified sources (Sourcify, chain 42220):
 * - Orchestrator 0xaf140d04…9751 (v0.5.5): `src/interfaces/ICommon.sol` (struct
 *   Intent), `src/Orchestrator.sol` (`INTENT_TYPEHASH`, `_computeDigest`,
 *   `_domainNameAndVersion` = ("Orchestrator", "0.5.5")).
 * - IthacaAccount 0x4b5d20cd…fa79 (v0.5.10): `unwrapAndValidateSignature`
 *   (signature = innerSignature ‖ keyHash ‖ prehash byte), `getNonce(uint192)`.
 * Pure functions only; nothing here reads the chain or signs.
 */
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { ATTRIBUTION_SUFFIX, type Call } from "./calls.js";
import { CELO_CHAIN_ID } from "./constants.js";

/** Altana Orchestrator on Celo mainnet (relay `wallet_getCapabilities`, verified source "Orchestrator" 0.5.5). */
export const ALTANA_ORCHESTRATOR: Address = "0xAF140d0416A994Aebb3fA6212B16CE6700f09751";
/** IthacaAccount implementation the Altana relay delegates Celo wallets to (v0.5.10). */
export const ALTANA_ACCOUNT_IMPLEMENTATION: Address = "0x4B5d20CD8a3927B500540d9BcCDDc27385c9fA79";
/** EIP-7702 proxy Altana wallets on Celo delegate to (`0xef0100 ‖ proxy` is the wallet's code). */
export const ALTANA_ACCOUNT_PROXY: Address = "0xc0F16888F4198F53892c53AF859f673e23f26fA3";

export const ORCHESTRATOR_EIP712_NAME = "Orchestrator";
export const ORCHESTRATOR_EIP712_VERSION = "0.5.5";

/** `ICommon.Intent`, field for field and in the same order (ICommon.sol lines 11–83). */
export type Intent = {
  // EIP-712 fields
  eoa: Address;
  executionData: Hex;
  nonce: bigint;
  payer: Address;
  paymentToken: Address;
  paymentMaxAmount: bigint;
  combinedGas: bigint;
  encodedPreCalls: readonly Hex[];
  encodedFundTransfers: readonly Hex[];
  settler: Address;
  expiry: bigint;
  // Not signed
  isMultichain: boolean;
  funder: Address;
  funderSignature: Hex;
  settlerContext: Hex;
  paymentAmount: bigint;
  paymentRecipient: Address;
  signature: Hex;
  paymentSignature: Hex;
  supportedAccountImplementation: Address;
};

const INTENT_COMPONENTS = [
  { name: "eoa", type: "address" },
  { name: "executionData", type: "bytes" },
  { name: "nonce", type: "uint256" },
  { name: "payer", type: "address" },
  { name: "paymentToken", type: "address" },
  { name: "paymentMaxAmount", type: "uint256" },
  { name: "combinedGas", type: "uint256" },
  { name: "encodedPreCalls", type: "bytes[]" },
  { name: "encodedFundTransfers", type: "bytes[]" },
  { name: "settler", type: "address" },
  { name: "expiry", type: "uint256" },
  { name: "isMultichain", type: "bool" },
  { name: "funder", type: "address" },
  { name: "funderSignature", type: "bytes" },
  { name: "settlerContext", type: "bytes" },
  { name: "paymentAmount", type: "uint256" },
  { name: "paymentRecipient", type: "address" },
  { name: "signature", type: "bytes" },
  { name: "paymentSignature", type: "bytes" },
  { name: "supportedAccountImplementation", type: "address" },
] as const;

export const INTENT_ABI_PARAMETER = { type: "tuple", components: INTENT_COMPONENTS } as const;

const CALL_COMPONENTS = [
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "data", type: "bytes" },
] as const;

export const orchestratorAbi = parseAbi([
  "function execute(bytes encodedIntent) payable returns (bytes4 err)",
  "function simulateExecute(bool isStateOverride, uint256 combinedGasOverride, bytes encodedIntent) payable returns (uint256)",
  "function accountImplementationOf(address eoa) view returns (address)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "event IntentExecuted(address indexed eoa, uint256 indexed nonce, bool incremented, bytes4 err)",
  "error SimulationPassed(uint256 gUsed)",
  "error PaymentError()",
  "error VerificationError()",
  "error CallError()",
  "error VerifiedCallError()",
  "error InsufficientGas()",
  "error InvalidNonce()",
  "error IntentExpired()",
  "error UnsupportedAccountImplementation()",
  "error PreCallVerificationError()",
  "error PreCallError()",
  "error StateOverrideError()",
]);

/** Errors the account (IthacaAccount / GuardedExecutor) reverts with that an intent can surface. */
export const ithacaAccountErrorsAbi = parseAbi([
  // GuardedExecutor.sol lines 84–105
  "error KeyHashIsZero()",
  "error CannotSelfExecute()",
  "error Unauthorized()",
  "error UnauthorizedCall(bytes32 keyHash, address target, bytes data)",
  "error ExceededSpendLimit(address token)",
  "error NoSpendPermissions()",
  "error SuperAdminCanExecuteEverything()",
  "error SuperAdminCanSpendAnything()",
  // IthacaAccount.sol lines 123–140
  "error KeyDoesNotExist()",
  "error OpDataError()",
  "error KeyTypeCannotBeSuperAdmin()",
  "error InvalidPublicKey()",
  "error NewImplementationIsZero()",
  "error PaymasterNonceError()",
  // LibNonce.sol, solady ERC7821.sol
  "error InvalidNonce()",
  "error NewSequenceMustBeLarger()",
  "error UnsupportedExecutionMode()",
  "error BatchOfBatchesDecodingError()",
]);

/**
 * Names of the 4-byte error selectors an intent can report in
 * `IntentExecuted.err` / `execute`'s return value. Only the selector is
 * returned there, never the arguments, so lookup is by selector.
 */
export const INTENT_ERROR_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  [...orchestratorAbi, ...ithacaAccountErrorsAbi]
    .filter((x) => x.type === "error")
    .map((x) => [toFunctionSelector(`${x.name}(${x.inputs.map((i) => i.type).join(",")})`).toLowerCase(), x.name])
    .concat([["0x08c379a0", "Error(string)"], ["0x4e487b71", "Panic(uint256)"]]),
);

/** The name of an intent error selector, or undefined for success (0x00000000) and unknown selectors. */
export function intentErrorName(selector: Hex): string | undefined {
  return INTENT_ERROR_NAMES[selector.toLowerCase()];
}

/** IthacaAccount reads used before signing. */
export const ithacaAccountNonceAbi = parseAbi(["function getNonce(uint192 seqKey) view returns (uint256)"]);

/** `abi.encode(calls)` with `Call(address to, uint256 value, bytes data)`: the intent's `executionData` (ERC-7579 batch). */
export function encodeExecutionData(calls: readonly Call[]): Hex {
  return encodeAbiParameters(
    [{ type: "tuple[]", components: CALL_COMPONENTS }],
    [calls.map((c) => ({ to: getAddress(c.to), value: c.value, data: c.data }))],
  );
}

/** `abi.encode(intent)`: the single argument of `Orchestrator.execute(bytes)`. */
export function encodeIntent(intent: Intent): Hex {
  return encodeAbiParameters([INTENT_ABI_PARAMETER], [intent]);
}

/** Upper 16 bits of a nonce that make the digest chain-agnostic (Orchestrator `MULTICHAIN_NONCE_PREFIX`). */
export const MULTICHAIN_NONCE_PREFIX = 0xc1d0n;
/** Upper 16 bits of the SDK's own per-key lane (`@altananetwork/sdk` internal/appNonceLane.js). */
export const SDK_APP_LANE_PREFIX = 0xa17an;
/** Upper 16 bits of the lane the direct submitter uses: distinct from the SDK's, so the two never race for a nonce. */
export const DIRECT_LANE_PREFIX = 0xd1ecn;

const MASK_176 = (1n << 176n) - 1n;
const MASK_64 = (1n << 64n) - 1n;

/**
 * The 192-bit sequence key the direct submitter uses for a session key: its
 * own lane, derived from the key hash, never the SDK's `0xa17a…` lane nor the
 * multichain prefix. Ordering only matters within a lane (Intent.nonce docs).
 */
export function directLaneSeqKey(keyHash: Hex): bigint {
  const h = BigInt(keccak256(concat([keyHash, toHex("autumn/direct-submit/v1")])));
  return (DIRECT_LANE_PREFIX << 176n) | (h & MASK_176);
}

/** The SDK's lane for the same key (for reading only; the direct submitter never signs on it). */
export function sdkLaneSeqKey(keyHash: Hex): bigint {
  const h = BigInt(keccak256(keyHash));
  return (SDK_APP_LANE_PREFIX << 176n) | (h & MASK_176);
}

/** `getNonce(seqKey)` returns `seqKey << 64 | counter`; this is the nonce to sign for that counter. */
export function laneNonce(seqKey: bigint, counter: bigint): bigint {
  return (seqKey << 64n) | (counter & MASK_64);
}

export function isMultichainNonce(nonce: bigint): boolean {
  return nonce >> 240n === MULTICHAIN_NONCE_PREFIX;
}

/** The Orchestrator's EIP-712 domain on a chain (solady EIP712: name, version, chainId, verifyingContract). */
export function orchestratorDomain(chainId: number = CELO_CHAIN_ID, orchestrator: Address = ALTANA_ORCHESTRATOR) {
  return {
    name: ORCHESTRATOR_EIP712_NAME,
    version: ORCHESTRATOR_EIP712_VERSION,
    chainId,
    verifyingContract: getAddress(orchestrator),
  } as const;
}

/** The EIP-712 types of `INTENT_TYPEHASH` (Orchestrator.sol line 113). */
export const INTENT_EIP712_TYPES = {
  Intent: [
    { name: "multichain", type: "bool" },
    { name: "eoa", type: "address" },
    { name: "calls", type: "Call[]" },
    { name: "nonce", type: "uint256" },
    { name: "payer", type: "address" },
    { name: "paymentToken", type: "address" },
    { name: "paymentMaxAmount", type: "uint256" },
    { name: "combinedGas", type: "uint256" },
    { name: "encodedPreCalls", type: "bytes[]" },
    { name: "encodedFundTransfers", type: "bytes[]" },
    { name: "settler", type: "address" },
    { name: "expiry", type: "uint256" },
  ],
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
} as const;

/**
 * The digest the account's key signs: `Orchestrator._computeDigest(Intent)`.
 * `calls` must be the calls `intent.executionData` encodes. Multichain nonces
 * are refused: their digest drops the chain id and this module never builds one.
 */
export function intentDigest(
  intent: Omit<Intent, "executionData"> & { calls: readonly Call[] },
  opts: { chainId?: number; orchestrator?: Address } = {},
): Hex {
  if (isMultichainNonce(intent.nonce)) throw new Error("multichain nonces are not supported");
  return hashTypedData({
    domain: orchestratorDomain(opts.chainId, opts.orchestrator),
    types: INTENT_EIP712_TYPES,
    primaryType: "Intent",
    message: {
      multichain: false,
      eoa: getAddress(intent.eoa),
      calls: intent.calls.map((c) => ({ to: getAddress(c.to), value: c.value, data: c.data })),
      nonce: intent.nonce,
      payer: intent.payer,
      paymentToken: intent.paymentToken,
      paymentMaxAmount: intent.paymentMaxAmount,
      combinedGas: intent.combinedGas,
      encodedPreCalls: [...intent.encodedPreCalls],
      encodedFundTransfers: [...intent.encodedFundTransfers],
      settler: intent.settler,
      expiry: intent.expiry,
    },
  });
}

/**
 * The signature the account unwraps: `innerSignature ‖ keyHash ‖ prehash`
 * (IthacaAccount `unwrapAndValidateSignature`; porto `Key.wrapSignature`).
 * A bare 64/65-byte signature would be checked against the EOA root key, so a
 * session signature must always be wrapped.
 */
export function wrapKeySignature(innerSignature: Hex, keyHash: Hex, prehash = false): Hex {
  return concat([innerSignature, keyHash, prehash ? "0x01" : "0x00"]);
}

export type UnsignedSessionIntent = {
  intent: Intent;
  calls: readonly Call[];
};

/**
 * A single-chain intent with no payment: the wallet pays nobody, and the
 * submitter pays the gas itself. `paymentAmount` and `paymentRecipient` are
 * outside the signature anyway (ICommon.sol lines 67–72); `paymentMaxAmount`
 * is signed as 0, so no filler can draw any payment from the wallet with it.
 * `supportedAccountImplementation` (unsigned) makes the Orchestrator refuse
 * the intent if the wallet is no longer on the implementation it was built for.
 */
export function buildSessionIntent(args: {
  wallet: Address;
  calls: readonly Call[];
  nonce: bigint;
  combinedGas: bigint;
  expiry: bigint;
  accountImplementation?: Address;
}): UnsignedSessionIntent {
  if (args.calls.length === 0) throw new Error("an intent needs at least one call");
  if (args.combinedGas <= 0n) throw new Error("combinedGas must be positive");
  if (args.expiry <= 0n) throw new Error("an intent without expiry could be replayed at any later time; set one");
  if (isMultichainNonce(args.nonce)) throw new Error("multichain nonces are not supported");
  return {
    calls: args.calls,
    intent: {
      eoa: getAddress(args.wallet),
      executionData: encodeExecutionData(args.calls),
      nonce: args.nonce,
      payer: zeroAddress,
      paymentToken: zeroAddress,
      paymentMaxAmount: 0n,
      combinedGas: args.combinedGas,
      encodedPreCalls: [],
      encodedFundTransfers: [],
      settler: zeroAddress,
      expiry: args.expiry,
      isMultichain: false,
      funder: zeroAddress,
      funderSignature: "0x",
      settlerContext: "0x",
      paymentAmount: 0n,
      paymentRecipient: zeroAddress,
      signature: "0x",
      paymentSignature: "0x",
      supportedAccountImplementation: getAddress(args.accountImplementation ?? ALTANA_ACCOUNT_IMPLEMENTATION),
    },
  };
}

/**
 * The outer transaction's calldata: `execute(abi.encode(intent))` followed by
 * the ERC-8021 suffix as the last bytes. Solidity reads `bytes calldata` by
 * its offset and length, so bytes after the ABI-encoded argument are never
 * read; and the Orchestrator's self-call copies only `encodedIntent`
 * (Orchestrator.sol line 368), so the suffix never reaches the account.
 */
export function executeCalldata(intent: Intent, suffix: Hex | null = ATTRIBUTION_SUFFIX): Hex {
  const body = encodeFunctionData({ abi: orchestratorAbi, functionName: "execute", args: [encodeIntent(intent)] });
  return suffix ? concat([body, suffix]) : body;
}

/** Calldata for `simulateExecute(false, 0, abi.encode(intent))`, which always reverts (SimulationPassed on success). */
export function simulateExecuteCalldata(intent: Intent, combinedGasOverride = 0n): Hex {
  return encodeFunctionData({
    abi: orchestratorAbi,
    functionName: "simulateExecute",
    args: [false, combinedGasOverride, encodeIntent(intent)],
  });
}
