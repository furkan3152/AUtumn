import type { Address, Hex } from "viem";
import type { SerializedSession } from "@altananetwork/sdk";

export type PlanStatus =
  /** Created, session key generated, waiting for the owner's browser to grant it. */
  | "pending_grant"
  /** Granted and confirmed onchain; the runner acts on it. */
  | "active"
  /** Revoked, expired, or stopped by the owner. Terminal. */
  | "stopped";

export type PlanRecord = {
  id: string;
  ownerId: string;
  walletAddress: Address;
  /** USD₮ base units per week. */
  amountPerWeek: bigint;
  /** USD₮ base units reserved per purchase for the relay fee. */
  feeAllowancePerBuy: bigint;
  /** Optional dip rule: one more purchase in a week at ≥2% below the last purchase price. */
  dipBuy: boolean;
  /** 0 = Monday … 6 = Sunday. */
  dayOfWeek: number;
  hourUtc: number;
  /** Session expiry, unix seconds. */
  expiresAt: number;
  status: PlanStatus;
  stoppedReason?: string;
  sessionPublicKey: Hex;
  /** The session as granted (no secret in it). Present once active. */
  session?: SerializedSession;
  createdAt: number;
};

/** AES-256-GCM ciphertext of a session private key. */
export type EncryptedKey = {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
};

/** "weekly" is the plan's purchase; "dip" the optional second one. */
export type AttemptSlot = "weekly" | "dip";

export type AttemptStatus =
  /** Claimed and being sent. A crash leaves it here: treated as unknown. */
  | "submitting"
  /** Sent, outcome not established. Resolved from the chain on a later tick. */
  | "ambiguous"
  /** The chain shows the purchase. */
  | "bought"
  /** The chain shows no purchase from it (refused, reverted, or never landed). */
  | "not_bought";

export type Attempt = {
  id: string;
  planId: string;
  /** Monday of the week, YYYY-MM-DD. */
  weekId: string;
  slot: AttemptSlot;
  status: AttemptStatus;
  /** Chain time the attempt started, unix seconds. */
  startedAt: number;
  amountIn: bigint;
  minOut: bigint;
  callsId?: Hex;
  txHash?: Hex;
  out?: bigint;
  reason?: string;
};

export type NewAttempt = Omit<Attempt, "id" | "status" | "callsId" | "txHash" | "out" | "reason">;

export type RunOutcome = "bought" | "skipped" | "failed" | "ambiguous" | "stopped";

export type RunLogEntry = {
  planId: string;
  weekId: string;
  /** Unix seconds (chain time). */
  at: number;
  outcome: RunOutcome;
  reason: string;
  txHash?: Hex;
  amountIn?: bigint;
  out?: bigint;
};
