/**
 * The real AutumnClient: an Altana passkey wallet on Celo mainnet, chain
 * reads through @autumn/core, and the Autumn server for the session key and
 * the agent's run log.
 *
 * Every number on screen comes from a chain read (balances, price,
 * registration fee, the session's limits and spend, purchases) or from the
 * server's run log (skips and refusals that never reach the chain). When a
 * read fails, the last good value is kept with its time and a notice says so;
 * nothing is filled in.
 */
import {
  CELO,
  NATIVE_TOKEN,
  SessionRevokeError,
  createClient,
  serializeSession,
  signerFromPasskey,
  type Client,
  type PasskeyCredential,
  type SerializedSession,
  type Signer,
} from "@altananetwork/sdk";
import {
  XAUT0,
  USDT,
  createCeloPublicClient,
  expectedSerializedSession,
  pinnedBlock,
  planToSessionGrant,
  readAgentIdentityCount,
  readBalances,
  readPoolState,
  readPurchases,
  readRegistration,
  readSessionState,
  readTxFacts,
  sessionLimitsMismatch,
  sessionMatchesGrant,
  sessionSignerFromPublicKey,
  type Purchase,
  type SessionGrant,
  type SessionState,
  type TxFacts,
} from "@autumn/core";
import type { CreatePlanResponse, PlanView, WalletView } from "@autumn/agent";
import { agentStatusFor, buildActivity, currentPlan, nextPurchaseFor, planItems, purchaseItems, runLogItems } from "./activity";
import {
  DECIMALS,
  type Address,
  type AutumnClient,
  type AutumnState,
  type Balances,
  type GoldPrice,
  type Limits,
  type Plan,
  type PlanInput,
  type Registration,
  type TxHash,
  type Wallet,
} from "./autumn";
import { passkeyOriginProblem, type PublicConfig } from "./env";

const WALLET_KEY = "autumn:v1:wallet";
const PENDING_KEY = "autumn:v1:pending-grant";
const purchasesKey = (goldBuyer: string, wallet: string) => `autumn:v1:purchases:${goldBuyer.toLowerCase()}:${wallet.toLowerCase()}`;
/** Blocks below the head that are cached; newer ones are re-read every time (reorg margin). */
const CACHE_MARGIN = 64n;
const POLL_MS = 20_000;
const CELO_CHAIN_ID = 42220;

type StoredWallet = { address: Address; credential: PasskeyCredential; createdAt: string };
type StoredPending = { planId: string; wallet: Address; txHash: TxHash; expected: SerializedSession };
type SerializedPurchase = Omit<Purchase, "amountIn" | "out" | "priceUsdtPerXaut" | "blockNumber"> & {
  amountIn: string;
  out: string;
  priceUsdtPerXaut: string;
  blockNumber: string;
};

function loadJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function saveJson(key: string, v: unknown) {
  window.localStorage.setItem(key, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : {},
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `The Autumn server answered ${res.status}.`);
  return data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

export function createLiveClient(cfg: PublicConfig): AutumnClient {
  const network = { ...CELO, publicRpcUrl: cfg.rpcUrl };
  let sdk: Client | null = null;
  const sdkClient = (): Client =>
    (sdk ??= createClient({
      chains: [network],
      // For a passkey wallet the SDK skips the automatic ERC-8004 registration
      // (each transaction needs a prompt); confirmPlan calls it explicitly with this record.
      agentIdentity: {
        name: "Autumn",
        description: "Buys a little Tether Gold (XAUt0) on a schedule, within limits written onchain.",
        endpoint: window.location.origin,
      },
    }));
  const pub = createCeloPublicClient(cfg.rpcUrl);
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const facts = new Map<string, TxFacts | null>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopping: { txHash?: TxHash } | null = null;
  let goldBuyerHasCode: boolean | null = null;
  let serverMode: { configured: boolean; live: boolean } | null = null;
  const last: {
    price?: GoldPrice;
    balances?: Balances;
    registration?: Registration;
    view?: WalletView;
    sessions: Map<string, { state: SessionState; at: Date }>;
    identity?: { registered: boolean };
    purchases?: Purchase[];
  } = { sessions: new Map() };

  const storedWallet = () => loadJson<StoredWallet>(WALLET_KEY);
  function admin(): { wallet: { address: Address }; signer: Signer } {
    const w = storedWallet();
    if (!w) throw new Error("There is no wallet on this device yet.");
    return { wallet: { address: w.address }, signer: signerFromPasskey(w.credential) };
  }
  function assertPasskeyOrigin() {
    const problem = passkeyOriginProblem(cfg, window.location);
    if (problem) throw new Error(problem);
  }
  function remember(address: Address, credential: PasskeyCredential): Wallet {
    const createdAt = new Date();
    saveJson(WALLET_KEY, { address, credential, createdAt: createdAt.toISOString() } satisfies StoredWallet);
    return { address, createdAt };
  }

  async function loadTxFacts(hash: string | null | undefined, wallet: Address): Promise<void> {
    if (!hash) return;
    const k = hash.toLowerCase();
    if (facts.get(k)) return;
    try {
      facts.set(k, await readTxFacts(pub, k as TxHash, wallet));
    } catch {
      /* stays unknown; the plan's own times are shown instead */
    }
  }

  /** GoldBuyer purchases by the wallet from `fromBlock`, scanned incrementally; blocks below the reorg margin are cached. */
  async function readWalletPurchases(wallet: Address, fromBlock: bigint): Promise<Purchase[]> {
    const key = purchasesKey(cfg.goldBuyer, wallet);
    const cached = loadJson<{ from: string; to: string; items: SerializedPurchase[] }>(key);
    const head = await pinnedBlock(pub);
    let items: Purchase[] = [];
    let scanFrom = fromBlock;
    let cacheFrom = fromBlock;
    if (cached && BigInt(cached.from) <= fromBlock && BigInt(cached.to) < head) {
      items = cached.items.map((p) => ({
        ...p,
        amountIn: BigInt(p.amountIn),
        out: BigInt(p.out),
        priceUsdtPerXaut: BigInt(p.priceUsdtPerXaut),
        blockNumber: BigInt(p.blockNumber),
      }));
      scanFrom = BigInt(cached.to) + 1n;
      cacheFrom = BigInt(cached.from);
    }
    const fresh =
      scanFrom <= head
        ? await readPurchases(pub, { goldBuyer: cfg.goldBuyer, buyer: wallet, fromBlock: scanFrom, toBlock: head, blockRange: cfg.logBlockRange })
        : [];
    const all = [...items, ...fresh];
    const cacheTo = head > CACHE_MARGIN ? head - CACHE_MARGIN : 0n;
    if (cacheTo >= scanFrom - 1n) {
      saveJson(key, { from: cacheFrom.toString(), to: cacheTo.toString(), items: all.filter((p) => p.blockNumber <= cacheTo) });
    }
    return all;
  }

  /** A grant that landed but was never reported to the server (for example the tab closed): report it now. */
  async function resumePendingGrant(wallet: Address): Promise<void> {
    const pending = loadJson<StoredPending>(PENDING_KEY);
    if (!pending || pending.wallet.toLowerCase() !== wallet.toLowerCase()) return;
    try {
      await api(`/api/plans/${pending.planId}/activate`, { method: "POST", body: { session: pending.expected, grantTxHash: pending.txHash } });
      window.localStorage.removeItem(PENDING_KEY);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400 || /stopped|does not match|differs/.test(e.message))) {
        window.localStorage.removeItem(PENDING_KEY);
      }
    }
  }

  async function getState(): Promise<AutumnState> {
    const notices: string[] = [];
    const w = storedWallet();

    let price: GoldPrice | null = last.price ?? null;
    try {
      const pool = await readPoolState(pub);
      price = { usdtPerOunce: pool.midUsdtPerXaut, observedAt: new Date(pool.blockTimestamp * 1000), priceCheckAvailable: pool.twapAvailable };
      last.price = price;
    } catch {
      notices.push(price ? "The gold price could not be refreshed. The price shown is from the time given." : "The gold price could not be read from Celo right now.");
    }

    if (goldBuyerHasCode === null) {
      try {
        const code = await pub.getCode({ address: cfg.goldBuyer });
        goldBuyerHasCode = !!code && code !== "0x";
      } catch {
        /* checked again on the next refresh */
      }
    }
    if (goldBuyerHasCode === false) notices.push(`No GoldBuyer contract is deployed at ${cfg.goldBuyer} on Celo, so plans cannot start yet.`);

    if (!w) {
      return { wallet: null, balances: null, registration: null, price, plan: null, agent: { kind: "none" }, activity: [], identity: null, notices };
    }
    const wallet: Wallet = { address: w.address, createdAt: new Date(w.createdAt) };

    if (serverMode === null) {
      serverMode = await api<{ configured: boolean; live: boolean }>("/api/health").catch(() => null);
    }
    if (serverMode && !serverMode.configured) notices.push("The Autumn server is not configured, so no agent runs for this app.");
    else if (serverMode && !serverMode.live) notices.push("The agent runs in dry-run mode on this server: it decides but sends no purchases.");

    await resumePendingGrant(w.address);

    const [bal, reg, srv, ident] = await Promise.allSettled([
      readBalances(pub, w.address),
      readRegistration(pub, w.address),
      api<WalletView>(`/api/wallets/${w.address}`),
      readAgentIdentityCount(pub, w.address),
    ]);
    if (bal.status === "rejected" && reg.status === "rejected" && !last.balances) {
      throw new Error("Could not reach the Celo network. Your funds are not affected.");
    }

    let balances = last.balances ?? null;
    if (bal.status === "fulfilled") {
      const b = bal.value;
      const block = await pub.getBlock({ blockNumber: b.blockNumber }).catch(() => null);
      balances = { usdt: b.usdt, gold: b.xaut0, celo: b.celo, observedAt: block ? new Date(Number(block.timestamp) * 1000) : new Date() };
      last.balances = balances;
    } else {
      notices.push(balances ? "Balances could not be refreshed. They are from the time shown." : "Balances could not be read from Celo right now.");
    }

    let registration = last.registration ?? null;
    if (reg.status === "fulfilled") {
      registration = { walletRegistered: reg.value.walletRegistered, nextGrantFeeCelo: reg.value.nextGrantValue };
      last.registration = registration;
    } else if (!registration) {
      notices.push("The Altana registration fee could not be read from Celo right now.");
    }

    let identity = last.identity ?? null;
    if (ident.status === "fulfilled") identity = last.identity = { registered: ident.value > 0n };

    let view = last.view ?? null;
    if (srv.status === "fulfilled") view = last.view = srv.value;
    else if (view) notices.push("The Autumn server could not be reached. Plan details and the agent's log may be out of date.");
    else throw new Error(`Could not reach the Autumn server: ${errText(srv.reason)}`);

    const planView = currentPlan(view.plans);
    let session: SessionState | null = null;
    let sessionAt: Date | null = null;
    if (planView) {
      try {
        session = await readSessionState(pub, { wallet: planView.walletAddress, publicKey: planView.sessionPublicKey });
        sessionAt = new Date(session.blockTimestamp * 1000);
        last.sessions.set(planView.id, { state: session, at: sessionAt });
      } catch {
        const prev = last.sessions.get(planView.id);
        if (prev) ({ state: session, at: sessionAt } = prev);
        notices.push("The agent's limits could not be read from Celo right now. The values shown may be out of date.");
      }
      await Promise.all([loadTxFacts(planView.grantTxHash, w.address), loadTxFacts(planView.stopTxHash, w.address)]);
      for (const p of view.plans) if (p !== planView) await loadTxFacts(p.grantTxHash, w.address);
    }

    let purchases: Purchase[] = last.purchases ?? [];
    const granted = view.plans.filter((p) => p.status !== "pending_grant");
    if (granted.length) {
      const fromBlock = granted.reduce<bigint>(
        (min, p) => (p.createdBlock !== null && BigInt(p.createdBlock) < min ? BigInt(p.createdBlock) : min),
        BigInt(granted[0]!.createdBlock ?? cfg.goldBuyerDeployBlock),
      );
      try {
        purchases = last.purchases = await readWalletPurchases(w.address, fromBlock > cfg.goldBuyerDeployBlock ? fromBlock : cfg.goldBuyerDeployBlock);
      } catch {
        notices.push("Purchases could not be read from Celo right now. The list may be incomplete.");
      }
    }

    const agent = agentStatusFor({ plan: planView, chainStatus: session?.status ?? null, stopping, facts });
    if (stopping && agent.kind === "stopped") stopping = null;

    let plan: Plan | null = null;
    if (planView) {
      const cap = session?.usdtCap;
      const resetsAt = cap ? new Date(cap.resetsAt * 1000) : null;
      const nowSecs = session?.blockTimestamp ?? Math.floor(Date.now() / 1000);
      const limits: Limits = {
        period: planView.period,
        cap: cap?.limit ?? BigInt(planView.periodCap ?? "0"),
        spent: cap ? cap.spent : null,
        resetsAt: resetsAt ?? new Date(nowSecs * 1000),
        allowedAsset: { symbol: "XAUt0", address: XAUT0 },
        expiresAt: new Date(planView.expiresAt * 1000),
        observedAt: cap ? sessionAt : null,
      };
      if (!cap && agent.kind === "active") notices.push("The agent's spending limit could not be read from Celo right now.");
      const planFacts = planView.grantTxHash ? facts.get(planView.grantTxHash.toLowerCase()) : undefined;
      plan = {
        amount: BigInt(planView.amountPerBuy),
        period: planView.period,
        buyTheDip: planView.dipBuy,
        startedAt: new Date((planFacts?.timestamp ?? planView.createdAt) * 1000),
        nextPurchaseAt: nextPurchaseFor(planView, purchases, nowSecs, agent),
        limits,
        ...(planView.grantTxHash ? { txHash: planView.grantTxHash as TxHash } : {}),
      };
    }

    const activity = buildActivity([purchaseItems(purchases, view.plans), runLogItems(view.runLog), planItems(view.plans, facts)]);
    return { wallet, balances, registration, price, plan, agent, activity, identity, notices };
  }

  /** Re-reads the session until `done` holds or the time runs out. */
  async function waitForSession(plan: { wallet: Address; publicKey: `0x${string}` }, done: (s: SessionState) => boolean, ms: number) {
    const until = Date.now() + ms;
    let s: SessionState | null = null;
    for (;;) {
      try {
        s = await readSessionState(pub, { wallet: plan.wallet, publicKey: plan.publicKey });
        if (done(s)) return s;
      } catch {
        /* keep trying until the deadline */
      }
      if (Date.now() > until) return s;
      await sleep(3000);
    }
  }

  async function revokeKey(publicKey: `0x${string}`): Promise<TxHash | undefined> {
    const { wallet, signer } = admin();
    try {
      const r = await sdkClient().revokeSession({ wallet, signer, session: publicKey, feeToken: [USDT, NATIVE_TOKEN], chainId: CELO_CHAIN_ID });
      return r.transactionHash as TxHash | undefined;
    } catch (e) {
      // The revoke may have gone through on the account even if a later step failed: the chain decides.
      if (e instanceof SessionRevokeError) return e.result.transactionHash as TxHash | undefined;
      throw e;
    }
  }

  async function confirmPlan(input: PlanInput): Promise<Plan> {
    assertPasskeyOrigin();
    if (goldBuyerHasCode === false) throw new Error("GoldBuyer is not deployed at the configured address, so no plan can start.");
    const { wallet, signer } = admin();
    const unit = 10n ** BigInt(DECIMALS.USDT);
    if (input.amount % unit !== 0n) throw new Error("Plans are whole USD₮ amounts.");
    const expiresAt = Math.floor(input.expiresAt.getTime() / 1000);

    // 1. The server makes the session key and keeps its private half.
    const created = await api<CreatePlanResponse>("/api/plans", {
      method: "POST",
      body: { wallet: wallet.address, amountUsdt: Number(input.amount / unit), period: input.period, dipBuy: input.buyTheDip, expiresAt },
    });

    // 2. The limits granted are the ones computed here and shown on screen, not whatever the server says.
    const grant: SessionGrant = planToSessionGrant(
      { amountPerBuy: input.amount, period: input.period, dipBuy: input.buyTheDip, expiresAt },
      cfg.goldBuyer,
      Math.floor(Date.now() / 1000),
    );
    const expected = expectedSerializedSession(grant, wallet.address, created.sessionPublicKey);
    if (!sessionMatchesGrant(created.expected, expected)) {
      throw new Error("The server proposed limits that differ from the ones shown. Nothing was signed.");
    }

    // 3. The passkey grants the session (and pays the KeyStore registration in CELO).
    const result = await sdkClient().grantSession({
      wallet,
      signer,
      sessionSigner: sessionSignerFromPublicKey(created.sessionPublicKey),
      permissions: grant.permissions,
      expiry: grant.expiry,
      feeToken: USDT,
      chainId: CELO_CHAIN_ID,
      agentIdentity: false,
    });
    const txHash = result.transactionHash as TxHash | undefined;
    if (!txHash) throw new Error("The grant returned no transaction. Check your wallet's keys before trying again.");
    saveJson(PENDING_KEY, { planId: created.planId, wallet: wallet.address, txHash, expected } satisfies StoredPending);

    // 4. Before telling the server: the SDK granted what was shown, and the chain holds exactly that.
    const granted = serializeSession(result);
    const onchain = await waitForSession(
      { wallet: wallet.address, publicKey: created.sessionPublicKey },
      (s) => s.status === "active" && s.spend.length > 0,
      60_000,
    );
    const mismatch = !sessionMatchesGrant(granted, expected)
      ? "the wallet granted different permissions"
      : !onchain
        ? "Celo could not be read"
        : sessionLimitsMismatch(onchain, grant, cfg.goldBuyer) ?? null;
    if (mismatch) {
      window.localStorage.removeItem(PENDING_KEY);
      let revoked = false;
      try {
        await revokeKey(created.sessionPublicKey);
        revoked = true;
      } catch {
        /* reported below */
      }
      throw new Error(
        `The plan was not started: ${mismatch}. ` +
          (revoked ? "The agent's key was revoked." : "Revoke the agent's key from your wallet before trying again."),
      );
    }

    // 5. Only now does the server activate it (it checks the chain again itself).
    for (let i = 0; ; i++) {
      try {
        await api(`/api/plans/${created.planId}/activate`, { method: "POST", body: { session: expected, grantTxHash: txHash } });
        break;
      } catch (e) {
        if (i < 5 && e instanceof ApiError && e.status === 409 && /not visible|not active/.test(e.message)) {
          await sleep(4000);
          continue;
        }
        throw e;
      }
    }
    window.localStorage.removeItem(PENDING_KEY);

    // 6. ERC-8004: the SDK does not register a passkey wallet by itself. One more prompt, never fatal.
    try {
      if ((await readAgentIdentityCount(pub, wallet.address)) === 0n) {
        await sdkClient().registerAgentIdentity({ wallet, signer, feeToken: [USDT, NATIVE_TOKEN], chainId: CELO_CHAIN_ID });
      }
    } catch {
      /* registerAgentIdentity never throws; the read can. The identity shows as not registered. */
    }

    emit();
    const state = await getState();
    if (!state.plan) throw new Error("The plan started, but it could not be read back. Reload the page.");
    return state.plan;
  }

  async function stopAgent(): Promise<{ txHash?: TxHash }> {
    assertPasskeyOrigin();
    const view = last.view ?? (await api<WalletView>(`/api/wallets/${admin().wallet.address}`));
    const plan = currentPlan(view.plans);
    if (!plan) throw new Error("There is no plan to stop.");
    stopping = {};
    emit();
    let txHash: TxHash | undefined;
    try {
      txHash = await revokeKey(plan.sessionPublicKey);
      stopping = txHash ? { txHash } : {};
      emit();
      const s = await waitForSession({ wallet: plan.walletAddress, publicKey: plan.sessionPublicKey }, (x) => x.status !== "active", 90_000);
      if (!s || s.status === "active") {
        throw new Error(
          txHash
            ? `The revoke was sent (${txHash}), but Celo does not show it yet. The agent may still be able to buy; check again in a minute.`
            : "Celo does not show the revoke. The agent may still be able to buy.",
        );
      }
    } catch (e) {
      stopping = null;
      emit();
      throw e;
    }
    try {
      await api(`/api/plans/${plan.id}/stop`, { method: "POST", body: txHash ? { revokeTxHash: txHash } : {} });
    } catch {
      /* The chain already stops the agent; the runner also closes the plan when it sees the revoke. */
    }
    last.view = undefined;
    emit();
    return txHash ? { txHash } : {};
  }

  return {
    isPreview: false,
    getState,
    subscribe(onChange) {
      listeners.add(onChange);
      if (!timer) timer = setInterval(emit, POLL_MS);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    async createWallet() {
      assertPasskeyOrigin();
      const w = await sdkClient().createPasskeyWallet({ name: "Autumn", rpId: cfg.rpId });
      const wallet = remember(w.address as Address, w.signer.credential);
      emit();
      return wallet;
    },
    async restoreWallet() {
      assertPasskeyOrigin();
      const w = await sdkClient().recoverFromPasskey({ rpId: cfg.rpId, chainId: CELO_CHAIN_ID });
      const wallet = remember(w.address as Address, w.signer.credential);
      emit();
      return wallet;
    },
    confirmPlan,
    stopAgent,
  };
}

export type { PlanView };
