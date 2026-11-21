/**
 * In-memory preview implementation of GramClient.
 * Loaded only when NEXT_PUBLIC_GRAM_PREVIEW=1. Nothing here touches a chain.
 *
 * Optional URL parameter `?preview=<scenario>` picks a starting point:
 *   fresh (default) | funded | active | empty | stopped | error | loading
 */
import {
  DECIMALS,
  WEEK_MS,
  draftLimits,
  nextWeekResetUtc,
  type ActivityItem,
  type Address,
  type GramClient,
  type GramState,
  type Plan,
  type PlanInput,
  type TxHash,
  type Wallet,
} from "./gram";

const USDT = 10n ** BigInt(DECIMALS.USDT);
const CELO = 10n ** BigInt(DECIMALS.CELO);
const OUNCE = 10n ** BigInt(DECIMALS.XAUT0);
const PREVIEW_ADDRESS: Address = "0x7a3f0c1e9b2d4a6f8e5c3b1a0d9e8f7c6b5a4d3e";
const PREVIEW_GOLD: Address = "0x9e1c0a2b3d4e5f60718293a4b5c6d7e8f9a0b1c2";
const FEE = 20n * CELO;

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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;

function goldFor(spent: bigint, usdtPerOunce: bigint) {
  return (spent * OUNCE) / usdtPerOunce;
}

function emptyState(): GramState {
  return {
    wallet: null,
    balances: null,
    registration: null,
    price: { usdtPerOunce: 4126_400000n, observedAt: new Date() },
    plan: null,
    agent: { kind: "none" },
    activity: [],
  };
}

function makePlan(input: PlanInput, startedAt: Date, nextPurchaseAt: Date | null): Plan {
  const d = draftLimits(input, startedAt);
  const weekEndsAt = nextWeekResetUtc(new Date());
  return {
    ...input,
    startedAt,
    nextPurchaseAt,
    txHash: fakeHash(),
    limits: {
      weeklyCap: d.weeklyCap,
      spentThisWeek: 0n,
      weekEndsAt,
      allowedAsset: { symbol: "XAUt0", address: PREVIEW_GOLD },
      expiresAt: d.expiresAt,
    },
  };
}

function scenario(name: string): GramState {
  const s = emptyState();
  if (name === "fresh" || name === "error" || name === "loading") return s;
  const now = Date.now();
  s.wallet = { address: PREVIEW_ADDRESS, createdAt: new Date(now - 40 * DAY) };
  s.registration = { paid: false, feeCelo: FEE };
  s.balances = { usdt: 50n * USDT, gold: 0n, celo: 20n * CELO + CELO / 2n, observedAt: new Date() };
  if (name === "funded") return s;

  const weekly = 5n * USDT;
  const start = name === "empty" ? new Date(now - 60_000) : new Date(now - 4 * WEEK_MS + 6000);
  s.registration = { paid: true, feeCelo: FEE, txHash: fakeHash() };
  s.balances.celo = CELO / 2n;
  const firstNext = name === "empty" ? new Date(start.getTime() + WEEK_MS) : new Date(now + 6000);
  const plan = makePlan({ weeklyAmount: weekly, buyTheDip: true }, start, firstNext);
  s.plan = plan;
  s.agent = { kind: "active" };
  const items: ActivityItem[] = [
    { kind: "registration", id: "reg", at: new Date(start.getTime() - 120_000), feeCelo: FEE, txHash: s.registration.txHash! },
    { kind: "plan-started", id: "plan", at: start, weeklyAmount: weekly, txHash: plan.txHash },
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
      items.push({ kind: "purchase", id: `p${w}`, at, spent: weekly, received: got, usdtPerOunce: p, trigger: "weekly", txHash: fakeHash() });
      if (w === 2) {
        const dipAt = new Date(at.getTime() + 2 * DAY);
        const dp = 3898_200000n;
        const dgot = goldFor(weekly, dp);
        gold += dgot;
        spent += weekly;
        items.push({ kind: "purchase", id: "dip2", at: dipAt, spent: weekly, received: dgot, usdtPerOunce: dp, trigger: "dip", txHash: fakeHash() });
        items.push({ kind: "refused", id: "ref2", at: new Date(dipAt.getTime() + DAY), attempted: weekly, reason: "weekly-cap", txHash: fakeHash() });
      }
    }
    s.balances.gold = gold;
    s.balances.usdt -= spent;
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

export function createPreviewClient(): GramClient {
  const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const name = params?.get("preview") ?? "fresh";
  let state = scenario(name);
  let failNext = name === "error";
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
      const got = goldFor(p.weeklyAmount, price);
      const at = new Date();
      state = {
        ...state,
        balances: { ...state.balances, usdt: state.balances.usdt - p.weeklyAmount, gold: state.balances.gold + got, observedAt: at },
        plan: {
          ...p,
          nextPurchaseAt: new Date(at.getTime() + WEEK_MS),
          limits: { ...p.limits, spentThisWeek: p.limits.spentThisWeek + p.weeklyAmount, weekEndsAt: nextWeekResetUtc(at) },
        },
        activity: [
          { kind: "purchase", id: `live${at.getTime()}`, at, spent: p.weeklyAmount, received: got, usdtPerOunce: price, trigger: "weekly", txHash: fakeHash() },
          ...state.activity,
        ],
      };
    });
  };

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
    async createWallet() {
      await wait(1200);
      const wallet: Wallet = { address: PREVIEW_ADDRESS, createdAt: new Date() };
      state = {
        ...state,
        wallet,
        registration: { paid: false, feeCelo: FEE },
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
    async confirmPlan(input) {
      await wait(1500);
      const now = new Date();
      const plan = makePlan(input, now, new Date(now.getTime() + 5000));
      const regTx = fakeHash();
      const balances = state.balances!;
      const paidFee = !state.registration?.paid;
      state = {
        ...state,
        plan,
        agent: { kind: "active" },
        registration: { paid: true, feeCelo: FEE, txHash: state.registration?.txHash ?? regTx },
        balances: { ...balances, celo: paidFee ? balances.celo - FEE : balances.celo, observedAt: now },
        activity: [
          { kind: "plan-started", id: `plan${now.getTime()}`, at: now, weeklyAmount: input.weeklyAmount, txHash: plan.txHash },
          ...(paidFee ? [{ kind: "registration" as const, id: `reg${now.getTime()}`, at: new Date(now.getTime() - 1), feeCelo: FEE, txHash: regTx }] : []),
          ...state.activity,
        ],
      };
      emit();
      scheduleWeekly();
      return plan;
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
