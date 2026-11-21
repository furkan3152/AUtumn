import type { Address, Hex } from "viem";
import type { ExecuteResult, SerializedSession } from "@altananetwork/sdk";
import type { Balances, BuyQuote, Call, Purchase, SessionState } from "@autumn/core";

/** What the runner reads from the chain. Production: `createChainReader` (viem + @autumn/core readers). */
export interface ChainReader {
  /** Latest block: the runner's clock is chain time, the same clock the account meters spend by. */
  head(): Promise<{ number: bigint; timestamp: number }>;
  sessionState(wallet: Address, publicKey: Hex): Promise<SessionState>;
  balances(wallet: Address): Promise<Balances>;
  /** Every GoldBuyer purchase (all buyers) in the calendar week containing `at`. */
  purchasesInWeek(at: number): Promise<Purchase[]>;
  /** Purchases a transaction emitted; null when there is no receipt (yet). */
  purchasesInTx(txHash: Hex): Promise<Purchase[] | null>;
  quote(amountIn: bigint): Promise<BuyQuote>;
}

/** Sends a batch with a session key. Production: `createAltanaExecutor` (Altana SDK). */
export interface SessionExecutor {
  execute(args: { session: SerializedSession; privateKey: Hex; calls: readonly Call[] }): Promise<ExecuteResult>;
}
