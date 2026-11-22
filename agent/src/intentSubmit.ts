/**
 * What the two EOA submitters (`direct`, `direct-prepared`; docs/direct-submit.md)
 * share: reading an intent failure, checking the session key on the account
 * before signing, sending `Orchestrator.execute(bytes)` from the agent EOA
 * under its send lock, and deciding the outcome from the receipt.
 */
import {
  decodeErrorResult,
  getAddress,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { signerFromPrivateKey, type ExecuteResult, type SerializedSession } from "@altananetwork/sdk";
import {
  altanaAccountAbi,
  DirectSubmitError,
  goldBuyerAbi,
  intentErrorName,
  ithacaAccountErrorsAbi,
  orchestratorAbi,
  sessionKeyIds,
  type FailureKind,
} from "@autumn/core";
import { SendLockError, type SendLock } from "./sendLock.js";

export const ZERO_ERR = "0x00000000";

export function errName(selector: Hex): string | undefined {
  return selector === ZERO_ERR ? undefined : intentErrorName(selector);
}

/** What an intent failure means for the runner. Nothing has been sent when this is used. */
export function kindOfRevert(name: string | undefined, text: string): FailureKind {
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
export function revertDataOf(err: unknown): Hex | undefined {
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

export function decodeRevert(data: Hex | undefined): { name?: string; text: string; args?: readonly unknown[] } {
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

/**
 * Checks before anything is signed: the stored key is the plan's, the plan
 * has not expired, the wallet still runs the account implementation the
 * intent is built for, and the account itself (not the KeyStore, which
 * execution never consults) still holds the key as a non-admin key.
 *
 * `refuse` decides what a refusal does: the direct executor's test-only forced
 * mode records it and carries on; otherwise it throws.
 */
export async function checkSessionOnAccount(
  pub: PublicClient,
  args: { session: SerializedSession; privateKey: Hex; orchestrator: Address; implementation: Address },
  refuse: (e: DirectSubmitError) => void = (e) => {
    throw e;
  },
): Promise<{ signer: ReturnType<typeof signerFromPrivateKey>; walletAddress: Address; keyHash: Hex; keyAddress: Address; now: bigint }> {
  const { session, privateKey, orchestrator, implementation } = args;
  const signer = signerFromPrivateKey(privateKey);
  if (signer.publicKey.toLowerCase() !== session.publicKey.toLowerCase()) {
    throw new DirectSubmitError("The stored session key does not match the plan's session.", "call_not_permitted", "no");
  }
  const walletAddress = getAddress(session.walletAddress);
  const { keyHash, address: keyAddress } = sessionKeyIds(session.publicKey);
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
  return { signer, walletAddress, keyHash, keyAddress, now };
}

/** One send's chain facts (for the proof and logs). */
export type IntentOutcome = {
  txHash: Hex;
  status: "success" | "reverted";
  gasUsed: bigint;
  intentExecuted?: { incremented: boolean; err: Hex; errName?: string };
  bought?: { amountIn: bigint; out: bigint };
};

/** The intent's `IntentExecuted` and the wallet's `Bought` in a receipt. */
export function intentOutcome(
  receipt: TransactionReceipt,
  p: { wallet: Address; nonce: bigint; orchestrator: Address; goldBuyer: Address },
): IntentOutcome {
  const executed = parseEventLogs({ abi: orchestratorAbi, eventName: "IntentExecuted", logs: receipt.logs.filter((l) => getAddress(l.address) === p.orchestrator) })
    .find((l) => getAddress(l.args.eoa) === p.wallet && l.args.nonce === p.nonce);
  const bought = parseEventLogs({ abi: goldBuyerAbi, eventName: "Bought", logs: receipt.logs.filter((l) => getAddress(l.address) === p.goldBuyer) })
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

export type EoaSender = {
  /**
   * Estimates gas, checks the agent EOA's CELO, sends `data` to the
   * Orchestrator under the send lock and waits for the receipt. CONFIRMED only
   * when the wallet's `Bought` is in the receipt.
   */
  submit(p: { data: Hex; digest: Hex; wallet: Address; nonce: bigint }): Promise<{ result: ExecuteResult; outcome?: IntentOutcome }>;
};

export function createEoaSender(o: {
  pub: PublicClient;
  wallet: WalletClient;
  account: PrivateKeyAccount;
  chain: Chain;
  orchestrator: Address;
  goldBuyer: Address;
  sendLock: SendLock;
  nonceSettleMs: number;
  receiptTimeoutMs: number;
  log: (msg: string, data?: Record<string, unknown>) => void;
  /** Log label, e.g. "direct submit". */
  label: string;
}): EoaSender {
  const { pub, wallet, account, chain, orchestrator } = o;

  /**
   * Inside the send lock: the EOA's pending nonce, an explicit-nonce
   * broadcast, then a short wait until the RPC's pending count passes that
   * nonce, so the next holder (here or in another process) reads the next one.
   * If the RPC does not catch up in time, the lock is released anyway: the
   * worst case is the old behaviour (a nonce clash, which the runner reports
   * as ambiguous and settles from the chain).
   */
  async function broadcast(tx: { data: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex> {
    const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" }).catch((err: Error) => {
      throw new SendLockError(`Could not read the agent EOA's nonce: ${err.message.split("\n")[0]}`);
    });
    const hash = await wallet.sendTransaction({ account, chain, to: orchestrator, nonce, ...tx });
    const until = Date.now() + o.nonceSettleMs;
    while (Date.now() < until) {
      const seen = await pub.getTransactionCount({ address: account.address, blockTag: "pending" }).catch(() => nonce);
      if (seen > nonce) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return hash;
  }

  return {
    async submit(p) {
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

      let txHash: Hex;
      try {
        txHash = await o.sendLock(account.address, () =>
          broadcast({ data: p.data, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }),
        );
      } catch (err) {
        if (err instanceof SendLockError) throw new DirectSubmitError(err.message, "relay_failure", "no");
        // The node may or may not have accepted it: only the chain can say.
        throw new DirectSubmitError(`Sending the transaction failed: ${(err as Error).message.split("\n")[0]}`, "relay_failure", "unknown");
      }
      o.log(`${o.label} sent`, { txHash, wallet: p.wallet, nonce: `0x${p.nonce.toString(16)}` });

      let receipt: TransactionReceipt;
      try {
        receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: o.receiptTimeoutMs, pollingInterval: 1_000 });
      } catch {
        return { result: { callsId: p.digest, status: "PENDING", transactionHash: txHash } };
      }
      const outcome = intentOutcome(receipt, { wallet: p.wallet, nonce: p.nonce, orchestrator, goldBuyer: o.goldBuyer });
      o.log(`${o.label} mined`, { txHash, status: outcome.status, gasUsed: String(outcome.gasUsed), err: outcome.intentExecuted?.err, bought: Boolean(outcome.bought) });
      if (outcome.bought) return { result: { callsId: p.digest, status: "CONFIRMED", statusCode: 200, transactionHash: txHash }, outcome };
      // Landed without a purchase: the outer tx reverted, or the intent reported an error (calls reverted atomically).
      return { result: { callsId: p.digest, status: "FAILED", statusCode: 500, transactionHash: txHash }, outcome };
    },
  };
}
