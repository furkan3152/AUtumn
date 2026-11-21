import { randomUUID } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import type { SerializedSession } from "@altananetwork/sdk";
import {
  DEFAULT_FEE_ALLOWANCE_PER_BUY,
  expectedSerializedSession,
  planToSessionGrant,
  sessionLimitsMismatch,
  sessionMatchesGrant,
  type PlanPeriod,
  type SessionGrant,
} from "@autumn/core";
import { encryptSessionKey, generateSessionKey } from "./crypto.js";
import type { ChainReader } from "./ports.js";
import { grantForPlan } from "./runner.js";
import type { Storage } from "./storage/types.js";
import type { PlanRecord } from "./types.js";

export type CreatePlanInput = {
  walletAddress: Address;
  amountPerBuy: bigint;
  /** Default "week". */
  period?: PlanPeriod;
  expiresAt: number;
  dayOfWeek: number;
  hourUtc: number;
  dipBuy?: boolean;
  feeAllowancePerBuy?: bigint;
  createdBlock?: bigint;
};

/**
 * Server side of "start a plan": validates it, generates the session key pair,
 * stores the private key encrypted, and returns only what the browser needs to
 * grant: the session public key and the exact grant parameters. The browser
 * calls `client.grantSession({ wallet, signer: passkey, sessionSigner:
 * sessionSignerFromPublicKey(publicKey), permissions: grant.permissions,
 * expiry: grant.expiry, feeToken: grant.feeToken })`.
 */
export async function createPlan(
  deps: { storage: Storage; encryptionKey: Buffer; goldBuyer: Address; now: number },
  input: CreatePlanInput,
): Promise<{ plan: PlanRecord; sessionPublicKey: Hex; grant: SessionGrant }> {
  const feeAllowancePerBuy = input.feeAllowancePerBuy ?? DEFAULT_FEE_ALLOWANCE_PER_BUY;
  const period = input.period ?? "week";
  const grant = planToSessionGrant(
    { amountPerBuy: input.amountPerBuy, period, expiresAt: input.expiresAt, feeAllowancePerBuy, dipBuy: !!input.dipBuy },
    deps.goldBuyer,
    deps.now,
  );
  if (!Number.isInteger(input.dayOfWeek) || input.dayOfWeek < 0 || input.dayOfWeek > 6) throw new Error("dayOfWeek must be 0-6");
  if (!Number.isInteger(input.hourUtc) || input.hourUtc < 0 || input.hourUtc > 23) throw new Error("hourUtc must be 0-23");

  const { privateKey, publicKey } = generateSessionKey();
  // The plan id is the AES-GCM AAD, so the row id is fixed before encrypting.
  const planId = randomUUID();
  const enc = encryptSessionKey(privateKey, planId, deps.encryptionKey);
  const plan = await deps.storage.createPlan(
    {
      id: planId,
      walletAddress: getAddress(input.walletAddress),
      amountPerBuy: input.amountPerBuy,
      period,
      feeAllowancePerBuy,
      dipBuy: !!input.dipBuy,
      dayOfWeek: input.dayOfWeek,
      hourUtc: input.hourUtc,
      expiresAt: input.expiresAt,
      sessionPublicKey: publicKey,
      createdAt: deps.now,
      ...(input.createdBlock !== undefined ? { createdBlock: input.createdBlock } : {}),
    },
    enc,
  );
  return { plan, sessionPublicKey: publicKey, grant };
}

/** The grant a stored plan asks for (validated against `nowSecs`). */
export function grantOf(plan: PlanRecord, goldBuyer: Address, nowSecs: number): SessionGrant {
  return grantForPlan(plan, goldBuyer, nowSecs);
}

/** The serialized session the browser must report for a plan. */
export function expectedSessionOf(plan: PlanRecord, goldBuyer: Address, nowSecs: number): SerializedSession {
  return expectedSerializedSession(grantOf(plan, goldBuyer, nowSecs), plan.walletAddress, plan.sessionPublicKey);
}

/**
 * After the browser's grant confirmed: checks the reported session against the
 * plan, then against the chain (key active on the wallet's account and in the
 * KeyStore, allowlist, cap, period and expiry exactly as planned), and only
 * then activates the plan. The session key was generated here and its private
 * half never left the server, so a key that is active on this wallet with
 * these limits can only have been granted by the wallet's admin (its passkey).
 */
export async function confirmGrant(
  deps: { storage: Storage; chain: ChainReader; goldBuyer: Address },
  planId: string,
  reported: SerializedSession,
  grantTxHash?: Hex,
): Promise<PlanRecord> {
  const plan = await deps.storage.getPlan(planId);
  if (!plan) throw new Error("no such plan");
  if (plan.status !== "pending_grant") throw new Error("plan is not waiting for a grant");
  const state = await deps.chain.sessionState(plan.walletAddress, plan.sessionPublicKey);
  const grant = grantOf(plan, deps.goldBuyer, state.blockTimestamp);
  const expected = expectedSerializedSession(grant, plan.walletAddress, plan.sessionPublicKey);
  if (!sessionMatchesGrant(reported, expected)) throw new Error("the granted session does not match the plan");
  const mismatch = sessionLimitsMismatch(state, grant, deps.goldBuyer);
  if (mismatch) throw new Error(mismatch);
  await deps.storage.activatePlan(planId, expected, grantTxHash);
  return (await deps.storage.getPlan(planId))!;
}
