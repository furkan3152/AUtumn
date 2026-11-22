/**
 * In-memory preview implementation of AutumnClient.
 * Loaded only when NEXT_PUBLIC_AUTUMN_PREVIEW=1. Nothing here touches a chain.
 *
 * Optional URL parameter `?preview=<scenario>` picks a starting point:
 *   fresh (default) | funded | active | empty | stopped | stray | error | loading
 *   | device-bound        a funded wallet whose passkey is device-bound (not discoverable): the UI should ask for the backup code
 *   | fresh-device-bound  no wallet yet; creating one makes a device-bound passkey
 *   | fresh-fallback      no wallet yet; the normal passkey request fails as "cancelled" (the phone only offered
 *                         another device) and "Use this phone's screen lock instead" (mode "device") succeeds
 *   | celo-only           a new wallet that received only CELO (250 CELO, no USD₮): "Convert CELO to USD₮" is offered
 *
 * createWallet({ mode: "device" }) always makes a device-bound passkey, as the live client does.
 *
 * Optional `&passkeyError=<reason>` makes createWallet and restoreWallet fail with that PasskeyError reason:
 *   cancelled | wrong-site | already-exists | interrupted | unsupported
 *
 * Optional `&swap=<case>` changes "Convert CELO to USD₮":
 *   unreadable  the reference rate cannot be read (converting unavailable)
 *   price       the pool quotes 5% below the reference rate (refused)
 *   moved       quotes work, but the price moves before signing (refused at "Convert with passkey")
 *   pending     the conversion is sent but not confirmed yet ("Check again")
 *
 * The preview's backup code is a real, checksummed code (with made-up passkey facts); restoreFromBackupCode
 * accepts it (or any valid code for this page's host) and refuses malformed ones exactly as the live client does.
 */
import { USDT as USDT_TOKEN, checkDestination, checkSwapAmount, maxSendable, swapPriceCheck, type SendAsset } from "@autumn/core";
import {
  DECIMALS,
  ORCHESTRATOR_ENTRY_TEXT,
  WEEK_MS,
  draftLimits,
  nextResetUtc,
  type ActivityItem,
  type Address,
  type AutumnClient,
  type AutumnState,
  type Plan,
  type PlanInput,
  type SendQuote,
  type SendRequest,
  type SwapQuote,
  type SwapRequest,
  type SwapResult,
  type TxHash,
  type Wallet,
  CheckAgainError,
  SwapUnavailableError,
  swapKeepAndMax,
} from "./autumn";
import { BackupCodeError, decodeBackupCode, encodeBackupCode } from "./backupCode";
import { passkeyFailure, type Discoverable, type PasskeyFailureReason } from "./passkey";

const USDT = 10n ** BigInt(DECIMALS.USDT);
const CELO = 10n ** BigInt(DECIMALS.CELO);
const OUNCE = 10n ** BigInt(DECIMALS.XAUT0);
const PREVIEW_ADDRESS: Address = "0x7a3f0c1e9b2d4a6f8e5c3b1a0d9e8f7c6b5a4d3e";
const PREVIEW_GOLD: Address = "0x9e1c0a2b3d4e5f60718293a4b5c6d7e8f9a0b1c2";
const FEE = 20n * CELO;
/** Preview figures: 0.0522 USD₮ per CELO and a 0.005 USD₮ relay fee, close to Celo mainnet on 2026-11-21. */
const PREVIEW_FEES = { usdtPerCelo: 52_214n, relayFeeEstimate: 19_000n };
const PREVIEW_KEY = `0x04${"5c".repeat(32)}${"a7".repeat(32)}` as const;
const PREVIEW_SEND_FEE = 6_000n; // 0.006 USD₮
/** The preview's reference rate as a fee-directory fraction: 0.052214 USD₮ per CELO. */
const PREVIEW_RATE = { numerator: PREVIEW_FEES.usdtPerCelo * 10n ** 12n, denominator: 10n ** 18n };
const PREVIEW_SWAP_FEE_CELO = CELO / 20n; // 0.05 CELO
/** Made-up passkey facts for the preview's backup code. */
const PREVIEW_CREDENTIAL_ID = "pVw3rQe1Zm9cT0bXyK7aHn2LdUo5sJ8gWfE4iC6vRkA";
const PREVIEW_PASSKEY_PUBLIC_KEY = `0x${"4b".repeat(32)}${"e2".repeat(32)}` as const;
const PASSKEY_ERROR_NAMES: Record<PasskeyFailureReason, string> = {
  cancelled: "NotAllowedError",
  "wrong-site": "SecurityError",
  "already-exists": "InvalidStateError",
  interrupted: "AbortError",
  unsupported: "NotSupportedError",
};

let counter = 0;
function fakeHash(): TxHash {
  counter += 1;
  let h = "";
  let seed = counter * 2654435761;
  for (let i = 0; i < 64; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    h += (seed >> 16).toString(16).slice(-1);
  }
  return `0x${h}`;
}

const balanceOf = (b: { usdt: bigint; gold: bigint; celo: bigint }, asset: SendAsset) =>
  asset === "USDT" ? b.usdt : asset === "XAUT0" ? b.gold : b.celo;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;

function goldFor(spent: bigint, usdtPerOunce: bigint) {
  return (spent * OUNCE) / usdtPerOunce;
}

function emptyState(): AutumnState {
  return {
    wallet: null,
    balances: null,
    registration: { walletRegistered: false, nextGrantFeeCelo: FEE, perKeyFeeCelo: FEE / 2n },
    price: { usdtPerOunce: 4126_400000n, observedAt: new Date(), priceCheckAvailable: true },
    plan: null,
    agent: { kind: "none" },
    activity: [],
    identity: null,
    fees: { ...PREVIEW_FEES, observedAt: new Date() },
    strayKey: null,
    notices: [],
  };
}

function makePlan(input: Omit<PlanInput, "expiresAt">, startedAt: Date, nextPurchaseAt: Date | null): Plan {
  const d = draftLimits(input, startedAt);
  return {
    amount: input.amount,
    period: input.period,
    buyTheDip: input.buyTheDip,
    startedAt,
    nextPurchaseAt,
    historyLoading: false,
    txHash: fakeHash(),
    proof: {
      publicKey: PREVIEW_KEY,
      keyId: `0x${"3e".repeat(32)}`,
      keyHash: `0x${"9b".repeat(32)}`,
      calls: [
        { label: "USD₮.approve", contract: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" },
        { label: "GoldBuyer.buy", contract: PREVIEW_GOLD },
        { label: "Altana Orchestrator (any function)", contract: "0xAF140d0416A994Aebb3fA6212B16CE6700f09751" },
      ],
      callsNote: ORCHESTRATOR_ENTRY_TEXT,
    },
    limits: {
      period: input.period,
      cap: d.cap,
      spent: 0n,
      resetsAt: nextResetUtc(new Date(), input.period),
      allowedAsset: { symbol: "XAUt0", address: PREVIEW_GOLD },
      expiresAt: d.expiresAt,
      observedAt: new Date(),
    },
  };
}

function scenario(name: string): AutumnState {
  const s = emptyState();
  if (name === "fresh" || name === "fresh-device-bound" || name === "fresh-fallback" || name === "error" || name === "loading") return s;
  const now = Date.now();
  s.wallet = { address: PREVIEW_ADDRESS, createdAt: new Date(now - 40 * DAY), passkey: { discoverable: name === "device-bound" ? false : true } };
  s.registration = { walletRegistered: false, nextGrantFeeCelo: FEE, perKeyFeeCelo: FEE / 2n };
  s.balances = { usdt: 50n * USDT, gold: 0n, celo: 20n * CELO + CELO / 2n, observedAt: new Date() };
  if (name === "funded" || name === "device-bound") return s;
  if (name === "celo-only") {
    s.balances = { usdt: 0n, gold: 0n, celo: 250n * CELO, observedAt: new Date() };
    return s;
  }

  const weekly = 5n * USDT;
  const start = name === "empty" ? new Date(now - 60_000) : new Date(now - 4 * WEEK_MS + 6000);
  s.registration = { walletRegistered: true, nextGrantFeeCelo: FEE / 2n, perKeyFeeCelo: FEE / 2n };
  const regTx = fakeHash();
  s.balances.celo = CELO / 2n;
  const firstNext = name === "empty" ? new Date(start.getTime() + WEEK_MS) : new Date(now + 6000);
  const plan = makePlan({ amount: weekly, period: "week", buyTheDip: true }, start, firstNext);
  s.plan = plan;
  s.agent = { kind: "active" };
  s.identity = { registered: true, agentId: "1287" };
  const items: ActivityItem[] = [
    { kind: "registration", id: "reg", at: new Date(start.getTime() - 120_000), txHash: regTx },
    { kind: "plan-started", id: "plan", at: start, amount: weekly, period: "week", txHash: plan.txHash },
  ];

  if (name !== "empty") {
    const prices = [4012_150000n, 4061_900000n, 3978_400000n, 4098_750000n];
    let gold = 0n;
    let spent = 0n;
    for (let w = 0; w < 4; w++) {
      const at = new Date(start.getTime() + w * WEEK_MS + 1000);
      const p = prices[w];
      const got = goldFor(weekly, p);
      gold += got;
      spent += weekly;
      items.push({ kind: "purchase", id: `p${w}`, at, spent: weekly, received: got, usdtPerOunce: p, trigger: "scheduled", period: "week", txHash: fakeHash() });
      if (w === 2) {
        const dipAt = new Date(at.getTime() + 2 * DAY);
        const dp = 3898_200000n;
        const dgot = goldFor(weekly, dp);
        gold += dgot;
        spent += weekly;
        items.push({ kind: "purchase", id: "dip2", at: dipAt, spent: weekly, received: dgot, usdtPerOunce: dp, trigger: "dip", period: "week", txHash: fakeHash() });
        items.push({ kind: "refused", id: "ref2", at: new Date(dipAt.getTime() + DAY), attempted: weekly, reason: "cap" });
        items.push({ kind: "skipped", id: "skip2", at: new Date(dipAt.getTime() + DAY / 2), text: "Price check not available right now, the agent will retry.", retries: true });
      }
    }
    s.balances.gold = gold;
    s.balances.usdt -= spent;
  }

  if (name === "stray") {
    s.strayKey = { publicKey: `0x04${"d1".repeat(64)}`, reason: "the Autumn server could not start a plan with it (another plan is still active for this wallet; stop it first)" };
  }

  if (name === "stopped") {
    const at = new Date(now - 3 * 3600 * 1000);
    const txHash = fakeHash();
    s.agent = { kind: "stopped", stoppedAt: at, txHash };
    plan.nextPurchaseAt = null;
    items.push({ kind: "stopped", id: "stop", at, txHash });
  }
  s.activity = items.sort((a, b) => b.at.getTime() - a.at.getTime());
  return s;
}

export function createPreviewClient(): AutumnClient {
  const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const name = params?.get("preview") ?? "fresh";
  let state = scenario(name);
  let failNext = name === "error";
  const passkeyError = params?.get("passkeyError") as PasskeyFailureReason | null;
  const createdDiscoverable: Discoverable = name === "fresh-device-bound" ? false : true;
  const rpId = typeof window === "undefined" ? "localhost" : window.location.hostname.toLowerCase();
  const failPasskey = (step: "create" | "find" | "sign") => {
    if (!passkeyError || !(passkeyError in PASSKEY_ERROR_NAMES)) return;
    throw passkeyFailure({ name: PASSKEY_ERROR_NAMES[passkeyError], message: "preview" }, step)!;
  };
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const emit = () => listeners.forEach((l) => l());
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
      emit();
    }, ms);
    timers.add(t);
  };

  const scheduleWeekly = () => {
    const plan = state.plan;
    if (!plan || !plan.nextPurchaseAt || state.agent.kind !== "active") return;
    const delay = plan.nextPurchaseAt.getTime() - Date.now();
    if (delay > 60_000) return; // only simulate purchases due soon
    later(Math.max(delay, 0), () => {
      if (state.agent.kind !== "active" || !state.plan || !state.balances || !state.price) return;
      const p = state.plan;
      const price = state.price.usdtPerOunce;
      const got = goldFor(p.amount, price);
      const at = new Date();
      state = {
        ...state,
        balances: { ...state.balances, usdt: state.balances.usdt - p.amount, gold: state.balances.gold + got, observedAt: at },
        plan: {
          ...p,
          nextPurchaseAt: new Date(at.getTime() + (p.period === "day" ? DAY : WEEK_MS)),
          limits: { ...p.limits, spent: (p.limits.spent ?? 0n) + p.amount, resetsAt: nextResetUtc(at, p.period), observedAt: at },
        },
        activity: [
          { kind: "purchase", id: `live${at.getTime()}`, at, spent: p.amount, received: got, usdtPerOunce: price, trigger: "scheduled", period: p.period, txHash: fakeHash() },
          ...state.activity,
        ],
      };
    });
  };

  const swapCase = params?.get("swap") ?? null;
  let swapFlight: Promise<SwapResult> | null = null;
  let swapMoved = swapCase === "moved";
  /** The preview pool: 0.01% under the reference rate, or 5% under it with `&swap=price`. */
  const previewPoolQuote = (amountIn: bigint) => {
    const ref = (amountIn * PREVIEW_RATE.numerator) / PREVIEW_RATE.denominator / 10n ** 12n;
    const out = swapCase === "price" ? (ref * 95n) / 100n : (ref * 9_999n) / 10_000n;
    return { out, check: swapPriceCheck(amountIn, out, PREVIEW_RATE) };
  };
  const settleSwap = (req: SwapRequest, txHash: TxHash) => {
    const b = state.balances!;
    const reg = state.registration!;
    const p = previewPoolQuote(req.amountIn);
    const fee = req.feeSymbol === "CELO" ? PREVIEW_SWAP_FEE_CELO : PREVIEW_SEND_FEE;
    const registrationCelo = reg.walletRegistered ? 0n : reg.perKeyFeeCelo;
    const at = new Date();
    const balances = {
      ...b,
      celo: b.celo - req.amountIn - registrationCelo - (req.feeSymbol === "CELO" ? fee : 0n),
      usdt: b.usdt + p.out - (req.feeSymbol === "USD₮" ? fee : 0n),
      observedAt: at,
    };
    state = {
      ...state,
      balances,
      registration: reg.walletRegistered ? reg : { walletRegistered: true, nextGrantFeeCelo: reg.perKeyFeeCelo, perKeyFeeCelo: reg.perKeyFeeCelo },
    };
    emit();
    return { txHash, received: p.out, allowanceLeft: 0n, balances };
  };
  async function doSwap(req: SwapRequest) {
    await wait(400);
    const b = state.balances!;
    const p = previewPoolQuote(req.amountIn);
    if (!p.check.ok) throw new SwapUnavailableError("price", `Converting is unavailable right now: ${p.check.reason}. Nothing was sent.`);
    if (swapMoved) {
      swapMoved = false; // once: reviewing again works
      throw new Error("The price moved: the pool now gives less than the minimum you reviewed. Nothing was sent. Review the new quote.");
    }
    const reg = state.registration!;
    const keep = swapKeepAndMax(b.celo, reg, {
      fee: req.feeSymbol === "CELO" ? PREVIEW_SWAP_FEE_CELO : PREVIEW_SEND_FEE,
      feeSymbol: req.feeSymbol,
      registrationCelo: reg.walletRegistered ? 0n : reg.perKeyFeeCelo,
    }).keep;
    const ok = checkSwapAmount(req.amountIn, b.celo, keep);
    if (!ok.ok) throw new Error(ok.problem);
    if (p.out < req.minOut) throw new Error("The price moved: the pool now gives less than the minimum you reviewed. Nothing was sent. Review the new quote.");
    await wait(2200);
    const txHash = fakeHash();
    if (swapCase === "pending") throw new CheckAgainError("swap", 'The relay accepted the conversion but has not confirmed it yet. Do not convert again: check the transaction on Celoscan, or tap "Check again" in a minute.', { txHash });
    return settleSwap(req, txHash);
  }

  return {
    isPreview: true,
    async getState() {
      if (name === "loading") await new Promise(() => {});
      await wait(350);
      if (failNext) {
        failNext = false;
        throw new Error("Could not reach the Celo network (preview error).");
      }
      return state;
    },
    subscribe(onChange) {
      listeners.add(onChange);
      if (listeners.size === 1) scheduleWeekly();
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          timers.forEach(clearTimeout);
          timers.clear();
        }
      };
    },
    async createWallet(options) {
      const device = options?.mode === "device";
      await wait(1200);
      failPasskey("create");
      if (name === "fresh-fallback" && !device) throw passkeyFailure({ name: "NotAllowedError", message: "preview" }, "create")!;
      const wallet: Wallet = { address: PREVIEW_ADDRESS, createdAt: new Date(), passkey: { discoverable: device ? false : createdDiscoverable } };
      state = {
        ...state,
        wallet,
        registration: { walletRegistered: false, nextGrantFeeCelo: FEE, perKeyFeeCelo: FEE / 2n },
        balances: { usdt: 0n, gold: 0n, celo: 0n, observedAt: new Date() },
      };
      emit();
      later(4000, () => {
        state = { ...state, balances: { usdt: 0n, gold: 0n, celo: 20n * CELO + CELO / 2n, observedAt: new Date() } };
      });
      later(6500, () => {
        state = { ...state, balances: { usdt: 50n * USDT, gold: 0n, celo: 20n * CELO + CELO / 2n, observedAt: new Date() } };
      });
      return wallet;
    },
    async restoreWallet() {
      await wait(900);
      failPasskey("find");
      throw new Error("No Autumn passkey was found on this device (preview).");
    },
    async getBackupCode() {
      if (!state.wallet) throw new Error("There is no wallet on this device yet.");
      return encodeBackupCode({
        wallet: state.wallet.address,
        credentialId: PREVIEW_CREDENTIAL_ID,
        publicKey: PREVIEW_PASSKEY_PUBLIC_KEY,
        rpId,
        discoverable: state.wallet.passkey.discoverable,
      });
    },
    async restoreFromBackupCode(code: string) {
      const d = decodeBackupCode(code);
      if (d.rpId !== rpId) throw new BackupCodeError(`This backup code is for a passkey on ${d.rpId}. This app uses passkeys on ${rpId}.`);
      await wait(900);
      if (state.wallet && state.wallet.address.toLowerCase() !== d.wallet.toLowerCase()) {
        throw new Error(`This browser already holds another Autumn wallet (${state.wallet.address}). Nothing was changed.`);
      }
      const wallet: Wallet = { address: d.wallet, createdAt: new Date(), passkey: { discoverable: d.discoverable } };
      state = {
        ...state,
        wallet,
        balances: state.balances ?? { usdt: 50n * USDT, gold: 0n, celo: 20n * CELO + CELO / 2n, observedAt: new Date() },
      };
      emit();
      return wallet;
    },
    async confirmPlan(input) {
      await wait(1500);
      const now = new Date();
      const plan = makePlan(input, now, new Date(now.getTime() + 5000));
      const regTx = fakeHash();
      const balances = state.balances!;
      const firstGrant = !state.registration?.walletRegistered;
      const fee = state.registration?.nextGrantFeeCelo ?? FEE;
      state = {
        ...state,
        plan,
        agent: { kind: "active" },
        registration: { walletRegistered: true, nextGrantFeeCelo: FEE / 2n, perKeyFeeCelo: FEE / 2n },
        balances: { ...balances, celo: balances.celo - fee, observedAt: now },
        identity: { registered: false },
        activity: [
          { kind: "plan-started", id: `plan${now.getTime()}`, at: now, amount: input.amount, period: input.period, txHash: plan.txHash },
          ...(firstGrant ? [{ kind: "registration" as const, id: `reg${now.getTime()}`, at: new Date(now.getTime() - 1), txHash: regTx }] : []),
          ...state.activity,
        ],
      };
      emit();
      scheduleWeekly();
      return plan;
    },
    async resumePlan() {
      await wait(600);
      return state.agent.kind === "active" ? state.plan : null;
    },
    async registerIdentity() {
      await wait(1200);
      failPasskey("sign");
      state = { ...state, identity: { registered: true, agentId: "1287" } };
      emit();
      return { agentId: "1287", txHash: fakeHash() };
    },
    async checkStop() {
      await wait(600);
      return state.agent.kind === "stopped" && state.agent.txHash ? { txHash: state.agent.txHash } : {};
    },
    async checkSend(req: SendRequest, ref: { txHash?: TxHash }) {
      await wait(600);
      if (!ref.txHash || !state.balances) throw new Error("Nothing to check (preview).");
      return { txHash: ref.txHash, balances: state.balances };
    },
    async revokeStrayKey() {
      await wait(1500);
      state = { ...state, strayKey: null };
      emit();
      return { txHash: fakeHash() };
    },
    async quoteSend(req: { asset: SendAsset; to?: Address; amount?: bigint }): Promise<SendQuote> {
      await wait(400);
      const b = state.balances!;
      const bal = balanceOf(b, req.asset);
      const firstAction = !state.registration?.walletRegistered;
      const registrationCelo = firstAction ? FEE / 2n : 0n;
      const feeInCelo = req.asset === "CELO";
      const fee = feeInCelo ? CELO / 10n : PREVIEW_SEND_FEE;
      return {
        fee,
        feeSymbol: feeInCelo ? "CELO" : "USD₮",
        registrationCelo,
        max: maxSendable(req.asset, bal, { fee, feeToken: feeInCelo ? "0x0000000000000000000000000000000000000000" : USDT_TOKEN, extraNative: registrationCelo }),
      };
    },
    async send(req: SendRequest) {
      const dest = checkDestination(req.to, { wallet: PREVIEW_ADDRESS, contracts: [PREVIEW_GOLD] });
      if (!dest.ok) throw new Error(dest.problem);
      await wait(2200);
      const b = state.balances!;
      if (req.amount > balanceOf(b, req.asset)) throw new Error("The wallet does not hold that much (preview).");
      const fee = req.asset === "CELO" ? CELO / 10n : PREVIEW_SEND_FEE;
      const at = new Date();
      const balances = {
        ...b,
        usdt: req.asset === "USDT" ? b.usdt - req.amount - fee : req.asset === "XAUT0" ? b.usdt - fee : b.usdt,
        gold: req.asset === "XAUT0" ? b.gold - req.amount : b.gold,
        celo: req.asset === "CELO" ? b.celo - req.amount - fee : b.celo,
        observedAt: at,
      };
      state = { ...state, balances };
      emit();
      return { txHash: fakeHash(), balances };
    },
    async quoteSwap(req: { amount?: bigint }): Promise<SwapQuote> {
      await wait(500);
      if (swapCase === "unreadable") {
        throw new SwapUnavailableError("unreadable", "Celo's reference rate or the pool's quote could not be read right now, so converting is unavailable. Nothing was sent. Try again in a minute.");
      }
      const b = state.balances!;
      const reg = state.registration!;
      if (b.celo === 0n) throw new Error("The wallet holds no CELO to convert.");
      const probe = !(req.amount && req.amount > 0n);
      const amountIn = probe ? (b.celo >= 2n * CELO ? CELO : b.celo / 2n) : req.amount!;
      const p = previewPoolQuote(amountIn);
      if (!p.check.ok) throw new SwapUnavailableError("price", `Converting is unavailable right now: ${p.check.reason}. Nothing was sent.`);
      const feeSymbol = b.usdt >= (PREVIEW_SEND_FEE * 3n) / 2n ? ("USD₮" as const) : ("CELO" as const);
      const fee = feeSymbol === "CELO" ? PREVIEW_SWAP_FEE_CELO : PREVIEW_SEND_FEE;
      const registrationCelo = reg.walletRegistered ? 0n : reg.perKeyFeeCelo;
      const { keep, max } = swapKeepAndMax(b.celo, reg, { fee, feeSymbol, registrationCelo });
      return {
        amountIn,
        probe,
        expectedOut: p.out,
        minOut: p.check.minOut,
        referenceOut: p.check.referenceOut,
        belowReferenceBps: p.check.belowReferenceBps,
        fee,
        feeSymbol,
        registrationCelo,
        keep,
        max,
        observedAt: new Date(),
      };
    },
    swap(req: SwapRequest) {
      return (swapFlight ??= doSwap(req).finally(() => {
        swapFlight = null;
      }));
    },
    async checkSwap(req: SwapRequest, ref: { txHash?: TxHash }) {
      await wait(600);
      if (!ref.txHash) throw new Error("Nothing to check (preview).");
      return settleSwap(req, ref.txHash);
    },
    async stopAgent() {
      state = { ...state, agent: { kind: "stopping" } };
      emit();
      await wait(1800);
      const txHash = fakeHash();
      const at = new Date();
      timers.forEach(clearTimeout);
      timers.clear();
      state = {
        ...state,
        agent: { kind: "stopped", stoppedAt: at, txHash },
        plan: state.plan ? { ...state.plan, nextPurchaseAt: null } : null,
        activity: [{ kind: "stopped", id: `stop${at.getTime()}`, at, txHash }, ...state.activity],
      };
      emit();
      return { txHash };
    },
  };
}
