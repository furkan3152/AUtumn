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
  type PasskeyWebAuthnFns,
  RELAY_URL,
} from "@altananetwork/sdk";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, toHex, type Hex } from "viem";
import {
  XAUT0,
  USDT,
  buildSendCall,
  checkDestination,
  createCeloPublicClient,
  ALTANA_ORCHESTRATOR,
  altanaAccountAbi,
  estimateRelayFeeUsdt,
  maxSendable,
  readAgentIdMinted,
  readCeloUsdtRate,
  sessionKeyIds,
  expectedSerializedSession,
  pinnedBlock,
  planToSessionGrant,
  readAgentIdentityCount,
  readBalances,
  readPoolState,
  readPurchases,
  readRegistration,
  REGISTRATION_VALUE_PERCENT,
  readSessionState,
  readTxFacts,
  sessionLimitsMismatch,
  sessionMatchesGrant,
  sessionSignerFromPublicKey,
  type Purchase,
  type PlanPeriod,
  type SendAsset,
  type SessionGrant,
  type SessionState,
  type TxFacts,
} from "@autumn/core";
import type { CreatePlanResponse, PlanView, WalletView } from "@autumn/agent";
import { agentStatusFor, buildActivity, currentPlan, nextPurchaseFor, planItems, purchaseItems, runLogItems } from "./activity";
import {
  DECIMALS,
  ORCHESTRATOR_ENTRY_TEXT,
  type Address,
  type AutumnClient,
  type AutumnState,
  type Balances,
  type FeeFacts,
  type GoldPrice,
  type Limits,
  type Plan,
  type PlanInput,
  type Registration,
  type SendQuote,
  type SendRequest,
  type SendResult,
  type TxHash,
  type Wallet,
} from "./autumn";
import { passkeyOriginProblem, type PublicConfig } from "./env";
import { BackupCodeError, decodeBackupCode, encodeBackupCode, webAuthnKeyHash } from "./backupCode";
import {
  browserCreateFn,
  browserGetFn,
  hasWebAuthn,
  chooseRequestKind,
  isAndroid,
  passkeyFailure,
  readPlatformCapabilities,
  selectionCreateFn,
  unsupportedPasskeys,
  userHandleFillingGetFn,
  type CreationMode,
  type Discoverable,
  type PlatformCapabilities,
} from "./passkey";
import { readRecord, reconcileRecord, saveRecord } from "./walletStore";

const WALLET_KEY = "autumn:v1:wallet";
/** Older single-entry form, read once and migrated. */
const PENDING_KEY_V1 = "autumn:v1:pending-grant";
/** Agent keys this browser asked to grant and has not seen through yet, written before the passkey prompt. */
const PENDING_KEY = "autumn:v2:pending-grants";
const agentIdKey = (wallet: string) => `autumn:v1:agent-id:${wallet.toLowerCase()}`;
/** A pending key not on the account after this long was never granted: forget it. */
const PENDING_GIVE_UP_MS = 10 * 60_000;
/** Blocks after a grant searched for the ERC-8004 mint when the agent id is not cached. */
const AGENT_ID_SEARCH_BLOCKS = 20_000n;
/** Stands in for the destination when quoting a send before one is entered. */
const QUOTE_PLACEHOLDER_TO = "0x000000000000000000000000000000000000dEaD" as Address;
const purchasesKey = (goldBuyer: string, wallet: string) => `autumn:v1:purchases:${goldBuyer.toLowerCase()}:${wallet.toLowerCase()}`;
/** Blocks below the head that are cached; newer ones are re-read every time (reorg margin). */
const CACHE_MARGIN = 64n;
const POLL_MS = 20_000;
const CELO_CHAIN_ID = 42220;

/**
 * The wallet as this browser keeps it (localStorage and IndexedDB, see walletStore.ts). Public facts only: the
 * passkey's private key never leaves the device's authenticator. `discoverable` is absent for wallets saved before
 * it was recorded: those passkeys were created with residentKey "required" (or found from the passkey alone), so
 * they are discoverable.
 */
type StoredWallet = { address: Address; credential: PasskeyCredential; createdAt: string; discoverable?: Discoverable };
type WebAuthnCredential = Extract<PasskeyCredential, { kind: "webauthn" }>;
type StoredPending = {
  planId: string;
  wallet: Address;
  publicKey: `0x${string}`;
  expected: SerializedSession;
  /** The plan as confirmed, to rebuild the grant it asked for. */
  plan: { amountPerBuy: string; period: PlanPeriod; dipBuy: boolean; expiresAt: number };
  createdAt: number;
  txHash?: TxHash;
};
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

/** USD₮ base units per whole CELO, from the directory's rate. */
const celoToUsdtUnit = (rate: { numerator: bigint; denominator: bigint }) => (10n ** 18n * rate.numerator) / rate.denominator / 10n ** 12n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The transfer's transaction is onchain, but the balance check afterwards could not be read. */
export class SendSubmittedError extends Error {
  readonly txHash: string;
  constructor(txHash: string, cause?: unknown) {
    super(`The transfer was sent (${txHash}), but Celo's public node did not answer the balance check. Do not send again: view the transaction on Celoscan, then reload.`);
    this.name = "SendSubmittedError";
    this.txHash = txHash;
    this.cause = cause;
  }
}
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
    identity?: { registered: boolean; agentId?: string };
    purchases?: Purchase[];
    fees?: FeeFacts;
  } = { sessions: new Map() };

  const storedWallet = (): StoredWallet | null => {
    const raw = readRecord(WALLET_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredWallet;
    } catch {
      return null;
    }
  };
  /** Copies the wallet record between localStorage and IndexedDB once per page load, before the first read. */
  let reconciled: Promise<unknown> | null = null;
  const reconcile = () => (reconciled ??= reconcileRecord(WALLET_KEY).catch(() => null));
  const discoverableOf = (w: StoredWallet): Discoverable => w.discoverable ?? true;
  function admin(): { wallet: { address: Address }; signer: Signer } {
    const w = storedWallet();
    if (!w) throw new Error("There is no wallet on this device yet.");
    // A discoverable passkey signs exactly as before. A device-bound one returns no user handle when asked by its id,
    // which porto's Key.sign refuses; the SDK's documented getFn hook fills it with the wallet address (the value
    // written into the passkey at creation). The signature itself is unchanged.
    const webAuthn: PasskeyWebAuthnFns | undefined =
      discoverableOf(w) === true ? undefined : { getFn: userHandleFillingGetFn(browserGetFn(), w.address) as NonNullable<PasskeyWebAuthnFns["getFn"]> };
    return { wallet: { address: w.address }, signer: signerFromPasskey(w.credential, webAuthn ? { webAuthn } : undefined) };
  }
  /** Read once per page load, ahead of the first click, so the passkey prompt is not delayed. */
  let capabilities: Promise<PlatformCapabilities> | null = null;
  const platformCapabilities = () => (capabilities ??= readPlatformCapabilities());
  if (hasWebAuthn()) void platformCapabilities();
  function assertPasskeyOrigin() {
    const problem = passkeyOriginProblem(cfg, window.location);
    if (problem) throw new Error(problem);
  }
  async function remember(address: Address, credential: PasskeyCredential, discoverable: Discoverable): Promise<Wallet> {
    const createdAt = new Date();
    const record: StoredWallet = { address, credential, createdAt: createdAt.toISOString(), discoverable };
    await saveRecord(WALLET_KEY, JSON.stringify(record));
    return { address, createdAt, passkey: { discoverable } };
  }

  /** The SDK network's relay, for reading a wallet's keys before its first transaction. */
  async function relayAdminKeys(wallet: Address): Promise<{ type: string; role: string; publicKey: string; hash: string }[]> {
    const res = await fetch(network.relayUrl ?? RELAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wallet_getKeys", params: [{ address: wallet, chainIds: [toHex(CELO_CHAIN_ID)] }] }),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as { result?: Record<string, unknown>; error?: { message?: string } } | null;
    if (!res.ok || !data) throw new Error(`The Altana relay could not be read (${res.status}).`);
    if (data.error) throw new Error(`The Altana relay does not know this wallet (${data.error.message ?? "no reason given"}).`);
    const keys = data.result?.[toHex(CELO_CHAIN_ID)];
    return Array.isArray(keys) ? (keys as { type: string; role: string; publicKey: string; hash: string }[]) : [];
  }

  /**
   * Whether `publicKey` (a WebAuthn P-256 key) is an admin key of `wallet`. Once the wallet has transacted its
   * account code is on Celo and the account's own getKey answers. Before that the wallet exists only as the relay's
   * stored upgrade (the authorization that lands with the first transaction), so the relay's key list answers.
   * Throws a plain sentence when it is not, or when neither could be read.
   */
  async function assertAdminKey(wallet: Address, publicKey: Hex): Promise<"celo" | "relay"> {
    const keyHash = webAuthnKeyHash(publicKey);
    const notAdmin = "This backup code's passkey is not an admin of that wallet, so it was not restored. Check that the code is yours.";
    let code: Hex | undefined;
    try {
      code = await pub.getCode({ address: wallet });
    } catch {
      throw new Error("Celo could not be read to check the backup code. Nothing was changed; try again.");
    }
    if (code && code !== "0x") {
      let key: { expiry: number; keyType: number; isSuperAdmin: boolean; publicKey: Hex };
      try {
        key = await pub.readContract({ address: wallet, abi: altanaAccountAbi, functionName: "getKey", args: [keyHash] });
      } catch (e) {
        const reverted = e instanceof BaseError && !!e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError);
        if (reverted) throw new Error(notAdmin);
        throw new Error("Celo could not be read to check the backup code. Nothing was changed; try again.");
      }
      const expired = Number(key.expiry) !== 0 && Number(key.expiry) * 1000 <= Date.now();
      if (!key.isSuperAdmin || Number(key.keyType) !== 1 || key.publicKey.toLowerCase() !== publicKey.toLowerCase() || expired) {
        throw new Error(notAdmin);
      }
      return "celo";
    }
    let keys: Awaited<ReturnType<typeof relayAdminKeys>>;
    try {
      keys = await relayAdminKeys(wallet);
    } catch (e) {
      throw new Error(`This wallet has not made a transaction yet, and ${errText(e).replace(/^The /, "the ")} Nothing was changed.`);
    }
    const match = keys.some(
      (k) => k.type === "webauthnp256" && k.role === "admin" && k.publicKey?.toLowerCase() === publicKey.toLowerCase() && k.hash?.toLowerCase() === keyHash.toLowerCase(),
    );
    if (!match) throw new Error(notAdmin);
    return "relay";
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

  function loadPendings(): StoredPending[] {
    const list = loadJson<StoredPending[]>(PENDING_KEY) ?? [];
    const v1 = loadJson<{ planId: string; wallet: Address; txHash: TxHash; expected: SerializedSession }>(PENDING_KEY_V1);
    if (v1) {
      window.localStorage.removeItem(PENDING_KEY_V1);
      // v1 entries were written after the grant returned, so their key is known to be granted; the plan input is not stored.
      list.push({
        planId: v1.planId, wallet: v1.wallet, publicKey: v1.expected.publicKey as `0x${string}`, expected: v1.expected,
        plan: { amountPerBuy: "0", period: "week", dipBuy: false, expiresAt: v1.expected.expiry }, createdAt: 0, txHash: v1.txHash,
      });
      saveJson(PENDING_KEY, list);
    }
    return list;
  }
  function savePending(p: StoredPending) {
    saveJson(PENDING_KEY, [...loadPendings().filter((x) => x.planId !== p.planId), p]);
  }
  function dropPending(planId: string) {
    saveJson(PENDING_KEY, loadPendings().filter((x) => x.planId !== planId));
  }
  const confirming = new Set<string>();

  /**
   * Agent keys this browser asked to grant (saved before the passkey prompt),
   * settled from the chain: granted ones are handed to the server; ones the
   * server cannot take become a "stray key" the owner is asked to revoke; ones
   * never granted are forgotten after a while. A live key is never forgotten.
   */
  async function settlePendingGrants(wallet: Address): Promise<{ publicKey: `0x${string}`; reason: string } | null> {
    let stray: { publicKey: `0x${string}`; reason: string } | null = null;
    for (const p of loadPendings()) {
      if (p.wallet.toLowerCase() !== wallet.toLowerCase() || confirming.has(p.planId)) continue;
      let s: SessionState;
      try {
        s = await readSessionState(pub, { wallet, publicKey: p.publicKey });
      } catch {
        continue; // unknown: keep it, check again on the next refresh
      }
      if (s.status !== "active") {
        // Not on the account (never granted, or revoked) or expired: nothing live to look after.
        if (s.onAccount || s.status === "expired" || Date.now() - p.createdAt > PENDING_GIVE_UP_MS) dropPending(p.planId);
        continue;
      }
      // The key is live. It must be a plain session key with exactly the plan's limits, or it is revoked.
      let mismatch: string | undefined;
      if (p.plan.amountPerBuy !== "0") {
        try {
          const grant = planToSessionGrant(
            { amountPerBuy: BigInt(p.plan.amountPerBuy), period: p.plan.period, dipBuy: p.plan.dipBuy, expiresAt: p.plan.expiresAt },
            cfg.goldBuyer,
            s.blockTimestamp,
          );
          mismatch = sessionLimitsMismatch(s, grant, cfg.goldBuyer);
        } catch (e) {
          mismatch = errText(e);
        }
      }
      if (mismatch) {
        stray = { publicKey: p.publicKey, reason: `its onchain limits are not the plan's: ${mismatch}` };
        continue;
      }
      try {
        await api(`/api/plans/${p.planId}/activate`, { method: "POST", body: { session: p.expected, ...(p.txHash ? { grantTxHash: p.txHash } : {}) } });
        dropPending(p.planId);
        last.view = undefined;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && /not visible|not active/.test(e.message)) continue; // the chain is catching up
        if (e instanceof ApiError && e.status !== 503 && e.status < 500) {
          stray = { publicKey: p.publicKey, reason: `the Autumn server could not start a plan with it (${e.message})` };
        }
      }
    }
    return stray;
  }

  async function getState(): Promise<AutumnState> {
    const notices: string[] = [];
    await reconcile();
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

    let fees: FeeFacts | null = last.fees ?? null;
    try {
      const [rate, gasPrice] = await Promise.all([readCeloUsdtRate(pub), pub.getGasPrice()]);
      fees = last.fees = { usdtPerCelo: celoToUsdtUnit(rate), relayFeeEstimate: estimateRelayFeeUsdt(gasPrice, rate), observedAt: new Date() };
    } catch {
      /* fee figures in dollars are left out; the CELO amounts still show */
    }

    if (!w) {
      // What a new wallet's first plan would pay: no keys registered yet (the KeyStore has none for this placeholder address).
      let registration: Registration | null = last.registration ?? null;
      try {
        const r = await readRegistration(pub, "0x0000000000000000000000000000000000000001");
        registration = { walletRegistered: false, nextGrantFeeCelo: r.nextGrantValue, perKeyFeeCelo: (r.feePerKey * REGISTRATION_VALUE_PERCENT) / 100n };
      } catch {
        /* shown as "read when your wallet is open" */
      }
      return { wallet: null, balances: null, registration, price, plan: null, agent: { kind: "none" }, activity: [], identity: null, fees, strayKey: null, notices };
    }
    const wallet: Wallet = { address: w.address, createdAt: new Date(w.createdAt), passkey: { discoverable: discoverableOf(w) } };

    if (serverMode === null) {
      serverMode = await api<{ configured: boolean; live: boolean }>("/api/health").catch(() => null);
    }
    if (serverMode && !serverMode.configured) notices.push("The Autumn server is not configured, so no agent runs for this app.");
    else if (serverMode && !serverMode.live) notices.push("The agent runs in dry-run mode on this server: it decides but sends no purchases.");

    const strayKey = await settlePendingGrants(w.address);

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
      registration = {
        walletRegistered: reg.value.walletRegistered,
        nextGrantFeeCelo: reg.value.nextGrantValue,
        perKeyFeeCelo: (reg.value.feePerKey * REGISTRATION_VALUE_PERCENT) / 100n,
      };
      last.registration = registration;
    } else if (!registration) {
      notices.push("The Altana registration fee could not be read from Celo right now.");
    }

    let identity = last.identity ?? null;
    if (ident.status === "fulfilled") {
      const cached = window.localStorage.getItem(agentIdKey(w.address));
      identity = last.identity = { registered: ident.value > 0n, ...(ident.value > 0n && cached ? { agentId: cached } : {}) };
    }

    let view = last.view ?? null;
    if (srv.status === "fulfilled") view = last.view = srv.value;
    else if (view) notices.push("The Autumn server could not be reached. Plan details and the agent's log may be out of date.");
    else {
      // Without the server the wallet still works: balances come from Celo and "Send out" needs only the passkey and the relay.
      view = { plans: [], runLog: [] };
      notices.push(`The Autumn server could not be reached (${errText(srv.reason)}). Plans and the agent's log are not shown; your balances and "Send funds out" still work.`);
    }

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
      const ids = sessionKeyIds(planView.sessionPublicKey);
      plan = {
        proof: {
          publicKey: ids.publicKey,
          keyId: ids.keyId,
          keyHash: ids.keyHash,
          calls: [
            { label: "USD₮.approve", contract: USDT },
            { label: "GoldBuyer.buy", contract: cfg.goldBuyer },
            { label: "Altana Orchestrator (any function)", contract: ALTANA_ORCHESTRATOR },
          ],
          callsNote: ORCHESTRATOR_ENTRY_TEXT,
        },
        amount: BigInt(planView.amountPerBuy),
        period: planView.period,
        buyTheDip: planView.dipBuy,
        startedAt: new Date((planFacts?.timestamp ?? planView.createdAt) * 1000),
        nextPurchaseAt: nextPurchaseFor(planView, purchases, nowSecs, agent),
        limits,
        ...(planView.grantTxHash ? { txHash: planView.grantTxHash as TxHash } : {}),
      };
    }

    if (identity?.registered && !identity.agentId && granted.length) {
      const agentId = await findAgentId(w.address, granted).catch(() => null);
      if (agentId !== null) identity = last.identity = { registered: true, agentId };
    }

    const activity = buildActivity([purchaseItems(purchases, view.plans), runLogItems(view.runLog), planItems(view.plans, facts)]);
    return { wallet, balances, registration, price, plan, agent, activity, identity, fees, strayKey, notices };
  }

  /** The ERC-8004 agent id, from the registry's mint right after a plan's grant; cached once found. */
  let agentIdSearched = false;
  async function findAgentId(wallet: Address, plans: readonly PlanView[]): Promise<string | null> {
    if (agentIdSearched) return null;
    agentIdSearched = true;
    const head = await pinnedBlock(pub);
    for (const p of plans) {
      if (p.createdBlock === null) continue;
      const from = BigInt(p.createdBlock);
      const to = from + AGENT_ID_SEARCH_BLOCKS < head ? from + AGENT_ID_SEARCH_BLOCKS : head;
      const id = await readAgentIdMinted(pub, wallet, from, to, cfg.logBlockRange);
      if (id !== null) {
        window.localStorage.setItem(agentIdKey(wallet), id.toString());
        return id.toString();
      }
    }
    return null;
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

    // 3. Remember the key before the passkey prompt: if the tab closes during the grant, the next visit finds it onchain.
    const pending: StoredPending = {
      planId: created.planId,
      wallet: wallet.address,
      publicKey: created.sessionPublicKey,
      expected,
      plan: { amountPerBuy: input.amount.toString(), period: input.period, dipBuy: input.buyTheDip, expiresAt },
      createdAt: Date.now(),
    };
    savePending(pending);
    confirming.add(created.planId);
    try {
      return await grantAndActivate(created, grant, expected, pending);
    } finally {
      confirming.delete(created.planId);
    }
  }

  async function grantAndActivate(created: CreatePlanResponse, grant: SessionGrant, expected: SerializedSession, pending: StoredPending): Promise<Plan> {
    const { wallet, signer } = admin();
    // The passkey grants the session (and pays the KeyStore registration in CELO).
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
    if (!txHash) throw new Error("The grant returned no transaction. Autumn will check the chain for the agent's key on your next visit.");
    savePending({ ...pending, txHash });

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
      let revoked = false;
      try {
        await revokeKey(created.sessionPublicKey);
        const s = await waitForSession({ wallet: wallet.address, publicKey: created.sessionPublicKey }, (x) => x.status !== "active", 60_000);
        revoked = !!s && s.status !== "active";
      } catch {
        /* reported below */
      }
      // Kept until the chain shows the key gone: Home then offers to revoke it.
      if (revoked) dropPending(created.planId);
      throw new Error(
        `The plan was not started: ${mismatch}. ` +
          (revoked ? "The agent's key was revoked." : "The agent's key may still be live: Autumn shows a button to revoke it."),
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
    dropPending(created.planId);

    // 6. ERC-8004: the SDK does not register a passkey wallet by itself. One more prompt, never fatal.
    try {
      if ((await readAgentIdentityCount(pub, wallet.address)) === 0n) {
        const outcome = await sdkClient().registerAgentIdentity({ wallet, signer, feeToken: [USDT, NATIVE_TOKEN], chainId: CELO_CHAIN_ID });
        if (outcome.status === "registered") window.localStorage.setItem(agentIdKey(wallet.address), outcome.agentId);
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

  async function revokeStrayKey(): Promise<{ txHash?: TxHash }> {
    assertPasskeyOrigin();
    const { wallet } = admin();
    const stray = await settlePendingGrants(wallet.address);
    if (!stray) throw new Error("There is no unused agent key to revoke.");
    const txHash = await revokeKey(stray.publicKey);
    const s = await waitForSession({ wallet: wallet.address, publicKey: stray.publicKey }, (x) => x.status !== "active", 90_000);
    if (!s || s.status === "active") throw new Error("Celo does not show the revoke yet. Check again in a minute.");
    for (const p of loadPendings()) if (p.publicKey.toLowerCase() === stray.publicKey.toLowerCase()) dropPending(p.planId);
    emit();
    return txHash ? { txHash } : {};
  }

  /** Fee tokens to offer the relay for a send, first choice first: CELO sends pay in CELO, token sends in USD₮. */
  const sendFeeTokens = (asset: SendAsset) => (asset === "CELO" ? [NATIVE_TOKEN, USDT] : [USDT, NATIVE_TOKEN]);
  const balanceOf = (b: Awaited<ReturnType<typeof readBalances>>, asset: SendAsset) =>
    asset === "USDT" ? b.usdt : asset === "XAUT0" ? b.xaut0 : b.celo;

  async function quoteSend(req: { asset: SendAsset; to?: Address; amount?: bigint }): Promise<SendQuote> {
    const { wallet, signer } = admin();
    const b = await readBalances(pub, wallet.address);
    const amount = req.amount && req.amount > 0n ? req.amount : 1n;
    const call = buildSendCall(req.asset, req.to ?? QUOTE_PLACEHOLDER_TO, amount);
    const q = await sdkClient().quoteExecute({ wallet, signer, calls: [call], feeToken: sendFeeTokens(req.asset), chainId: CELO_CHAIN_ID, agentIdentity: false });
    const registrationCelo = q.value > call.value ? q.value - call.value : 0n;
    const native = q.feeToken.toLowerCase() === NATIVE_TOKEN.toLowerCase();
    return {
      fee: q.fee,
      feeSymbol: native ? "CELO" : "USD₮",
      registrationCelo,
      max: maxSendable(req.asset, balanceOf(b, req.asset), { fee: q.fee, feeToken: q.feeToken, extraNative: registrationCelo }),
    };
  }

  async function send(req: SendRequest): Promise<SendResult> {
    assertPasskeyOrigin();
    const { wallet, signer } = admin();
    const dest = checkDestination(req.to, { wallet: wallet.address, contracts: [cfg.goldBuyer] });
    if (!dest.ok) throw new Error(dest.problem);
    const call = buildSendCall(req.asset, dest.address, req.amount);
    const r = await sdkClient().execute({ wallet, signer, calls: [call], feeToken: sendFeeTokens(req.asset), chainId: CELO_CHAIN_ID, agentIdentity: false });
    if (r.status !== "CONFIRMED" || !r.transactionHash) {
      throw new Error(
        r.status === "FAILED"
          ? "The transfer reverted onchain, so nothing was sent. Your funds are still in your wallet."
          : "The relay has not confirmed the transfer yet. Check your balance on Celoscan before trying again.",
      );
    }
    const txHash = r.transactionHash as TxHash;
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error("The transaction reverted onchain, so nothing was sent.");
    // From here the transaction is onchain. A read that fails must never be reported as "not sent": the public
    // node often cannot serve the newest block yet ("block is out of range"), so retry, then say what is known.
    const read = async <T,>(fn: () => Promise<T>): Promise<T> => {
      let lastError: unknown;
      for (let i = 0; i < 12; i++) {
        try {
          return await fn();
        } catch (e) {
          lastError = e;
          await sleep(1500);
        }
      }
      throw new SendSubmittedError(txHash, lastError);
    };
    // The relay's transaction can succeed while the intent inside it fails: check the balance actually moved.
    const [before, after] = await read(() =>
      Promise.all([
        readBalances(pub, wallet.address, receipt.blockNumber - 1n),
        readBalances(pub, wallet.address, receipt.blockNumber),
      ]),
    );
    if (balanceOf(before, req.asset) - balanceOf(after, req.asset) < req.amount) {
      throw new Error(`Celo shows the transaction (${txHash}) but not the transfer. Nothing may have been sent; check it on Celoscan.`);
    }
    let now = await read(() => readBalances(pub, wallet.address));
    for (let i = 0; i < 10 && now.blockNumber < receipt.blockNumber; i++) {
      await sleep(1500);
      now = await read(() => readBalances(pub, wallet.address));
    }
    const block = await pub.getBlock({ blockNumber: now.blockNumber }).catch(() => null);
    const balances: Balances = { usdt: now.usdt, gold: now.xaut0, celo: now.celo, observedAt: block ? new Date(Number(block.timestamp) * 1000) : new Date() };
    last.balances = balances;
    emit();
    return { txHash, balances };
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
    async createWallet(options?: { mode?: CreationMode }) {
      assertPasskeyOrigin();
      if (!hasWebAuthn()) throw unsupportedPasskeys("create");
      // residentKey "preferred" instead of porto's "required", or the device-bound request when the browser reports no
      // passkey provider or the owner chose it: see passkey.ts. Everything else porto sets is kept.
      const kind = chooseRequestKind(options?.mode ?? "auto", await platformCapabilities(), { android: isAndroid() });
      let discoverable: Discoverable = "unknown";
      const createFn = selectionCreateFn(browserCreateFn(), kind, (d) => (discoverable = d));
      let w: Awaited<ReturnType<Client["createPasskeyWallet"]>>;
      try {
        w = await sdkClient().createPasskeyWallet({
          name: "Autumn",
          rpId: cfg.rpId,
          webAuthn: { createFn: createFn as NonNullable<PasskeyWebAuthnFns["createFn"]> },
        });
      } catch (e) {
        throw passkeyFailure(e, "create") ?? e;
      }
      const wallet = await remember(w.address as Address, w.signer.credential, discoverable);
      emit();
      return wallet;
    },
    async restoreWallet() {
      assertPasskeyOrigin();
      if (!hasWebAuthn()) throw unsupportedPasskeys("find");
      let w: Awaited<ReturnType<Client["recoverFromPasskey"]>>;
      try {
        w = await sdkClient().recoverFromPasskey({ rpId: cfg.rpId, chainId: CELO_CHAIN_ID });
      } catch (e) {
        throw passkeyFailure(e, "find") ?? e;
      }
      // Found from the passkey alone, so it is discoverable.
      const wallet = await remember(w.address as Address, w.signer.credential, true);
      emit();
      return wallet;
    },
    async getBackupCode() {
      await reconcile();
      const w = storedWallet();
      if (!w) throw new Error("There is no wallet on this device yet.");
      const cred = w.credential as WebAuthnCredential;
      if (cred.kind !== "webauthn") throw new Error("This wallet's key is not a device passkey.");
      return encodeBackupCode({ wallet: w.address, credentialId: cred.id, publicKey: cred.publicKey, rpId: cred.rpId ?? cfg.rpId, discoverable: discoverableOf(w) });
    },
    async restoreFromBackupCode(code: string) {
      assertPasskeyOrigin();
      const d = decodeBackupCode(code);
      if (d.rpId !== cfg.rpId) {
        throw new BackupCodeError(`This backup code is for a passkey on ${d.rpId}. This app uses passkeys on ${cfg.rpId}.`);
      }
      await reconcile();
      const current = storedWallet();
      if (current && current.address.toLowerCase() !== d.wallet.toLowerCase()) {
        throw new Error(`This browser already holds another Autumn wallet (${current.address}). Nothing was changed.`);
      }
      await assertAdminKey(d.wallet, d.publicKey);
      const credential: PasskeyCredential = { kind: "webauthn", id: d.credentialId, publicKey: d.publicKey, rpId: d.rpId };
      const wallet = await remember(d.wallet, credential, d.discoverable);
      last.balances = undefined;
      last.view = undefined;
      emit();
      return wallet;
    },
    confirmPlan,
    stopAgent,
    revokeStrayKey,
    quoteSend,
    send,
  };
}

export type { PlanView };
