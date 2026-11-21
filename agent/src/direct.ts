/**
 * Plan B executor (docs/direct-submit.md): the agent's own EOA submits the
 * session-key-signed intent to the Altana Orchestrator, so the ERC-8021 tag
 * sits at the very end of the outer transaction's calldata, where Celo's
 * checker reads it.
 *
 * Opt-in only (`AUTUMN_SUBMITTER=direct`); the relay executor stays the
 * default. Implements the same `SessionExecutor` port, so the runner's checks,
 * attempt lock, rechecks and ambiguity hold apply unchanged. Success is decided
 * from the chain: the runner reads GoldBuyer's `Bought` event for the wallet;
 * this executor reports CONFIRMED only when that event is in the receipt.
 *
 * Route: the intent is built and signed locally (core/src/intent.ts), not
 * taken from the relay's `wallet_prepareCalls` (see the doc for why). The
 * wallet pays no fee (`paymentMaxAmount` = 0 is signed); the agent EOA pays
 * the gas in CELO.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeFunctionResult,
  getAddress,
  http,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { signerFromPrivateKey, type ExecuteResult, type SerializedSession } from "@altananetwork/sdk";
import {
  ALTANA_ACCOUNT_IMPLEMENTATION,
  ALTANA_ORCHESTRATOR,
  ATTRIBUTION_SUFFIX,
  altanaAccountAbi,
  buildSessionIntent,
  DirectSubmitError,
  directLaneSeqKey,
  executeCalldata,
  goldBuyerAbi,
  intentDigest,
  intentErrorName,
  ithacaAccountErrorsAbi,
  ithacaAccountNonceAbi,
  orchestratorAbi,
  sessionKeyIds,
  simulateExecuteCalldata,
  USDT,
  wrapKeySignature,
  type Call,
  type FailureKind,
  type Intent,
} from "@autumn/core";
import type { SessionExecutor } from "./ports.js";

export type DirectExecutorOptions = {
  rpcUrl: string;
  /** Private key of the agent EOA that sends and pays gas. Never logged. */
  submitterKey: Hex;
  goldBuyer: Address;
  chain?: Chain;
  orchestrator?: Address;
  accountImplementation?: Address;
  /**
   * Signed intent lifetime, seconds. Must stay below the runner's ambiguity
   * hold (1800 s), so "no purchase after the hold" is final. Default 600.
   */
  intentTtlSecs?: number;
  /** Receipt wait before reporting PENDING, ms. Default 120 000. */
  receiptTimeoutMs?: number;
  /** Suffix appended to the outer calldata. Default: the project's ERC-8021 tag. */
  suffix?: Hex | null;
  /** Test-only: send even when the preflight call says the intent fails, to show what the chain does. */
  unsafeSkipPreflight?: boolean;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

/** What one prepared submission is, for logs and the proof. */
export type PreparedSubmission = {
  wallet: Address;
  keyHash: Hex;
  intent: Intent;
  digest: Hex;
  /** Outer calldata: execute(abi.encode(intent)) ‖ ERC-8021 suffix. */
  data: Hex;
  /** Gas `simulateExecute` measured for the intent (signature check skipped there). */
  simulatedGas: bigint;
  /** The Orchestrator's answer to the exact transaction, as an eth_call (0x00000000 = success). */
  preflightErr: Hex;
  preflightErrName?: string;
  /** Refusals the test-only forced mode recorded instead of throwing (always empty otherwise). */
  refusals: string[];
};

export type DirectOutcome = {
  txHash: Hex;
  status: "success" | "reverted";
  gasUsed: bigint;
  intentExecuted?: { incremented: boolean; err: Hex; errName?: string };
  bought?: { amountIn: bigint; out: bigint };
};

const SIM_COMBINED_GAS = 3_000_000n;
/** combinedGas basis in the test-only forced mode when the simulation refused. */
const FORCED_FALLBACK_GAS = 600_000n;
const ZERO_ERR = "0x00000000";
const DUMMY_INNER_SIG = `0x${"11".repeat(64)}1b` as Hex;

function errName(selector: Hex): string | undefined {
  return selector === ZERO_ERR ? undefined : intentErrorName(selector);
}

/** What an intent failure means for the runner. Nothing has been sent when this is used. */
function kindOfRevert(name: string | undefined, text: string): FailureKind {
  if (/\bOLD\b/.test(text)) return "twap_unavailable";
  const n = name ?? "";
  if (/ExceededSpendLimit|NoSpendPermissions/.test(n + text)) return "cap_exceeded";
  if (/UnauthorizedCall|^Unauthorized$/.test(n) || /UnauthorizedCall/.test(text)) return "call_not_permitted";
  if (/KeyDoesNotExist|VerificationError/.test(n + text)) return "session_ended";
  if (/InvalidNonce|IntentExpired/.test(n + text)) return "relay_failure";
  if (/PaymentError|STF|transfer amount exceeds balance|insufficient/i.test(n + text)) return "insufficient_balance";
  return "unknown";
}

/** Revert data of a failed eth_call, wherever viem put it. */
function revertDataOf(err: unknown): Hex | undefined {
  let e: unknown = err;
  for (let i = 0; i < 8 && e; i++) {
    const x = e as { data?: unknown; cause?: unknown };
    if (typeof x.data === "string" && /^0x[0-9a-fA-F]*$/.test(x.data)) return x.data as Hex;
    if (x.data && typeof x.data === "object" && typeof (x.data as { data?: unknown }).data === "string") {
      return (x.data as { data: Hex }).data;
    }
    e = x.cause;
  }
  return undefined;
}

function decodeRevert(data: Hex | undefined): { name?: string; text: string; args?: readonly unknown[] } {
  if (!data || data === "0x") return { text: "" };
  try {
    const d = decodeErrorResult({ abi: [...orchestratorAbi, ...ithacaAccountErrorsAbi], data });
    return { name: d.errorName, text: `${d.errorName}(${(d.args ?? []).map(String).join(",")})`, args: d.args };
  } catch {
    try {
      const d = decodeErrorResult({ data });
      return { name: d.errorName, text: `${d.errorName}: ${(d.args ?? []).map(String).join(",")}`, args: d.args };
    } catch {
      return { text: data };
    }
  }
}

export type DirectExecutor = SessionExecutor & {
  readonly submitter: Address;
  prepare(args: { session: SerializedSession; privateKey: Hex; calls: readonly Call[] }, sign?: boolean): Promise<PreparedSubmission>;
  /** The last send's chain facts (for the proof and logs). */
  lastOutcome(): DirectOutcome | undefined;
};

export function createDirectExecutor(opts: DirectExecutorOptions): DirectExecutor {
  const chain = opts.chain ?? celo;
  const orchestrator = getAddress(opts.orchestrator ?? ALTANA_ORCHESTRATOR);
  const implementation = getAddress(opts.accountImplementation ?? ALTANA_ACCOUNT_IMPLEMENTATION);
  const goldBuyer = getAddress(opts.goldBuyer);
  const ttl = opts.intentTtlSecs ?? 600;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl >= 1800) throw new Error("intentTtlSecs must be between 60 and 1799 seconds");
  const suffix = opts.suffix === undefined ? ATTRIBUTION_SUFFIX : opts.suffix;
  const log = opts.log ?? (() => {});
  const account = privateKeyToAccount(opts.submitterKey);
  const transport = http(opts.rpcUrl, { retryCount: 0, timeout: 30_000 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const wallet = createWalletClient({ chain, transport, account });
  let last: DirectOutcome | undefined;
  /** One send at a time from this EOA in this process, so its transaction nonces never collide. */
  let sendLock: Promise<unknown> = Promise.resolve();

  async function prepare(
    { session, privateKey, calls }: { session: SerializedSession; privateKey: Hex; calls: readonly Call[] },
    sign = true,
  ): Promise<PreparedSubmission> {
    const signer = signerFromPrivateKey(privateKey);
    if (signer.publicKey.toLowerCase() !== session.publicKey.toLowerCase()) {
      throw new DirectSubmitError("The stored session key does not match the plan's session.", "call_not_permitted", "no");
    }
    const walletAddress = getAddress(session.walletAddress);
    const { keyHash } = sessionKeyIds(session.publicKey);
    const block = await pub.getBlock({ blockTag: "latest" });
    const now = block.timestamp;
    if (BigInt(session.expiry) <= now) {
      throw new DirectSubmitError("The agent's key has expired. Set up a new plan to continue.", "session_ended", "no");
    }

    // The wallet must still run the account implementation this intent is built for.
    const impl = await pub.readContract({ address: orchestrator, abi: orchestratorAbi, functionName: "accountImplementationOf", args: [walletAddress] });
    if (getAddress(impl) !== implementation) {
      throw new DirectSubmitError(`The wallet's account implementation is ${impl}, not ${implementation}; refusing to sign.`, "unknown", "no");
    }

    // Refusals found before signing. Normally thrown; the test-only forced mode records them and carries on.
    const refusals: string[] = [];
    const refuse = (e: DirectSubmitError) => {
      if (!opts.unsafeSkipPreflight) throw e;
      refusals.push(e.message);
    };

    // The account, not the KeyStore, is what accepts or refuses the key during execution.
    try {
      const key = await pub.readContract({ address: walletAddress, abi: altanaAccountAbi, functionName: "getKey", args: [keyHash] });
      if (key.isSuperAdmin) refuse(new DirectSubmitError("The session key is a super admin on the account; refusing to act with it.", "call_not_permitted", "no"));
      if (key.expiry !== 0 && BigInt(key.expiry) < now) {
        refuse(new DirectSubmitError("The agent's key has expired on the account.", "session_ended", "no"));
      }
    } catch (err) {
      if (err instanceof DirectSubmitError) throw err;
      const r = decodeRevert(revertDataOf(err));
      if (r.name !== "KeyDoesNotExist") {
        throw new DirectSubmitError(`Could not read the session key from the wallet: ${(err as Error).message.split("\n")[0]}`, "relay_failure", "no");
      }
      refuse(new DirectSubmitError("The agent's key is no longer on the wallet (revoked or expired).", "session_ended", "no"));
    }

    // Nonce on our own lane: the SDK's lane for this key is 0xa17a…, ours is 0xd1ec….
    const nonce = await pub.readContract({ address: walletAddress, abi: ithacaAccountNonceAbi, functionName: "getNonce", args: [directLaneSeqKey(keyHash)] });
    const expiry = now + BigInt(ttl);

    // 1. Gas: simulateExecute runs every step (signature check forced true) and reverts SimulationPassed(gUsed).
    const draft = buildSessionIntent({ wallet: walletAddress, calls, nonce, combinedGas: SIM_COMBINED_GAS, expiry, accountImplementation: implementation });
    draft.intent.signature = wrapKeySignature(DUMMY_INNER_SIG, keyHash);
    let simulatedGas = FORCED_FALLBACK_GAS;
    try {
      await pub.call({ account: account.address, to: orchestrator, data: simulateExecuteCalldata(draft.intent), gas: SIM_COMBINED_GAS * 2n });
      throw new DirectSubmitError("simulateExecute returned without reverting; refusing to send.", "unknown", "no");
    } catch (err) {
      if (err instanceof DirectSubmitError) throw err;
      const r = decodeRevert(revertDataOf(err));
      if (r.name === "SimulationPassed") {
        simulatedGas = r.args?.[0] as bigint;
      } else {
        const text = r.text || (err as Error).message.split("\n")[0]!;
        refuse(new DirectSubmitError(`The intent fails in simulation: ${text}`, kindOfRevert(r.name, text), "no", { revert: text }));
      }
    }
    // combinedGas is signed and caps the self-call; unused gas costs nothing (no payment). Generous on purpose.
    const combinedGas = (simulatedGas * 3n) / 2n + 50_000n;

    const built = buildSessionIntent({ wallet: walletAddress, calls, nonce, combinedGas, expiry, accountImplementation: implementation });
    const digest = intentDigest({ ...built.intent, calls }, { chainId: chain.id, orchestrator });
    built.intent.signature = sign
      ? wrapKeySignature(await signer.signDigest(digest), keyHash)
      : wrapKeySignature(DUMMY_INNER_SIG, keyHash);
    const data = executeCalldata(built.intent, suffix);

    // 2. Preflight: the exact transaction as an eth_call, in normal mode (signature checked for real).
    let preflightErr: Hex = ZERO_ERR;
    if (sign) {
      const res = await pub.call({ account: account.address, to: orchestrator, data });
      preflightErr = decodeFunctionResult({ abi: orchestratorAbi, functionName: "execute", data: res.data ?? "0x" }) as Hex;
    }
    const name = errName(preflightErr);
    return { wallet: walletAddress, keyHash, intent: built.intent, digest, data, simulatedGas, preflightErr, ...(name ? { preflightErrName: name } : {}), refusals };
  }

  function outcomeOf(receipt: TransactionReceipt, p: PreparedSubmission): DirectOutcome {
    const executed = parseEventLogs({ abi: orchestratorAbi, eventName: "IntentExecuted", logs: receipt.logs.filter((l) => getAddress(l.address) === orchestrator) })
      .find((l) => getAddress(l.args.eoa) === p.wallet && l.args.nonce === p.intent.nonce);
    const bought = parseEventLogs({ abi: goldBuyerAbi, eventName: "Bought", logs: receipt.logs.filter((l) => getAddress(l.address) === goldBuyer) })
      .find((l) => getAddress(l.args.buyer) === p.wallet);
    const name = executed ? errName(executed.args.err) : undefined;
    return {
      txHash: receipt.transactionHash,
      status: receipt.status,
      gasUsed: receipt.gasUsed,
      ...(executed ? { intentExecuted: { incremented: executed.args.incremented, err: executed.args.err, ...(name ? { errName: name } : {}) } } : {}),
      ...(bought ? { bought: { amountIn: bought.args.amountIn, out: bought.args.out } } : {}),
    };
  }

  async function execute(args: { session: SerializedSession; privateKey: Hex; calls: readonly Call[] }): Promise<ExecuteResult> {
    last = undefined;
    const p = await prepare(args, true);
    if (p.preflightErr !== ZERO_ERR && !opts.unsafeSkipPreflight) {
      const text = p.preflightErrName ?? p.preflightErr;
      throw new DirectSubmitError(`The Orchestrator would refuse this intent: ${text}`, kindOfRevert(p.preflightErrName, text), "no", { err: p.preflightErr });
    }

    // Gas and funds of the agent EOA, before anything is broadcast.
    let gas: bigint;
    try {
      gas = ((await pub.estimateGas({ account: account.address, to: orchestrator, data: p.data })) * 6n) / 5n;
    } catch (err) {
      throw new DirectSubmitError(`Gas estimation for the submission failed: ${(err as Error).message.split("\n")[0]}`, "relay_failure", "no");
    }
    const fees = await pub.estimateFeesPerGas();
    const balance = await pub.getBalance({ address: account.address });
    if (balance < gas * fees.maxFeePerGas) {
      throw new DirectSubmitError(
        `The agent's gas account ${account.address} holds ${balance} wei of CELO, less than the ${gas * fees.maxFeePerGas} this submission may need.`,
        "relay_failure",
        "no",
      );
    }

    const send = sendLock.then(() =>
      wallet.sendTransaction({ account, chain, to: orchestrator, data: p.data, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }),
    );
    sendLock = send.catch(() => undefined);
    let txHash: Hex;
    try {
      txHash = await send;
    } catch (err) {
      // The node may or may not have accepted it: only the chain can say.
      throw new DirectSubmitError(`Sending the transaction failed: ${(err as Error).message.split("\n")[0]}`, "relay_failure", "unknown");
    }
    log("direct submit sent", { txHash, wallet: p.wallet, nonce: `0x${p.intent.nonce.toString(16)}` });

    let receipt: TransactionReceipt;
    try {
      receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: opts.receiptTimeoutMs ?? 120_000, pollingInterval: 1_000 });
    } catch {
      return { callsId: p.digest, status: "PENDING", transactionHash: txHash };
    }
    last = outcomeOf(receipt, p);
    log("direct submit mined", { txHash, status: last.status, gasUsed: String(last.gasUsed), err: last.intentExecuted?.err, bought: Boolean(last.bought) });
    if (last.bought) return { callsId: p.digest, status: "CONFIRMED", statusCode: 200, transactionHash: txHash };
    // Landed without a purchase: the outer tx reverted, or the intent reported an error (calls reverted atomically).
    return { callsId: p.digest, status: "FAILED", statusCode: 500, transactionHash: txHash };
  }

  return {
    submitter: account.address,
    prepare,
    lastOutcome: () => last,
    execute,
    /** The wallet pays no relay fee on this path: the intent signs paymentMaxAmount = 0. Runs the simulation, so refusals surface before the runner claims a slot. */
    async quote(args) {
      await prepare(args, false);
      return { fee: 0n, feeToken: USDT };
    },
  };
}

