import type { Address, Hex } from "viem";
import type { SerializedSession } from "@altananetwork/sdk";
import type { Attempt, AttemptSlot, AttemptStatus, EncryptedKey, NewAttempt, PlanRecord, RunLogEntry } from "../types.js";

/** A plan to insert. The id is chosen by the caller: it is the AAD of the encrypted session key. */
export type NewPlan = Omit<PlanRecord, "status" | "stoppedReason" | "session" | "ownerId" | "grantTxHash" | "stopTxHash" | "stoppedAt">;

/**
 * Everything the runner and the plan service persist. The database is a
 * cache of intent and a log: purchase decisions are taken from the chain.
 */
export interface Storage {
  /** Owner id for a wallet, creating the owner if new. */
  upsertOwner(walletAddress: Address): Promise<string>;
  /** Creates a plan in `pending_grant` with its encrypted session key, atomically. */
  createPlan(plan: NewPlan, key: EncryptedKey): Promise<PlanRecord>;
  getPlan(planId: string): Promise<PlanRecord | null>;
  listActivePlans(): Promise<PlanRecord[]>;
  /** Every plan of a wallet, newest first. */
  listPlansForWallet(walletAddress: Address): Promise<PlanRecord[]>;
  /** Plans of a wallet still waiting for a grant, created at or after `since` (unix seconds). */
  countPendingPlans(walletAddress: Address, since: number): Promise<number>;
  /** pending_grant → active, storing the granted session and its grant transaction. */
  activatePlan(planId: string, session: SerializedSession, grantTxHash?: Hex): Promise<void>;
  /** → stopped. `at` is chain time; `txHash` the owner's revoke, when known. */
  stopPlan(planId: string, reason: string, at?: number, txHash?: Hex): Promise<void>;
  getEncryptedSessionKey(planId: string): Promise<EncryptedKey | null>;

  /**
   * Atomically claims a purchase slot. Returns null when an attempt for the
   * same plan, week and slot is already open (submitting, ambiguous) or bought.
   * This is the lock that keeps two concurrent ticks from both sending.
   */
  claimAttempt(a: NewAttempt): Promise<Attempt | null>;
  updateAttempt(id: string, patch: Partial<Pick<Attempt, "status" | "callsId" | "txHash" | "out" | "reason">>): Promise<void>;
  /** Attempts still in `submitting` or `ambiguous`, any week. */
  openAttempts(planId: string): Promise<Attempt[]>;
  countAttempts(planId: string, periodId: string, slot: AttemptSlot, status: AttemptStatus): Promise<number>;
  /** Tx hashes already credited to an attempt of this plan, so one purchase is never credited twice. */
  creditedTxHashes(planId: string): Promise<Set<string>>;

  appendRunLog(entry: RunLogEntry): Promise<void>;
  lastRunLog(planId: string): Promise<RunLogEntry | null>;
  /** The newest run-log entries of these plans, newest first. */
  listRunLog(planIds: readonly string[], limit: number): Promise<RunLogEntry[]>;
}
