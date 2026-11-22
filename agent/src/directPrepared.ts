/**
 * Relay-prepared, self-submitted executor (`AUTUMN_SUBMITTER=direct-prepared`,
 * docs/direct-submit.md section 5).
 *
 * Altana's relay prepares and prices the intent exactly as it does for the
 * SDK (`wallet_prepareCalls`, same calls, same session key, same fee token,
 * the SDK's nonce lane), so the intent still pays Altana's fee recipient from
 * the wallet, inside the session's USD₮ cap. The session key signs it as the
 * SDK would. The only difference: the agent's own EOA sends
 * `Orchestrator.execute(abi.encode(intent))` with the ERC-8021 tag as the
 * last bytes of the outer calldata, instead of handing the signature to the
 * relay (`wallet_sendPreparedCalls` is never called; the relay client here
 * refuses every method that is not read-only).
 *
 * Nothing the relay returns is trusted: every intent field is checked
 * (core/src/prepared.ts) and the digest is computed locally from the checked
 * fields. Then a preflight eth_call of the exact transaction, then the send
 * under the agent EOA's send lock, and CONFIRMED only when the wallet's
 * `Bought` is in the receipt, as with the `direct` executor.
 */
import {
  createClient,
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  getAddress,
  http,
  keccak256,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import type { ExecuteResult, SerializedSession } from "@altananetwork/sdk";
import {
  ALTANA_ACCOUNT_IMPLEMENTATION,
  ALTANA_FEE_RECIPIENT,
  ALTANA_ORCHESTRATOR,
  ATTRIBUTION_CODE,
  ATTRIBUTION_SUFFIX,
  checkPreparedIntent,
  DEFAULT_FEE_ALLOWANCE_PER_BUY,
  DirectSubmitError,
  encodeExecutionData,
  executeCalldata,
  fromDataSuffix,
  ithacaAccountNonceAbi,
  orchestratorAbi,
  parsePreparedCalls,
  prepareCallsParams,
  PreparedIntentError,
  RELAY_READ_ONLY_METHODS,
  sdkLaneSeqKey,
  USDT,
  wrapKeySignature,
  type Call,
  type Intent,
  type PreparedIntent,
} from "@autumn/core";
import { checkSessionOnAccount, createEoaSender, errName, kindOfRevert, ZERO_ERR, type IntentOutcome } from "./intentSubmit.js";
import type { SessionExecutor } from "./ports.js";
import { inProcessSendLock, type SendLock } from "./sendLock.js";

/** Altana's relay (`@altananetwork/sdk` 1.1.0 `CELO.relayUrl`). */
export const ALTANA_RELAY_URL = "https://relay.altana.network";

/** A relay JSON-RPC call. Only methods in RELAY_READ_ONLY_METHODS ever reach it. */
export type RelayRequest = (method: string, params: readonly unknown[]) => Promise<unknown>;

export type DirectPreparedExecutorOptions = {
  rpcUrl: string;
  /** Private key of the agent EOA that sends and pays gas. Never logged. */
  submitterKey: Hex;
  goldBuyer: Address;
  chain?: Chain;
  orchestrator?: Address;
  accountImplementation?: Address;
  /** Default ALTANA_RELAY_URL. */
  relayUrl?: string;
  /** Replaces the HTTP relay client (tests, the fork proof). Still guarded to read-only methods. */
  relayRequest?: RelayRequest;
  /** Replaces the HTTP chain transport (tests). */
  transport?: Transport;
  /**
   * Hard ceiling on `paymentMaxAmount` of any intent this executor signs, in
   * USD₮ base units. Default DEFAULT_FEE_ALLOWANCE_PER_BUY (0.05 USD₮). The
   * runner's per-plan allowance check happens on `quote()`'s answer, and
   * `execute` signs the very intent it quoted when it is still current.
   */
  maxFeePerBuy?: bigint;
  /** How long a quoted intent may be reused by `execute`, ms. Default 60 000. */
  quoteMaxAgeMs?: number;
  /** Receipt wait before reporting PENDING, ms. Default 120 000. */
  receiptTimeoutMs?: number;
  /** Suffix appended to the outer calldata. Default: the project's ERC-8021 tag. */
  suffix?: Hex | null;
  /** Serialises sends from the agent EOA (see DirectExecutorOptions.sendLock). */
  sendLock?: SendLock;
  /** How long to wait inside the lock for the RPC to count a broadcast transaction, ms. Default 15 000. */
  nonceSettleMs?: number;
  /** Clock for the quote cache, ms. Default Date.now. */
  clock?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

/** What one prepared submission is, for logs, tests and the proof. */
export type RelayPreparedSubmission = {
  wallet: Address;
  keyHash: Hex;
  /** The checked intent; `signature` is set only when signed. */
  intent: Intent;
  /** Orchestrator._computeDigest of the intent, computed locally: what the session key signs. */
  digest: Hex;
  /** Whether the relay's own `digest` equals ours (diagnostic; ours is what is signed either way). */
  relayDigestMatches: boolean;
  /** The relay's maximum fee for the intent, and its token. */
  fee: bigint;
  feeToken: Address;
  /** Whether the intent came from `quote()`'s answer rather than a new prepare. */
  reusedQuote: boolean;
  /** Outer calldata: execute(abi.encode(intent)) ‖ ERC-8021 suffix (only when signed). */
  data?: Hex;
  preflightErr?: Hex;
  preflightErrName?: string;
};

export type DirectPreparedExecutor = SessionExecutor & {
  readonly submitter: Address;
  prepare(args: { session: SerializedSession; privateKey: Hex; calls: readonly Call[] }, sign?: boolean): Promise<RelayPreparedSubmission>;
  lastOutcome(): IntentOutcome | undefined;
};

function firstLine(err: unknown): string {
  const e = err as { shortMessage?: unknown; details?: unknown; message?: unknown };
  const parts = [e?.shortMessage, e?.details, e?.message].filter((x): x is string => typeof x === "string");
  return (parts.join(" | ") || String(err)).split("\n")[0]!.slice(0, 500);
}

export function createDirectPreparedExecutor(opts: DirectPreparedExecutorOptions): DirectPreparedExecutor {
  const chain = opts.chain ?? celo;
  const orchestrator = getAddress(opts.orchestrator ?? ALTANA_ORCHESTRATOR);
  const implementation = getAddress(opts.accountImplementation ?? ALTANA_ACCOUNT_IMPLEMENTATION);
  const goldBuyer = getAddress(opts.goldBuyer);
  const maxFee = opts.maxFeePerBuy ?? DEFAULT_FEE_ALLOWANCE_PER_BUY;
  if (maxFee < 0n) throw new Error("maxFeePerBuy must not be negative");
  const quoteMaxAgeMs = opts.quoteMaxAgeMs ?? 60_000;
  const suffix = opts.suffix === undefined ? ATTRIBUTION_SUFFIX : opts.suffix;
  const clock = opts.clock ?? Date.now;
  const log = opts.log ?? (() => {});
  const account = privateKeyToAccount(opts.submitterKey);
  const transport = opts.transport ?? http(opts.rpcUrl, { retryCount: 0, timeout: 30_000 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const wallet = createWalletClient({ chain, transport, account });
  const sender = createEoaSender({
    pub, wallet, account, chain, orchestrator, goldBuyer,
    sendLock: opts.sendLock ?? inProcessSendLock,
    nonceSettleMs: opts.nonceSettleMs ?? 15_000,
    receiptTimeoutMs: opts.receiptTimeoutMs ?? 120_000,
    log,
    label: "direct-prepared submit",
  });

  const rawRelay: RelayRequest =
    opts.relayRequest ??
    (() => {
      const client = createClient({ chain, transport: http(opts.relayUrl ?? ALTANA_RELAY_URL, { retryCount: 0, timeout: 60_000 }) });
      return (method, params) => client.request({ method: method as never, params: params as never });
    })();
  /** Never lets anything that submits through, whatever calls it. */
  const relay: RelayRequest = (method, params) => {
    if (!(RELAY_READ_ONLY_METHODS as readonly string[]).includes(method)) {
      return Promise.reject(new Error(`refusing to call relay method ${method}: this executor only prepares through the relay`));
    }
    return rawRelay(method, params);
  };

  /** The intent `quote()` last prepared per wallet, key and calls, for `execute` to sign. */
  const quoted = new Map<string, { at: number; prepared: PreparedIntent }>();
  const cacheKey = (walletAddress: Address, keyHash: Hex, calls: readonly Call[]) => `${walletAddress}:${keyHash}:${keccak256(encodeExecutionData(calls))}`;
  let last: IntentOutcome | undefined;

  async function prepareFromRelay(args: { walletAddress: Address; keyAddress: Address; calls: readonly Call[]; nonce: bigint }): Promise<PreparedIntent> {
    const params = prepareCallsParams({ wallet: args.walletAddress, calls: args.calls, sessionKeyAddress: args.keyAddress, feeToken: USDT, nonce: args.nonce, chainId: chain.id });
    let raw: unknown;
    try {
      raw = await relay("wallet_prepareCalls", [params]);
    } catch (err) {
      // Nothing was signed, so nothing can have been sent.
      const text = firstLine(err);
      const kind = kindOfRevert(undefined, text);
      throw new DirectSubmitError(`The Altana relay could not prepare the purchase: ${text}`, kind === "unknown" ? "relay_failure" : kind, "no", { relay: text });
    }
    try {
      return parsePreparedCalls(raw);
    } catch (err) {
      throw new DirectSubmitError(`The Altana relay's prepared intent could not be read: ${(err as Error).message}`, "relay_failure", "no");
    }
  }

  async function prepare(
    { session, privateKey, calls }: { session: SerializedSession; privateKey: Hex; calls: readonly Call[] },
    sign = true,
  ): Promise<RelayPreparedSubmission> {
    const { signer, walletAddress, keyHash, keyAddress, now } = await checkSessionOnAccount(pub, { session, privateKey, orchestrator, implementation });

    // The SDK's own lane for this key (0xa17a…), with the counter the account reports now: what the SDK asks the relay for.
    const nonce = await pub.readContract({ address: walletAddress, abi: ithacaAccountNonceAbi, functionName: "getNonce", args: [sdkLaneSeqKey(keyHash)] });

    const k = cacheKey(walletAddress, keyHash, calls);
    const hit = quoted.get(k);
    quoted.delete(k);
    const reusedQuote = sign && !!hit && clock() - hit.at <= quoteMaxAgeMs && hit.prepared.intent.nonce === nonce;
    const prepared = reusedQuote ? hit!.prepared : await prepareFromRelay({ walletAddress, keyAddress, calls, nonce });

    let checked: ReturnType<typeof checkPreparedIntent>;
    try {
      checked = checkPreparedIntent(prepared, {
        wallet: walletAddress, calls, keyHash, nonce, now,
        // quote() returns the fee for the runner's per-plan check; anything signed is held to the ceiling as well.
        maxFee: sign ? maxFee : null,
        feeToken: USDT, feeRecipient: ALTANA_FEE_RECIPIENT, orchestrator, accountImplementation: implementation, chainId: chain.id,
      });
    } catch (err) {
      if (!(err instanceof PreparedIntentError)) throw err;
      throw new DirectSubmitError(err.message, "relay_failure", "no");
    }
    const { intent, digest, relayDigestMatches } = checked;
    if (!relayDigestMatches) log("direct-prepared digest differs from the relay's", { wallet: walletAddress, digest, relayDigest: prepared.relayDigest });
    if (!sign) quoted.set(k, { at: clock(), prepared });

    const base: RelayPreparedSubmission = {
      wallet: walletAddress, keyHash, intent, digest, relayDigestMatches,
      fee: intent.paymentMaxAmount, feeToken: getAddress(intent.paymentToken), reusedQuote,
    };
    if (!sign) return base;

    intent.signature = wrapKeySignature(await signer.signDigest(digest), keyHash);
    const data = executeCalldata(intent, suffix);
    // What Celo's verifyTx reads: the tag as the last bytes of the outer calldata.
    if (suffix && !fromDataSuffix(data)?.codes.includes(ATTRIBUTION_CODE)) {
      throw new DirectSubmitError("The outer calldata does not end with the project's attribution tag; refusing to send.", "unknown", "no");
    }

    // Preflight: the exact transaction as an eth_call (signature, nonce, payment and calls checked for real).
    const res = await pub.call({ account: account.address, to: orchestrator, data });
    const preflightErr = decodeFunctionResult({ abi: orchestratorAbi, functionName: "execute", data: res.data ?? "0x" }) as Hex;
    const name = errName(preflightErr);
    return { ...base, data, preflightErr, ...(name ? { preflightErrName: name } : {}) };
  }

  async function execute(args: { session: SerializedSession; privateKey: Hex; calls: readonly Call[] }): Promise<ExecuteResult> {
    last = undefined;
    const p = await prepare(args, true);
    if (p.preflightErr !== ZERO_ERR) {
      const text = p.preflightErrName ?? p.preflightErr!;
      throw new DirectSubmitError(`The Orchestrator would refuse this intent: ${text}`, kindOfRevert(p.preflightErrName, text), "no", { err: p.preflightErr });
    }
    log("direct-prepared signed", { wallet: p.wallet, nonce: `0x${p.intent.nonce.toString(16)}`, fee: String(p.fee), reusedQuote: p.reusedQuote, relayDigestMatches: p.relayDigestMatches });
    const { result, outcome } = await sender.submit({ data: p.data!, digest: p.digest, wallet: p.wallet, nonce: p.intent.nonce });
    last = outcome;
    return result;
  }

  return {
    submitter: account.address,
    prepare,
    lastOutcome: () => last,
    execute,
    /** The relay's maximum fee for exactly these calls (what the wallet may pay), from a prepared intent that passed every check but the fee bound. Nothing is signed. */
    async quote(args) {
      const p = await prepare(args, false);
      return { fee: p.fee, feeToken: p.feeToken };
    },
  };
}
