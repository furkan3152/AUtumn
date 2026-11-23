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
  ALTANA_EXPLORER,
  USDT as USDT_TOKEN,
  maxSendable,
  DEFAULT_FEE_ALLOWANCE_PER_BUY,
  type SwapAsset,
  type SwapBalances,
  type SwapFees,
  PLAN_DURATION_SECS,
  PLAN_DURATION_WEEKS,
  PLAN_PRESETS_USDT,
  nextPeriodStart,
  type PlanPeriod,
  type SendAsset,
} from "@autumn/core";
import { otherDoors, publicConfig, type OtherDoor } from "./env";
import type { CreationMode, Discoverable } from "./passkey";

export { PasskeyError, isAndroid, type PasskeyFailureReason, type PasskeyStep, type Discoverable, type CreationMode } from "./passkey";
export { BackupCodeError, WrongDoorError, BACKUP_CODE_PREFIX } from "./backupCode";

export type { PlanPeriod, SendAsset, SwapAsset, SwapFees };
export { PLAN_DURATION_WEEKS, PLAN_PRESETS_USDT };

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
/** A wallet's page on Altana's Keystore explorer: its keys and their state. */
export const keystoreAccountUrl = (address: Address) => `${ALTANA_EXPLORER}/account/${address}`;
/** A key's page on Altana's Keystore explorer (key id = keccak256 of the public key). */
export const keystoreKeyUrl = (keyId: `0x${string}`) => `${ALTANA_EXPLORER}/key/${keyId}`;
/** An ERC-8004 agent's page on 8004scan (the URL the Altana SDK uses for Celo). */
export const agentScanUrl = (agentId: string) => `https://8004scan.io/agents/celo/${agentId}`;

/**
 * An action whose transaction may already be on its way: retrying it could pay twice, so the UI must offer only
 * "Check again" (`checkStop`, `resumePlan`, `checkSend`), which reads the chain and never sends. `ref` names the
 * transaction (Celoscan link) or the relay's call id when known.
 */
export class CheckAgainError extends Error {
  readonly name = "CheckAgainError";
  constructor(
    readonly action: "plan" | "stop" | "send" | "swap",
    message: string,
    readonly ref: { txHash?: TxHash; callsId?: string } = {},
  ) {
    super(message);
  }
}

export interface Wallet {
  address: Address;
  createdAt: Date;
  /** The wallet's passkey (its only admin). */
  passkey: WalletPasskey;
}

/**
 * Whether the passkey can be found again from the passkey alone.
 * - true: a discoverable passkey; "I already have an Autumn passkey" finds the wallet (on any device the passkey syncs to).
 * - false or "unknown" (the browser did not say): treat as device-bound. Only this browser's saved record, or the
 *   wallet backup code (`getBackupCode`), can name it again, and only on this device. The UI should ask the owner to
 *   save the backup code and keep small amounts.
 */
export interface WalletPasskey {
  discoverable: Discoverable;
}

/** What the wallet backup code is, in plain words, for the screen that shows it. */
export const BACKUP_CODE_TEXT =
  "This code lets Autumn find your passkey again on this device if the browser's data is cleared. It contains no private key and cannot move funds. It only works on the device that holds the passkey: if this device is reset or the passkey is deleted, the wallet cannot be used again. Keep small amounts, and use \"Send out\" to move funds to an address you control.";

/** The backup code for a synced (discoverable) passkey: a second way back in. */
export const BACKUP_CODE_SYNCED_TEXT =
  "Your passkey is saved to your account and syncs to your devices, so \"I already have an Autumn passkey\" finds this wallet. This code is a second way back in: it names your wallet and passkey, so Autumn can find them even if that lookup fails. It contains no private key and cannot move funds, and it only works together with your passkey.";

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
  /** The registration fee for one key now, with the same 10% headroom: what each later plan sends. */
  perKeyFeeCelo: bigint;
}

/** Prices for showing fees in dollars, read from Celo. */
export interface FeeFacts {
  /** USD₮ base units per 1 CELO (Celo's fee-currency directory). */
  usdtPerCelo: bigint;
  /** Estimated relay fee for one purchase, USD₮ base units (gas price × an assumed gas use). */
  relayFeeEstimate: bigint;
  observedAt: Date;
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
  /** One extra buy if the price is at least 2% below this period's purchase price. */
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
  /** True while the purchase history is still being read: nextPurchaseAt is not known yet (never show "due now"). */
  historyLoading: boolean;
  limits: Limits;
  /** Transaction that wrote the limits onchain, when known. */
  txHash?: TxHash;
  /** What anyone can check onchain about the agent's key. */
  proof: {
    /** The agent's session public key. */
    publicKey: `0x${string}`;
    /** KeyStore key id (keccak256 of the public key): its Keystore explorer page. */
    keyId: `0x${string}`;
    /** The account's key hash: getKey/spendInfos/canExecutePackedInfos take it. */
    keyHash: `0x${string}`;
    /**
     * The only calls the key may make, as the account stores them: USD₮.approve,
     * GoldBuyer.buy, and the Orchestrator entry Altana adds to every agent key.
     */
    calls: { label: string; contract: Address }[];
    /** One line on the Orchestrator entry, shown under the calls. */
    callsNote: string;
  };
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
  /**
   * The wallet's ERC-8004 agent identity, read from the Identity Registry; null when it could not be read. agentId is
   * set when it could be found. `lastError` is why the last registration attempt in this browser did not finish.
   */
  identity: { registered: boolean; agentId?: string; lastError?: string } | null;
  /** CELO price and fee estimates; null when they could not be read. */
  fees: FeeFacts | null;
  /**
   * An agent key this browser asked to grant that is live onchain but no
   * running plan uses (for example the tab closed mid-grant and the server
   * could not take it over). The owner should revoke it.
   */
  strayKey: { publicKey: `0x${string}`; reason: string } | null;
  /** Plain sentences about missing, stale or partial data. Empty when everything was read. */
  notices: string[];
}

/** Sending funds out of the wallet with the passkey. */
export interface SendRequest {
  asset: SendAsset;
  to: Address;
  /** Base units of the asset. */
  amount: bigint;
}

export interface SendQuote {
  /** The relay's maximum fee for this send, in `feeSymbol` base units. */
  fee: bigint;
  feeSymbol: "USD₮" | "CELO";
  /** CELO this transaction also carries: Altana's one-time registration on a wallet's first passkey transaction. */
  registrationCelo: bigint;
  /** The largest amount of the asset that can be sent, leaving the fee. */
  max: bigint;
}

export interface SendResult {
  txHash: TxHash;
  /** Balances read after the chain confirmed the transfer. */
  balances: Balances;
}

export interface AutumnClient {
  /** True only for the in-memory preview. The UI shows a "Preview data" ribbon. */
  readonly isPreview: boolean;
  getState(): Promise<AutumnState>;
  /** Called whenever state may have changed. Returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void;
  /**
   * Create the wallet with a passkey. Rejects with a `PasskeyError` (`reason` and a short plain `message`) when the
   * passkey prompt fails, is cancelled or passkeys are unsupported; other errors (relay, network) are plain Errors.
   * Afterwards `wallet.passkey.discoverable` says whether the owner must save the backup code.
   * `mode` "auto" (default) picks the request from the browser's capabilities; "device" always asks for a passkey on
   * this device behind its screen lock (device-bound, not discoverable unless the browser says otherwise).
   */
  createWallet(options?: { mode?: CreationMode }): Promise<Wallet>;
  /**
   * Find an existing wallet from a discoverable passkey saved on this device (works once the wallet has made a
   * transaction). Rejects with a `PasskeyError` when the prompt fails. Cannot find a device-bound
   * (non-discoverable) passkey: use `restoreFromBackupCode`.
   */
  restoreWallet(): Promise<Wallet>;
  /**
   * The wallet backup code for the wallet on this device (see `BACKUP_CODE_TEXT`). No prompt, nothing signed.
   * Rejects when there is no wallet.
   */
  getBackupCode(): Promise<string>;
  /**
   * Restore the wallet on this device from a backup code. Checks the code's format and checksum and that it is for
   * this app's passkey domain, checks that the code's passkey is the wallet's admin key (on Celo once the wallet has
   * transacted, otherwise in the Altana relay's record of the wallet's first transaction), then saves it and loads
   * the wallet. No passkey prompt. Rejects with a `BackupCodeError` for a malformed code and a plain Error otherwise.
   */
  restoreFromBackupCode(code: string): Promise<Wallet>;
  /**
   * Write the plan limits onchain and start the agent. First settles any grant this browser already sent: a key the
   * chain shows granted is started, never granted again. Rejects with CheckAgainError when a grant may be on its way.
   */
  confirmPlan(input: PlanInput): Promise<Plan>;
  /**
   * "Check again" after confirmPlan's CheckAgainError: reads the chain and starts a granted plan. Never grants or
   * pays. Resolves with the running plan, or null when no grant is waiting (confirming again is then safe); rejects
   * with CheckAgainError while one may still land.
   */
  resumePlan(): Promise<Plan | null>;
  /**
   * Revoke the agent onchain. Resolves once the chain shows the revoke. While one stop is in flight, a second call
   * returns the same promise. Rejects with CheckAgainError when the revoke was sent but Celo does not show it yet.
   */
  stopAgent(): Promise<{ txHash?: TxHash }>;
  /**
   * "Check again" after stopAgent's CheckAgainError: reads the chain, never sends. Resolves once the revoke shows;
   * rejects with CheckAgainError while it is pending, or with a plain Error (stopping again is then safe) when the
   * chain proves the first revoke failed.
   */
  checkStop(): Promise<{ txHash?: TxHash }>;
  /** Register the wallet's ERC-8004 agent identity (one passkey prompt), and confirm it by reading the registry. */
  registerIdentity(): Promise<{ agentId: string | null; txHash?: TxHash }>;
  /** Revoke `state.strayKey` onchain. Resolves once the chain shows it revoked. */
  revokeStrayKey(): Promise<{ txHash?: TxHash }>;
  /** What sending would cost, and the most that can be sent. Nothing is signed. `amount` defaults to the whole balance. */
  quoteSend(req: { asset: SendAsset; to?: Address; amount?: bigint }): Promise<SendQuote>;
  /**
   * Send funds out with the passkey. Resolves once the chain shows the transfer and balances are re-read. Rejects with
   * CheckAgainError (never "not sent") once the transfer may be on its way.
   */
  send(req: SendRequest): Promise<SendResult>;
  /** "Check again" after send's CheckAgainError: reads the transfer's status, never sends. */
  checkSend(req: SendRequest, ref: { txHash?: TxHash; callsId?: string }): Promise<SendResult>;
  /**
   * Quote converting `amount` of `from` into `to` (nothing is signed): the pool's quote checked against the reference
   * prices, the minimum, and the relay's fee in USD₮ and in CELO. Without `amount` a stand-in amount is quoted, for
   * the fees and Max. Rejects with SwapUnavailableError when a price cannot be read or checked, or is refused.
   */
  quoteSwap(req: { from: SwapAsset; to: SwapAsset; amount?: bigint }): Promise<SwapQuote>;
  /**
   * Convert with the passkey. Re-quotes first and refuses (nothing signed) when the price check fails or the pool now
   * gives less than `minOut`. Resolves once the chain shows the conversion and balances are re-read. Rejects with
   * CheckAgainError (never "not converted") once it may be on its way. A second call while one runs returns the same
   * promise.
   */
  swap(req: SwapRequest): Promise<SwapResult>;
  /** "Check again" after swap's CheckAgainError: reads the conversion's status, never sends. */
  checkSwap(req: SwapRequest, ref: { txHash?: TxHash; callsId?: string }): Promise<SwapResult>;
}

/* ---------- Converting between CELO, USD₮ and gold ---------- */

/**
 * Converting is not possible right now: a reference price or the pool's quote could not be read (`kind`
 * "unreadable"), the gold pool has no 30-minute average yet ("no-average"), or the price check refused the quote
 * ("price": the pool is off its reference, or the amount moves the pool's price too much, or is too small to
 * convert fairly). Nothing was signed or sent.
 */
export class SwapUnavailableError extends Error {
  readonly name = "SwapUnavailableError";
  constructor(
    readonly kind: "unreadable" | "no-average" | "price",
    message: string,
  ) {
    super(message);
  }
}

export interface SwapQuote {
  from: SwapAsset;
  to: SwapAsset;
  /** Base units of `from` quoted. When `probe` is true this is a stand-in amount (no amount entered yet): use the quote for its fees and Max only. */
  amountIn: bigint;
  probe: boolean;
  /** Base units of `to` the pool's quoter says the swap returns now. */
  expectedOut: bigint;
  /** The least the swap may return (the quote less 1%); below that it reverts and converts nothing. */
  minOut: bigint;
  /** Base units of `to` the amount is worth at the reference prices (Celo's CELO rate, the gold pool's 30-minute average). */
  referenceOut: bigint;
  /** How far the quote is below the reference, in basis points (negative: above). */
  belowReferenceBps: number;
  /** True when the swap goes through two pools, via USD₮ (CELO ↔ gold). */
  viaUsdt: boolean;
  /** The pools' fees in plain words: "0.01%", "0.3%" or "0.01% and 0.3%". */
  poolFees: string;
  /** The relay's maximum fee in each token it was quoted in (null: not quoted), and the CELO registration value. */
  fees: SwapFees;
  /** What Max keeps for the next plan when CELO is sold. */
  plan: { walletRegistered: boolean; perKeyFee: bigint };
  observedAt: Date;
}

export interface SwapRequest {
  from: SwapAsset;
  to: SwapAsset;
  /** Base units of `from` to convert. */
  amountIn: bigint;
  /** The least of `to` (base units) the owner accepted on the review screen. */
  minOut: bigint;
  /** The fee token shown on the review screen. */
  feeSymbol: "USD₮" | "CELO";
}

export interface SwapResult {
  txHash: TxHash;
  /** Base units of `to` the pool paid to the wallet. */
  received: bigint;
  /** What the router may still take of `from` after the swap (0 when the exact approval was used up). */
  allowanceLeft: bigint;
  /** Balances read after the chain confirmed the conversion. */
  balances: Balances;
}

/** How long a conversion quote is shown as current. After this the review asks for a new quote. */
export const SWAP_QUOTE_FRESH_MS = 60_000;

/** Names of the assets as the screens say them. */
export const SWAP_ASSET_LABEL: Record<SwapAsset, string> = { CELO: "CELO", USDT: "USD₮", XAUT0: "Gold" };

/** The pools a conversion uses, in one line for the screen. */
export function swapRouteText(from: SwapAsset, to: SwapAsset): string {
  const pools = new Set([from, to]);
  if (pools.has("CELO") && pools.has("XAUT0")) return "A swap via USD₮ through two Uniswap v3 pools on Celo: CELO/USD₮ (fee 0.01%) and USD₮/XAUt0 (fee 0.3%).";
  if (pools.has("XAUT0")) return "A swap on Uniswap v3's USD₮/XAUt0 pool on Celo (fee 0.3%).";
  return "A swap on Uniswap v3's CELO/USD₮ pool on Celo (fee 0.01%).";
}

/** Wallet balances in the shape the conversion rules take. */
export const swapBalances = (b: Pick<Balances, "celo" | "usdt" | "gold">): SwapBalances => ({ celo: b.celo, usdt: b.usdt, xaut0: b.gold });

/**
 * Whether the wallet holds CELO beyond what the next plan's registration needs (with the same 10% spare Max keeps):
 * the Add money screen then offers to convert some.
 */
export function hasSpareCelo(state: AutumnState): boolean {
  const b = state.balances;
  const r = state.registration;
  if (!b || !r) return false;
  return b.celo > r.nextGrantFeeCelo + r.perKeyFeeCelo / 10n;
}

/**
 * USD₮ the running plan's next scheduled purchase needs (its amount plus the per-purchase fee allowance), or null
 * when no plan is running: converting USD₮ below this warns that the agent will skip.
 */
export function usdtForNextPurchase(state: Pick<AutumnState, "plan" | "agent">): bigint | null {
  if (!state.plan || state.agent.kind !== "active") return null;
  return state.plan.amount + DEFAULT_FEE_ALLOWANCE_PER_BUY;
}

/* ---------- Plan rules shared by every implementation ---------- */

export const DIP_PERCENT = 2;
/** The dip rule, worded exactly as the agent applies it. */
export const DIP_RULE_TEXT = "one extra buy if the price is at least 2% below this period's purchase price";
/** Who holds what. */
export const CUSTODY_TEXT =
  "Autumn's server holds the agent's session key, encrypted. The chain limits what that key can do; your passkey is the only admin.";
/**
 * What the session key can do, as the account contract enforces it. The
 * relay fee is paid by the same key and is not restricted to a recipient,
 * so it is stated as bounded by the cap rather than as impossible.
 */
export const LIMITS_TEXT =
  "The agent's key can only call USD₮.approve and GoldBuyer.buy, plus Altana's Orchestrator, which Altana adds to every agent key and which cannot move funds. It pays relay fees in USD₮. Everything it spends, fees included, is bounded by the cap.";
/** The Orchestrator entry of the agent key's allowlist, in one line (docs/direct-submit.md, "The Orchestrator entry"). */
export const ORCHESTRATOR_ENTRY_TEXT =
  "Altana adds the Orchestrator entry to every agent key for its execution path. It cannot move your funds; spending stays within the cap.";
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

/** USD₮ to deposit to cover a whole plan: every scheduled buy plus its fee allowance (dip buys not included). */
export function suggestedDeposit(amount: bigint, period: PlanPeriod): bigint {
  return (amount + DEFAULT_FEE_ALLOWANCE_PER_BUY) * BigInt(periodsInPlan(period));
}

/**
 * The most of `asset` that can be sent from `balance` with this fee quote: computed from the balance shown now, so a
 * balance that changed since the quote changes it too.
 */
export function sendMax(asset: SendAsset, balance: bigint, quote: Pick<SendQuote, "fee" | "feeSymbol" | "registrationCelo">): bigint {
  return maxSendable(asset, balance, { fee: quote.fee, feeToken: quote.feeSymbol === "CELO" ? "0x0000000000000000000000000000000000000000" : USDT_TOKEN, extraNative: quote.registrationCelo });
}

/** Whether deposits are enough to choose a plan: some USD₮, and the CELO the grant's registration needs. */
export function isFunded(state: AutumnState): boolean {
  const b = state.balances;
  const r = state.registration;
  if (!b || !r) return false;
  return b.usdt > 0n && b.celo >= r.nextGrantFeeCelo;
}

/**
 * The other hosts this deployment serves as passkey domains, where wallets made there open. Browser only (call
 * after mount); empty when one host is configured, in the preview, or on the server.
 */
export function otherPasskeyDoors(): OtherDoor[] {
  if (typeof window === "undefined" || process.env.NEXT_PUBLIC_AUTUMN_PREVIEW === "1") return [];
  const cfg = publicConfig();
  return cfg.ok ? otherDoors(cfg.config, window.location) : [];
}
export type { OtherDoor };

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
