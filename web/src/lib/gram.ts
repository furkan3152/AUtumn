/**
 * Autumn data interface (files keep the working name "gram").
 *
 * The UI only talks to a `GramClient`. Amounts are integer base units
 * (bigint) of the token they belong to; never floats. Display formatting lives
 * in `format.ts`.
 *
 * Implementations:
 * - `gram.preview.ts`: in-memory preview, only when NEXT_PUBLIC_GRAM_PREVIEW=1.
 * - the real Altana / Celo implementation is added later behind this interface.
 */

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

/** One-time Altana registration that the wallet pays in CELO. */
export interface Registration {
  paid: boolean;
  /** Fee in wei (about 20 CELO). */
  feeCelo: bigint;
  txHash?: TxHash;
}

export interface GoldPrice {
  /** USD₮ base units per troy ounce of XAUt0. */
  usdtPerOunce: bigint;
  observedAt: Date;
}

/** What the owner chooses on the plan screen. */
export interface PlanInput {
  /** USD₮ base units bought every week. */
  weeklyAmount: bigint;
  /** Buy once more in the same week if gold drops 2% after the weekly buy. */
  buyTheDip: boolean;
}

/** The limits written onchain for the agent. */
export interface Limits {
  /** Maximum USD₮ the agent may spend per week (base units). */
  weeklyCap: bigint;
  /** USD₮ spent in the current week (base units). */
  spentThisWeek: bigint;
  /** When the current week's counter resets: the next Monday 00:00 UTC (calendar week). */
  weekEndsAt: Date;
  /** The only thing the agent may do: buy this asset, delivered to the owner's wallet. */
  allowedAsset: { symbol: "XAUt0"; address: Address };
  /** After this date the agent can no longer spend. */
  expiresAt: Date;
}

export interface Plan extends PlanInput {
  startedAt: Date;
  /** Next scheduled weekly buy, or null if none is scheduled. */
  nextPurchaseAt: Date | null;
  limits: Limits;
  /** Transaction that wrote the limits onchain. */
  txHash: TxHash;
}

export type AgentStatus =
  | { kind: "none" }
  | { kind: "active" }
  | { kind: "stopping"; txHash?: TxHash }
  | { kind: "stopped"; stoppedAt: Date; txHash: TxHash }
  | { kind: "expired"; expiredAt: Date };

export type RefusalReason = "weekly-cap" | "not-gold" | "expired" | "revoked";

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
      trigger: "weekly" | "dip";
      txHash: TxHash;
    }
  | {
      kind: "refused";
      id: string;
      at: Date;
      /** USD₮ the agent tried to spend (base units). */
      attempted: bigint;
      reason: RefusalReason;
      txHash?: TxHash;
    }
  | { kind: "plan-started"; id: string; at: Date; weeklyAmount: bigint; txHash: TxHash }
  | { kind: "registration"; id: string; at: Date; feeCelo: bigint; txHash: TxHash }
  | { kind: "stopped"; id: string; at: Date; txHash: TxHash };

export interface GramState {
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
}

export interface GramClient {
  /** True only for the in-memory preview. The UI shows a "Preview data" ribbon. */
  readonly isPreview: boolean;
  getState(): Promise<GramState>;
  /** Called whenever state may have changed. Returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void;
  /** Create the wallet with a passkey. */
  createWallet(): Promise<Wallet>;
  /** Write the plan limits onchain and start the agent. */
  confirmPlan(input: PlanInput): Promise<Plan>;
  /** Revoke the agent onchain. Resolves with the revoke transaction. */
  stopAgent(): Promise<{ txHash: TxHash }>;
}

/* ---------- Plan rules shared by every implementation ---------- */

export const PLAN_PRESETS_USDT = [1, 5, 10] as const;
export const PLAN_DURATION_WEEKS = 12;
export const DIP_PERCENT = 2;

export const WEEK_MS = 7 * 24 * 3600 * 1000;

/** The weekly limit is a calendar week that resets Monday 00:00 UTC. */
export function nextWeekResetUtc(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysToMonday = ((8 - d.getUTCDay()) % 7) || 7;
  return new Date(d.getTime() + daysToMonday * 24 * 3600 * 1000);
}

/** The limits that confirming this plan will write onchain (shown before confirming). */
export function draftLimits(input: PlanInput, now: Date) {
  return {
    weeklyCap: input.buyTheDip ? input.weeklyAmount * 2n : input.weeklyAmount,
    assetSymbol: "XAUt0" as const,
    weekEndsAt: nextWeekResetUtc(now),
    expiresAt: new Date(now.getTime() + PLAN_DURATION_WEEKS * WEEK_MS),
  };
}

/** Whether deposits are enough to choose a plan. */
export function isFunded(state: GramState): boolean {
  const b = state.balances;
  const r = state.registration;
  if (!b || !r) return false;
  const feeCovered = r.paid || b.celo >= r.feeCelo;
  return b.usdt > 0n && feeCovered;
}

/** Returns the client for this build, or null when no wallet connection is configured. */
export async function loadGramClient(): Promise<GramClient | null> {
  if (process.env.NEXT_PUBLIC_GRAM_PREVIEW === "1") {
    const { createPreviewClient } = await import("./gram.preview");
    return createPreviewClient();
  }
  return null;
}
