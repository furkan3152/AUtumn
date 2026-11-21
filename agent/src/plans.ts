import { randomUUID } from "node:crypto";
import { getAddress, type Address } from "viem";
import type { SerializedSession } from "@altananetwork/sdk";
import {
  DEFAULT_FEE_ALLOWANCE_PER_BUY,
  expectedSerializedSession,
  planToSessionGrant,
  sessionMatchesGrant,
  type SessionGrant,
} from "@autumn/core";
import { encryptSessionKey, generateSessionKey } from "./crypto.js";
import type { ChainReader } from "./ports.js";
import type { Storage } from "./storage/types.js";
import type { PlanRecord } from "./types.js";

export type CreatePlanInput = {
  walletAddress: Address;
  amountPerWeek: bigint;
  expiresAt: number;
  dayOfWeek: number;
  hourUtc: number;
  dipBuy?: boolean;
  feeAllowancePerBuy?: bigint;
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
): Promise<{ plan: PlanRecord; sessionPublicKey: `0x${string}`; grant: SessionGrant }> {
  const feeAllowancePerBuy = input.feeAllowancePerBuy ?? DEFAULT_FEE_ALLOWANCE_PER_BUY;
  const grant = planToSessionGrant(
    { amountPerWeek: input.amountPerWeek, expiresAt: input.expiresAt, feeAllowancePerBuy, dipBuy: !!input.dipBuy },
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
      walletAddress: getAddress(input.walletAddress),
      amountPerWeek: input.amountPerWeek,
      feeAllowancePerBuy,
      dipBuy: !!input.dipBuy,
      dayOfWeek: input.dayOfWeek,
      hourUtc: input.hourUtc,
      expiresAt: input.expiresAt,
      sessionPublicKey: publicKey,
      createdAt: deps.now,
      id: planId,
    },
    enc,
  );
  return { plan, sessionPublicKey: publicKey, grant };
}

/**
 * After the browser's grant confirmed: checks the reported session against the
 * plan, then against the chain (key active, allowlist and cap exactly as
 * planned), and only then activates the plan.
 */
export async function confirmGrant(
  deps: { storage: Storage; chain: ChainReader; goldBuyer: Address },
  planId: string,
  reported: SerializedSession,
): Promise<PlanRecord> {
  const plan = await deps.storage.getPlan(planId);
  if (!plan) throw new Error("no such plan");
  if (plan.status !== "pending_grant") throw new Error("plan is not waiting for a grant");
  const state = await deps.chain.sessionState(plan.walletAddress, plan.sessionPublicKey);
  const grant = planToSessionGrant(
    { amountPerWeek: plan.amountPerWeek, expiresAt: plan.expiresAt, feeAllowancePerBuy: plan.feeAllowancePerBuy, dipBuy: plan.dipBuy },
    deps.goldBuyer,
    state.blockTimestamp,
  );
  const expected = expectedSerializedSession(grant, plan.walletAddress, plan.sessionPublicKey);
  if (!sessionMatchesGrant(reported, expected)) throw new Error("the granted session does not match the plan");
  if (state.status !== "active") throw new Error(`the session is not active onchain (${state.status})`);
  if (state.usdtWeekly?.limit !== grant.weeklyCap) throw new Error("the onchain weekly cap does not match the plan");
  if (state.allowedCalls.length !== 2) throw new Error("the onchain allowlist does not match the plan");
  await deps.storage.activatePlan(planId, expected);
  return (await deps.storage.getPlan(planId))!;
}
