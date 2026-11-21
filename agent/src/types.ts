import type { Address, Hex } from "viem";
import type { SerializedSession } from "@altananetwork/sdk";
import type { PlanPeriod } from "@autumn/core";

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
  /** USD₮ base units spent in each scheduled purchase. */
  amountPerBuy: bigint;
  /** "week" (default) or "day": how often it buys, and the period the onchain cap is metered over. */
  period: PlanPeriod;
  /** USD₮ base units reserved per purchase for the relay fee. */
  feeAllowancePerBuy: bigint;
  /** Optional dip rule: one more purchase in a period at ≥2% below that period's last purchase price. */
  dipBuy: boolean;
  /** 0 = Monday … 6 = Sunday. Weekly plans only; daily plans ignore it. */
  dayOfWeek: number;
  hourUtc: number;
  /** Session expiry, unix seconds. */
  expiresAt: number;
  status: PlanStatus;
  stoppedReason?: string;
  sessionPublicKey: Hex;
  /** The session as granted (no secret in it). Present once active. */
  session?: SerializedSession;
  /** Chain time the plan was created, unix seconds. */
  createdAt: number;
  /** Chain block at creation: purchase history for the plan starts here. */
  createdBlock?: bigint;
  /** The grant transaction, checked against its receipt at activation. */
  grantTxHash?: Hex;
  /** The revoke transaction the owner reported, after the chain showed the session revoked. */
  stopTxHash?: Hex;
  /** Chain time the plan was stopped, unix seconds. */
  stoppedAt?: number;
};

/** AES-256-GCM ciphertext of a session private key. */
export type EncryptedKey = {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
};

/** "weekly" is the plan's scheduled purchase in its period (day or week; the name is historical); "dip" the optional second one. */
export type AttemptSlot = "weekly" | "dip";

export type AttemptStatus =
  /** Claimed and being sent. A crash leaves it here: treated as unknown. */
  | "submitting"
  /** Sent, outcome not established. Resolved from the chain on a later tick. */
  | "ambiguous"
  /** The chain shows the purchase. */
  | "bought"
  /** The chain shows no purchase from it (refused, reverted, or never landed). Counts toward the failure limit. */
  | "not_bought"
  /** Refused before sending because the pool's price check was not available ("OLD"). Not a failure: retried later in the period. */
  | "deferred";

export type Attempt = {
  id: string;
  planId: string;
  /** First day of the plan's period (the Monday for weekly plans), YYYY-MM-DD. */
  periodId: string;
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

/**
 * Machine-readable reason for a run-log entry, so the app can word it without
 * parsing text. Failure kinds come from @autumn/core's explainAltanaError.
 */
export type RunLogKind =
  | "weekly"
  | "dip"
  | "cap_exceeded"
  | "call_not_permitted"
  | "session_ended"
  | "insufficient_balance"
  | "quote_expired"
  | "twap_unavailable"
  | "price_out_of_bound"
  | "relay_failure"
  | "reverted"
  | "limits_mismatch"
  | "too_many_failures"
  | "revoked"
  | "expired"
  | "unknown";

export type RunLogEntry = {
  planId: string;
  periodId: string;
  /** Unix seconds (chain time). */
  at: number;
  outcome: RunOutcome;
  reason: string;
  txHash?: Hex;
  amountIn?: bigint;
  out?: bigint;
  kind?: RunLogKind;
};
