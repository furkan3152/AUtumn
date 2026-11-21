/**
 * Autumn data interface.
 *
 * The UI only talks to an `AutumnClient`. Amounts are integer base units
 * (bigint) of the token they belong to; never floats. Display formatting lives
 * in `format.ts`.
 *
 * Implementations:
 * - `autumn.preview.ts`: in-memory preview, only when NEXT_PUBLIC_AUTUMN_PREVIEW=1.
 * - `autumn.live.ts`: the Altana passkey wallet, Celo mainnet reads and the
 *   Autumn server, when the public settings in `env.ts` are present.
 */
import {
  DEFAULT_FEE_ALLOWANCE_PER_BUY,
  PLAN_DURATION_SECS,
  PLAN_DURATION_WEEKS,
  nextPeriodStart,
  type PlanPeriod,
} from "@autumn/core";
import { publicConfig } from "./env";

export type { PlanPeriod };
export { PLAN_DURATION_WEEKS };

export type Address = `0x${string}`;
export type TxHash = `0x${string}`;

/** Token decimals on Celo mainnet. */
export const DECIMALS = {
  USDT: 6, // USD₮
  XAUT0: 6, // Tether Gold, 1 unit = 1 troy ounce
  CELO: 18,
} as const;

export const GRAMS_PER_TROY_OUNCE = 31.1034768;

export const CELO_EXPLORER = "https://celoscan.io";
export const txUrl = (hash: TxHash) => `${CELO_EXPLORER}/tx/${hash}`;
export const addressUrl = (address: Address) => `${CELO_EXPLORER}/address/${address}`;

export interface Wallet {
  address: Address;
  createdAt: Date;
}

export interface Balances {
  /** USD₮ in base units (6 decimals). */
  usdt: bigint;
  /** XAUt0 in base units (6 decimals, troy ounces). */
  gold: bigint;
  /** CELO in wei. */
  celo: bigint;
  observedAt: Date;
}

/** Altana KeyStore registration, paid in CELO with each grant. */
export interface Registration {
  /** The wallet's own key (the passkey) is registered: its first grant has landed. */
  walletRegistered: boolean;
  /**
   * CELO the next plan's grant sends for registration: the agent's new key,
   * plus the wallet's key on the first grant, each with 10% headroom that the
   * KeyStore refunds.
   */
  nextGrantFeeCelo: bigint;
}

export interface GoldPrice {
  /** USD₮ base units per troy ounce of XAUt0 (pool mid price). */
  usdtPerOunce: bigint;
  observedAt: Date;
  /**
   * Whether the pool can report the 30-minute average price GoldBuyer checks
   * every purchase against. False: a purchase now would be refused, and the
   * agent retries later. null: unknown.
   */
  priceCheckAvailable: boolean | null;
}

/** What the owner chooses on the plan screen. */
export interface PlanInput {
  /** USD₮ base units bought in each scheduled purchase. */
  amount: bigint;
  /** How often: every week (default) or every day. */
  period: PlanPeriod;
  /** Buy once more in the same period if gold drops 2% after that period's buy. */
  buyTheDip: boolean;
  /** The plan's end, exactly as shown on the plan screen. */
  expiresAt: Date;
}

/** The limits written onchain for the agent. */
export interface Limits {
  period: PlanPeriod;
  /** Maximum USD₮ the agent may spend per period (base units), relay fees included. */
  cap: bigint;
  /** USD₮ spent in the current period (base units); null when the chain no longer holds the key. */
  spent: bigint | null;
  /** When the current period's counter resets: 00:00 UTC (daily) or Monday 00:00 UTC (weekly). */
  resetsAt: Date;
  /** The only thing the agent may do: buy this asset, delivered to the owner's wallet. */
  allowedAsset: { symbol: "XAUt0"; address: Address };
  /** After this date the agent can no longer spend. */
  expiresAt: Date;
  /** When these limits were read from the chain; null when not read. */
  observedAt: Date | null;
}

export interface Plan {
  amount: bigint;
  period: PlanPeriod;
  buyTheDip: boolean;
  startedAt: Date;
  /** Next scheduled buy, or null if none is scheduled. In the past: due now, waiting for the agent's next run. */
  nextPurchaseAt: Date | null;
  limits: Limits;
  /** Transaction that wrote the limits onchain, when known. */
  txHash?: TxHash;
}

export type AgentStatus =
  | { kind: "none" }
  | { kind: "active" }
  | { kind: "stopping"; txHash?: TxHash }
  | { kind: "stopped"; stoppedAt: Date | null; txHash?: TxHash }
  | { kind: "expired"; expiredAt: Date };

export type RefusalReason = "cap" | "not-gold" | "expired" | "revoked";

export type ActivityItem =
  | {
      kind: "purchase";
      id: string;
      at: Date;
      /** USD₮ spent (base units). */
      spent: bigint;
      /** XAUt0 received (base units). */
      received: bigint;
      /** Execution price, USD₮ base units per troy ounce. */
      usdtPerOunce: bigint;
      trigger: "scheduled" | "dip";
      period: PlanPeriod;
      txHash: TxHash;
    }
  | {
      kind: "refused";
      id: string;
      at: Date;
      /** USD₮ the agent tried to spend (base units), when recorded. */
      attempted: bigint | null;
      reason: RefusalReason;
      txHash?: TxHash;
    }
  | {
      /** The agent did not buy this time; from the agent's run log. Without txHash nothing reached the chain. */
      kind: "skipped";
      id: string;
      at: Date;
      text: string;
      /** True when the agent will retry in the same period. */
      retries: boolean;
      /** Set when a transaction did reach the chain (it reverted). */
      txHash?: TxHash;
    }
  | { kind: "plan-started"; id: string; at: Date; amount: bigint; period: PlanPeriod; txHash?: TxHash }
  | { kind: "registration"; id: string; at: Date; txHash: TxHash }
  | { kind: "stopped"; id: string; at: Date; txHash?: TxHash };

export interface AutumnState {
  /** null until the owner creates a wallet. */
  wallet: Wallet | null;
  balances: Balances | null;
  registration: Registration | null;
  price: GoldPrice | null;
  /** The current or most recent plan. */
  plan: Plan | null;
  agent: AgentStatus;
  /** Newest first. */
  activity: ActivityItem[];
  /** The wallet's ERC-8004 agent identity, when known. */
  identity: { registered: boolean } | null;
  /** Plain sentences about missing, stale or partial data. Empty when everything was read. */
  notices: string[];
}

export interface AutumnClient {
  /** True only for the in-memory preview. The UI shows a "Preview data" ribbon. */
  readonly isPreview: boolean;
  getState(): Promise<AutumnState>;
  /** Called whenever state may have changed. Returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void;
  /** Create the wallet with a passkey. */
  createWallet(): Promise<Wallet>;
  /** Find an existing wallet from a passkey saved on this device (works once the wallet has made a transaction). */
  restoreWallet(): Promise<Wallet>;
  /** Write the plan limits onchain and start the agent. */
  confirmPlan(input: PlanInput): Promise<Plan>;
  /** Revoke the agent onchain. Resolves once the chain shows the revoke. */
  stopAgent(): Promise<{ txHash?: TxHash }>;
}

/* ---------- Plan rules shared by every implementation ---------- */

export const PLAN_PRESETS_USDT = [1, 5, 10] as const;
export const DIP_PERCENT = 2;
export const PLAN_PERIODS: readonly PlanPeriod[] = ["week", "day"];

export const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Purchases a plan's length holds: 12 weekly or 84 daily. */
export function periodsInPlan(period: PlanPeriod): number {
  return period === "day" ? PLAN_DURATION_WEEKS * 7 : PLAN_DURATION_WEEKS;
}

/** When the account's counter for `period` resets next: 00:00 UTC tomorrow, or next Monday 00:00 UTC. */
export function nextResetUtc(now: Date, period: PlanPeriod): Date {
  return new Date(nextPeriodStart(Math.floor(now.getTime() / 1000), period) * 1000);
}

/**
 * The limits that confirming this plan will write onchain (shown before
 * confirming). The same arithmetic as @autumn/core's planToSessionGrant: the
 * cap per period is (amount + 0.05 USD₮ fee allowance) × purchases per
 * period, and the end is 12 weeks from now.
 */
export function draftLimits(input: Pick<PlanInput, "amount" | "period" | "buyTheDip">, now: Date) {
  const buys = input.buyTheDip ? 2n : 1n;
  const nowSecs = Math.floor(now.getTime() / 1000);
  return {
    period: input.period,
    cap: (input.amount + DEFAULT_FEE_ALLOWANCE_PER_BUY) * buys,
    feeAllowance: DEFAULT_FEE_ALLOWANCE_PER_BUY * buys,
    assetSymbol: "XAUt0" as const,
    resetsAt: nextResetUtc(now, input.period),
    expiresAt: new Date((nowSecs + PLAN_DURATION_SECS) * 1000),
  };
}

/** Whether deposits are enough to choose a plan: some USD₮, and the CELO the grant's registration needs. */
export function isFunded(state: AutumnState): boolean {
  const b = state.balances;
  const r = state.registration;
  if (!b || !r) return false;
  return b.usdt > 0n && b.celo >= r.nextGrantFeeCelo;
}

/** Returns the client for this build, or null when no wallet connection is configured. */
export async function loadAutumnClient(): Promise<AutumnClient | null> {
  if (process.env.NEXT_PUBLIC_AUTUMN_PREVIEW === "1") {
    const { createPreviewClient } = await import("./autumn.preview");
    return createPreviewClient();
  }
  const cfg = publicConfig();
  if (!cfg.ok) return null;
  const { createLiveClient } = await import("./autumn.live");
  return createLiveClient(cfg.config);
}
