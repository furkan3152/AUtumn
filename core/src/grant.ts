import { getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import type { CallPermission, SerializedSession, SessionPermissions, SpendPermission } from "@altananetwork/sdk";
import { ALTANA_ORCHESTRATOR_BY_CHAIN, ANY_SELECTOR, CELO_CHAIN_ID, USDT } from "./constants.js";
import { isPlanPeriod, type PlanPeriod } from "./period.js";

/** The two calls a plan asks the session for. */
export const APPROVE_SIGNATURE = "approve(address,uint256)";
export const BUY_SIGNATURE = "buy(uint256,uint256)";

/** One `(target, selector)` entry of the account's allowlist (`canExecutePackedInfos`). */
export type AllowlistEntry = { target: Address; selector: Hex };

/**
 * The allowlist the account will really store for a plan's session key:
 * USD₮.approve, GoldBuyer.buy, and the Orchestrator with any selector.
 *
 * The third entry is not in what we ask for. Porto, under the Altana SDK,
 * appends `{to: orchestrator, selector: anySelector}` to every session key it
 * authorizes (porto 0.2.37 `src/viem/Key.ts` lines 1110-1115, orchestrator
 * from the relay's capabilities in `RelayActions.ts` lines 211-223). Every
 * live Celo session key we read carries it. It cannot move the wallet's funds
 * (docs/direct-submit.md, "The Orchestrator entry"), so it is accepted, but
 * only for the pinned Orchestrator of the chain.
 */
export function expectedOnchainAllowlist(goldBuyer: Address, chainId: number = CELO_CHAIN_ID): AllowlistEntry[] {
  const orchestrator = ALTANA_ORCHESTRATOR_BY_CHAIN[chainId];
  if (!orchestrator) throw new Error(`no Altana Orchestrator is pinned for chain ${chainId}`);
  return [
    { target: getAddress(USDT), selector: toFunctionSelector(APPROVE_SIGNATURE) },
    { target: getAddress(goldBuyer), selector: toFunctionSelector(BUY_SIGNATURE) },
    { target: getAddress(orchestrator), selector: ANY_SELECTOR },
  ];
}

/**
 * Default per-purchase allowance for the relay fee, which a session paying in
 * USD₮ draws from the same period cap. Altana reports about $0.005 per session
 * transaction on Celo mainnet; 0.05 USD₮ leaves 10x headroom. Explicit, so the
 * owner sees exactly what the cap covers.
 */
export const DEFAULT_FEE_ALLOWANCE_PER_BUY = 50_000n; // 0.05 USD₮

/** Smallest amount per purchase: below this, 6-decimal XAUt0 rounding and fees dominate. */
export const MIN_AMOUNT_PER_BUY = 1_000_000n; // 1 USD₮
/** Longest session a plan may grant. */
export const MAX_SESSION_SECS = 366 * 86_400;

export type Plan = {
  /** USD₮ (6-decimal base units) spent on gold in each scheduled purchase. */
  amountPerBuy: bigint;
  /** How often the plan buys, and the spend period the cap is metered over. Default "week". */
  period?: PlanPeriod;
  /** Session expiry, unix seconds. */
  expiresAt: number;
  /** USD₮ base units reserved per purchase for the relay fee. Default DEFAULT_FEE_ALLOWANCE_PER_BUY. */
  feeAllowancePerBuy?: bigint;
  /**
   * Optional second rule: one extra purchase in a period when the price is at
   * least 2% below the plan's last purchase in that period. The cap is sized
   * for two purchases when this is on, and only then.
   */
  dipBuy?: boolean;
};

export type SessionGrant = {
  /** What we ask `grantSession` for (and what the SDK's serialized session carries). */
  permissions: SessionPermissions & {
    calls: readonly CallPermission[];
    spend: readonly SpendPermission[];
  };
  expiry: number;
  feeToken: Address;
  period: PlanPeriod;
  /** Purchases per period the cap is sized for (1, or 2 with dipBuy). */
  buysPerPeriod: number;
  /** The USD₮ cap per period, the same value as `permissions.spend[0].limit`. */
  periodCap: bigint;
  /** The part of the cap that is fee allowance. */
  feeAllowance: bigint;
  /** The allowlist the account will store: `permissions.calls` plus the Orchestrator entry Porto adds. */
  onchainCalls: readonly AllowlistEntry[];
};

export function buysPerPeriod(plan: Pick<Plan, "dipBuy">): number {
  return plan.dipBuy ? 2 : 1;
}

export function periodOf(plan: Pick<Plan, "period">): PlanPeriod {
  return plan.period ?? "week";
}

export function feeAllowanceOf(plan: Pick<Plan, "feeAllowancePerBuy">): bigint {
  return plan.feeAllowancePerBuy ?? DEFAULT_FEE_ALLOWANCE_PER_BUY;
}

/** The USD₮ a single purchase may move: the plan amount plus its fee allowance. */
export function perBuyBudget(plan: Pick<Plan, "amountPerBuy" | "feeAllowancePerBuy">): bigint {
  return plan.amountPerBuy + feeAllowanceOf(plan);
}

export function validatePlan(plan: Plan, nowSecs: number): void {
  if (typeof plan.amountPerBuy !== "bigint" || plan.amountPerBuy < MIN_AMOUNT_PER_BUY) {
    throw new Error(`amountPerBuy must be at least ${MIN_AMOUNT_PER_BUY} base units (1 USD₮)`);
  }
  if (!isPlanPeriod(periodOf(plan))) throw new Error('period must be "day" or "week"');
  const fee = feeAllowanceOf(plan);
  if (fee < 0n || fee > plan.amountPerBuy / 10n) {
    throw new Error("feeAllowancePerBuy must be between 0 and 10% of amountPerBuy");
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
 * - spend: one USD₮ cap per period ("day" or "week") = (amount + fee
 *   allowance) × purchases per period. Because USD₮ already has a cap, the
 *   SDK adds no separate daily fee cap, and relay fees come out of this cap
 *   (derisk RESULTS.md §3.4).
 * - calls: USD₮.approve and GoldBuyer.buy, nothing else. Onchain the account
 *   also stores the Orchestrator entry Porto adds to every session key
 *   (`onchainCalls`, see expectedOnchainAllowlist).
 * - expiry, and feeToken USD₮.
 *
 * Pass the result as `{ ...grant.permissions, expiry, feeToken }` to
 * `client.grantSession` along with the wallet, admin passkey signer and
 * `sessionSignerFromPublicKey(publicKey)`.
 */
export function planToSessionGrant(plan: Plan, goldBuyer: Address, nowSecs: number): SessionGrant {
  validatePlan(plan, nowSecs);
  const period = periodOf(plan);
  const n = buysPerPeriod(plan);
  const feeAllowance = feeAllowanceOf(plan) * BigInt(n);
  const periodCap = plan.amountPerBuy * BigInt(n) + feeAllowance;
  return {
    permissions: {
      calls: [
        { to: USDT, signature: APPROVE_SIGNATURE },
        { to: getAddress(goldBuyer), signature: BUY_SIGNATURE },
      ],
      spend: [{ token: USDT, limit: periodCap, period }],
    },
    expiry: plan.expiresAt,
    feeToken: USDT,
    period,
    buysPerPeriod: n,
    periodCap,
    feeAllowance,
    onchainCalls: expectedOnchainAllowlist(goldBuyer),
  };
}

/**
 * The serialized session the agent expects to hold for a plan, given the
 * wallet and session key. This is the SDK's `serializeSession` shape, which
 * carries the permissions we asked for: Porto adds the Orchestrator entry
 * only when it builds the relay request (`Key.toRelay`), so it never appears
 * here. The account's real allowlist is `grant.onchainCalls`, and
 * sessionLimitsMismatch compares the chain against that.
 */
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
