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
 * taken from the relay's `wallet_prepareCalls` (see the doc for why; the
 * relay-prepared variant is `direct-prepared`, ./directPrepared.ts). The
 * wallet pays no fee (`paymentMaxAmount` = 0 is signed); the agent EOA pays
 * the gas in CELO.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import type { ExecuteResult, SerializedSession } from "@altananetwork/sdk";
import {
  ALTANA_ACCOUNT_IMPLEMENTATION,
  ALTANA_ORCHESTRATOR,
  ATTRIBUTION_SUFFIX,
  buildSessionIntent,
  DirectSubmitError,
  directLaneSeqKey,
  executeCalldata,
  intentDigest,
  ithacaAccountNonceAbi,
  orchestratorAbi,
  simulateExecuteCalldata,
  USDT,
  wrapKeySignature,
  type Call,
  type Intent,
} from "@autumn/core";
import { checkSessionOnAccount, createEoaSender, decodeRevert, errName, kindOfRevert, revertDataOf, ZERO_ERR, type IntentOutcome } from "./intentSubmit.js";
import type { SessionExecutor } from "./ports.js";
import { inProcessSendLock, type SendLock } from "./sendLock.js";

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
  /**
   * Serialises sends from the agent EOA (nonce read, broadcast, wait until the
   * RPC counts it). Default: one queue per EOA in this process. Production
   * passes `pgSendLock(pool)`, so overlapping ticks in different processes
   * sharing the EOA take turns.
   */
  sendLock?: SendLock;
  /** How long to wait inside the lock for the RPC to count a broadcast transaction, ms. Default 15 000. */
  nonceSettleMs?: number;
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

export type DirectOutcome = IntentOutcome;

const SIM_COMBINED_GAS = 3_000_000n;
/** combinedGas basis in the test-only forced mode when the simulation refused. */
const FORCED_FALLBACK_GAS = 600_000n;
const DUMMY_INNER_SIG = `0x${"11".repeat(64)}1b` as Hex;

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
  const sender = createEoaSender({
    pub, wallet, account, chain, orchestrator, goldBuyer,
    sendLock: opts.sendLock ?? inProcessSendLock,
    nonceSettleMs: opts.nonceSettleMs ?? 15_000,
    receiptTimeoutMs: opts.receiptTimeoutMs ?? 120_000,
    log,
    label: "direct submit",
  });

  async function prepare(
    { session, privateKey, calls }: { session: SerializedSession; privateKey: Hex; calls: readonly Call[] },
    sign = true,
  ): Promise<PreparedSubmission> {
    // Refusals found before signing. Normally thrown; the test-only forced mode records them and carries on.
    const refusals: string[] = [];
    const refuse = (e: DirectSubmitError) => {
      if (!opts.unsafeSkipPreflight) throw e;
      refusals.push(e.message);
    };
    const { signer, walletAddress, keyHash, now } = await checkSessionOnAccount(pub, { session, privateKey, orchestrator, implementation }, refuse);

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

  async function execute(args: { session: SerializedSession; privateKey: Hex; calls: readonly Call[] }): Promise<ExecuteResult> {
    last = undefined;
    const p = await prepare(args, true);
    if (p.preflightErr !== ZERO_ERR && !opts.unsafeSkipPreflight) {
      const text = p.preflightErrName ?? p.preflightErr;
      throw new DirectSubmitError(`The Orchestrator would refuse this intent: ${text}`, kindOfRevert(p.preflightErrName, text), "no", { err: p.preflightErr });
    }
    const { result, outcome } = await sender.submit({ data: p.data, digest: p.digest, wallet: p.wallet, nonce: p.intent.nonce });
    last = outcome;
    return result;
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
