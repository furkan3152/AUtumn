import { getAddress, type Address, type Hex } from "viem";
import type { CallPermission, SerializedSession, SessionPermissions, SpendPermission } from "@altananetwork/sdk";
import { USDT } from "./constants.js";

/** The selectors the session may call, and nothing else. */
export const APPROVE_SIGNATURE = "approve(address,uint256)";
export const BUY_SIGNATURE = "buy(uint256,uint256)";

/**
 * Default per-purchase allowance for the relay fee, which a session paying in
 * USD₮ draws from the same weekly cap. Altana reports about $0.005 per session
 * transaction on Celo mainnet; 0.05 USD₮ leaves 10x headroom. Explicit, so the
 * owner sees exactly what the cap covers.
 */
export const DEFAULT_FEE_ALLOWANCE_PER_BUY = 50_000n; // 0.05 USD₮

/** Smallest weekly amount accepted: below this, 6-decimal XAUt0 rounding and fees dominate. */
export const MIN_WEEKLY_AMOUNT = 1_000_000n; // 1 USD₮
/** Longest session a plan may grant. */
export const MAX_SESSION_SECS = 366 * 86_400;

export type Plan = {
  /** USD₮ (6-decimal base units) spent on gold each week. */
  amountPerWeek: bigint;
  /** Session expiry, unix seconds. */
  expiresAt: number;
  /** USD₮ base units reserved per purchase for the relay fee. Default DEFAULT_FEE_ALLOWANCE_PER_BUY. */
  feeAllowancePerBuy?: bigint;
  /**
   * Optional second rule: one extra purchase in a week when the price is at
   * least 2% below the plan's last purchase. The cap is sized for two
   * purchases when this is on, and only then.
   */
  dipBuy?: boolean;
};

export type SessionGrant = {
  permissions: SessionPermissions & {
    calls: readonly CallPermission[];
    spend: readonly SpendPermission[];
  };
  expiry: number;
  feeToken: Address;
  /** Purchases per week the cap is sized for (1, or 2 with dipBuy). */
  buysPerWeek: number;
  /** The weekly USD₮ cap, the same value as `permissions.spend[0].limit`. */
  weeklyCap: bigint;
  /** The part of the cap that is fee allowance. */
  feeAllowance: bigint;
};

export function buysPerWeek(plan: Pick<Plan, "dipBuy">): number {
  return plan.dipBuy ? 2 : 1;
}

export function feeAllowanceOf(plan: Pick<Plan, "feeAllowancePerBuy">): bigint {
  return plan.feeAllowancePerBuy ?? DEFAULT_FEE_ALLOWANCE_PER_BUY;
}

/** The USD₮ a single purchase may move: the plan amount plus its fee allowance. */
export function perBuyBudget(plan: Pick<Plan, "amountPerWeek" | "feeAllowancePerBuy">): bigint {
  return plan.amountPerWeek + feeAllowanceOf(plan);
}

export function validatePlan(plan: Plan, nowSecs: number): void {
  if (typeof plan.amountPerWeek !== "bigint" || plan.amountPerWeek < MIN_WEEKLY_AMOUNT) {
    throw new Error(`amountPerWeek must be at least ${MIN_WEEKLY_AMOUNT} base units (1 USD₮)`);
  }
  const fee = feeAllowanceOf(plan);
  if (fee < 0n || fee > plan.amountPerWeek / 10n) {
    throw new Error("feeAllowancePerBuy must be between 0 and 10% of amountPerWeek");
  }
  if (!Number.isInteger(plan.expiresAt) || plan.expiresAt <= nowSecs) {
    throw new Error("expiresAt must be a unix time in seconds in the future");
  }
  if (plan.expiresAt - nowSecs > MAX_SESSION_SECS) {
    throw new Error("expiresAt is more than a year away");
  }
}

/**
 * The exact grantSession parameters for a plan:
 * - spend: one weekly USD₮ cap = (amount + fee allowance) × purchases per week.
 *   Because USD₮ already has a cap, the SDK adds no separate daily fee cap,
 *   and relay fees come out of this cap (derisk RESULTS.md §3.4).
 * - calls: USD₮.approve and GoldBuyer.buy, nothing else.
 * - expiry, and feeToken USD₮.
 *
 * Pass the result as `{ ...grant.permissions, expiry, feeToken }` to
 * `client.grantSession` along with the wallet, admin passkey signer and
 * `sessionSignerFromPublicKey(publicKey)`.
 */
export function planToSessionGrant(plan: Plan, goldBuyer: Address, nowSecs: number): SessionGrant {
  validatePlan(plan, nowSecs);
  const n = buysPerWeek(plan);
  const feeAllowance = feeAllowanceOf(plan) * BigInt(n);
  const weeklyCap = plan.amountPerWeek * BigInt(n) + feeAllowance;
  return {
    permissions: {
      calls: [
        { to: USDT, signature: APPROVE_SIGNATURE },
        { to: getAddress(goldBuyer), signature: BUY_SIGNATURE },
      ],
      spend: [{ token: USDT, limit: weeklyCap, period: "week" }],
    },
    expiry: plan.expiresAt,
    feeToken: USDT,
    buysPerWeek: n,
    weeklyCap,
    feeAllowance,
  };
}

/** The serialized session the agent expects to hold for a plan, given the wallet and session key. */
export function expectedSerializedSession(grant: SessionGrant, walletAddress: Address, publicKey: Hex): SerializedSession {
  return {
    walletAddress: getAddress(walletAddress),
    publicKey: publicKey.toLowerCase() as Hex,
    permissions: {
      calls: grant.permissions.calls.map((c) => ({ ...c })),
      spend: grant.permissions.spend.map((s) => ({
        limit: s.limit.toString(),
        period: s.period,
        ...(s.token ? { token: s.token } : {}),
      })),
    },
    expiry: grant.expiry,
  };
}

/**
 * True when a serialized session (as the browser reports it after granting)
 * carries exactly the plan's permissions, expiry, wallet and key. The agent
 * refuses to act on anything else.
 */
export function sessionMatchesGrant(stored: SerializedSession, expected: SerializedSession): boolean {
  const norm = (s: SerializedSession) =>
    JSON.stringify({
      w: s.walletAddress.toLowerCase(),
      k: s.publicKey.toLowerCase(),
      e: s.expiry,
      c: (s.permissions.calls ?? []).map((c) => ({
        to: "to" in c ? c.to.toLowerCase() : null,
        sig: "signature" in c ? c.signature : null,
      })),
      s: (s.permissions.spend ?? []).map((x) => ({ l: x.limit, p: x.period, t: x.token?.toLowerCase() ?? null })),
    });
  return norm(stored) === norm(expected);
}
