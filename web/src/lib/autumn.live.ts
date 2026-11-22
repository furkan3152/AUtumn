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
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress, toHex, type Hex } from "viem";
import {
  XAUT0,
  USDT,
  buildSendCall,
  buildSwapCalls,
  checkDestination,
  checkSwapLogs,
  decodeSwapCalls,
  erc20Abi,
  lowestAllowedMinOut,
  quoteCeloToUsdt,
  swapFeeInUsdt,
  CELO_TOKEN,
  SWAP_ROUTER_02,
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
import { agentStatusFor, buildActivity, currentPlan, mergePurchases, nextPurchaseFor, planItems, purchaseItems, runLogItems, runLogPurchases } from "./activity";
import { ApiError, activateVerdict, backoffDelays, checkGrantOnchain } from "./pending";
import {
  CheckAgainError,
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
  type SwapQuote,
  type SwapRequest,
  type SwapResult,
  type TxHash,
  type Wallet,
  SwapUnavailableError,
  swapKeepAndMax,
} from "./autumn";
import { usdt as usdtText } from "./format";
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
  /**
   * When the passkey prompt for this grant was opened and did not end in a cancelled prompt: the grant may have been
   * signed and sent even without a transaction hash (the relay was slow, the tab closed). Such a key is never granted
   * again until the chain has settled it.
   */
  sentAt?: number;
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

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : {},
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      cache: "no-store",
    });
    text = await res.text();
  } catch {
    throw new ApiError(0, "The Autumn server could not be reached.", "network");
  }
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    throw new ApiError(res.status, typeof body.error === "string" ? body.error : `The Autumn server answered ${res.status}.`, typeof body.code === "string" ? body.code : undefined, body);
  }
  return data as T;
}

/** USD₮ base units per whole CELO, from the directory's rate. */
const celoToUsdtUnit = (rate: { numerator: bigint; denominator: bigint }) => (10n ** 18n * rate.numerator) / rate.denominator / 10n ** 12n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The transfer may be on its way: never "not sent", never a second send. */
const sendPending = (ref: { txHash?: TxHash; callsId?: string }, what: string) =>
  new CheckAgainError(
    "send",
    `${what} Do not send again: ${ref.txHash ? "check the transaction on Celoscan, or" : "the relay is still working on it;"} tap "Check again" in a minute.`,
    ref,
  );
/** The conversion may be on its way: never "not converted", never a second conversion. */
const swapPending = (ref: { txHash?: TxHash; callsId?: string }, what: string) =>
  new CheckAgainError(
    "swap",
    `${what} Do not convert again: ${ref.txHash ? "check the transaction on Celoscan, or" : "the relay is still working on it;"} tap "Check again" in a minute.`,
    ref,
  );
const SWAP_UNREADABLE = "Celo's reference rate or the pool's quote could not be read right now, so converting is unavailable. Nothing was sent. Try again in a minute.";
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
  /** A stop in progress: kept (with its revoke's hash) until the chain shows the key revoked, so it is never sent twice. */
  let stopping: { txHash?: TxHash; planId?: string; publicKey?: `0x${string}`; wallet?: Address; startedAt: number } | null = null;
  let goldBuyerHasCode: boolean | null = null;
  let serverMode: { configured: boolean; live: boolean } | null = null;
  const last: {
    price?: GoldPrice;
    balances?: Balances;
    registration?: Registration;
    view?: WalletView;
    sessions: Map<string, { state: SessionState; at: Date }>;
    identity?: AutumnState["identity"];
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

  /**
   * A discoverable passkey whose wallet has not transacted yet: the user handle names the wallet, and the Altana
   * relay's record of its first transaction names the admin key. The key is taken only when the relay lists exactly
   * one passkey admin key whose hash matches it. Otherwise it cannot be rebuilt without data saved earlier: the
   * backup code is the way back in.
   */
  async function restoreBeforeFirstTransaction(wallet: Address, credentialId: string): Promise<{ address: Address; credential: PasskeyCredential }> {
    let keys: Awaited<ReturnType<typeof relayAdminKeys>>;
    try {
      keys = await relayAdminKeys(wallet);
    } catch {
      throw new Error(
        `Your passkey belongs to wallet ${wallet}, which has not made a transaction yet. Its key is read from the Altana relay, which could not be reached. Try again in a minute, or restore with your backup code.`,
      );
    }
    const admins = keys.filter(
      (k) => k.type === "webauthnp256" && k.role === "admin" && /^0x[0-9a-fA-F]{128}$/.test(k.publicKey ?? "") && k.hash?.toLowerCase() === webAuthnKeyHash(k.publicKey as Hex).toLowerCase(),
    );
    if (admins.length !== 1) {
      throw new Error(
        `Your passkey belongs to wallet ${wallet}, which has not made a transaction yet, and its key cannot be found without data this browser no longer has. Restore with your backup code instead.`,
      );
    }
    return { address: getAddress(wallet), credential: { kind: "webauthn", id: credentialId, publicKey: admins[0]!.publicKey as Hex, rpId: cfg.rpId } };
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

  type PurchaseCache = { from: string; to: string; items: SerializedPurchase[] };
  const revive = (p: SerializedPurchase): Purchase => ({
    ...p,
    amountIn: BigInt(p.amountIn),
    out: BigInt(p.out),
    priceUsdtPerXaut: BigInt(p.priceUsdtPerXaut),
    blockNumber: BigInt(p.blockNumber),
  });
  /** Purchases saved by earlier scans (possibly partial), for showing while a scan runs or after it failed. */
  const cachedPurchases = (wallet: Address): Purchase[] => (loadJson<PurchaseCache>(purchasesKey(cfg.goldBuyer, wallet))?.items ?? []).map(revive);

  /**
   * GoldBuyer purchases by the wallet from `fromBlock`, scanned incrementally. Progress is saved after every batch of
   * log windows (blocks below the reorg margin), so a scan that fails or is interrupted resumes where it stopped.
   */
  async function readWalletPurchases(wallet: Address, fromBlock: bigint): Promise<Purchase[]> {
    const key = purchasesKey(cfg.goldBuyer, wallet);
    const cached = loadJson<PurchaseCache>(key);
    const head = await pinnedBlock(pub);
    let items: Purchase[] = [];
    let scanFrom = fromBlock;
    let cacheFrom = fromBlock;
    if (cached && BigInt(cached.from) <= fromBlock && BigInt(cached.to) < head) {
      items = cached.items.map(revive);
      scanFrom = BigInt(cached.to) + 1n;
      cacheFrom = BigInt(cached.from);
    }
    const cacheTo = head > CACHE_MARGIN ? head - CACHE_MARGIN : 0n;
    const found: Purchase[] = [];
    const save = (to: bigint) => {
      const upTo = to < cacheTo ? to : cacheTo;
      if (upTo < scanFrom - 1n) return;
      try {
        saveJson(key, { from: cacheFrom.toString(), to: upTo.toString(), items: [...items, ...found].filter((p) => p.blockNumber <= upTo) });
      } catch {
        /* storage full or blocked: the scan still returns its result */
      }
    };
    if (scanFrom <= head) {
      await readPurchases(pub, {
        goldBuyer: cfg.goldBuyer,
        buyer: wallet,
        fromBlock: scanFrom,
        toBlock: head,
        blockRange: cfg.logBlockRange,
        onBatch: (to, ps) => {
          found.push(...ps);
          save(to);
        },
      });
    }
    return [...items, ...found];
  }

  /** One purchase scan at a time per page; getState waits for it briefly and shows partial history meanwhile. */
  let scan: { wallet: string; done: Promise<void> } | null = null;
  let scanResult: { wallet: string; purchases: Purchase[] } | null = null;
  function startScan(wallet: Address, fromBlock: bigint): Promise<void> {
    if (scan && scan.wallet === wallet.toLowerCase()) return scan.done;
    const done = readWalletPurchases(wallet, fromBlock).then(
      (purchases) => {
        scanResult = { wallet: wallet.toLowerCase(), purchases };
      },
      () => {
        /* the notice comes from getState; saved progress is kept */
      },
    );
    const entry = { wallet: wallet.toLowerCase(), done };
    scan = entry;
    void done.finally(() => {
      if (scan === entry) scan = null;
    });
    return done;
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

  /** POST /api/plans/:id/activate, retried with backoff while the answer is "try again" (activateVerdict) and time is left. */
  async function activate(planId: string, session: SerializedSession, txHash: TxHash | undefined, budgetMs: number): Promise<void> {
    const delays = backoffDelays(budgetMs);
    for (let i = 0; ; i++) {
      try {
        await api(`/api/plans/${planId}/activate`, { method: "POST", body: { session, ...(txHash ? { grantTxHash: txHash } : {}) } });
        return;
      } catch (e) {
        if (activateVerdict(e) === "retry" && i < delays.length) {
          await sleep(delays[i]!);
          continue;
        }
        throw e;
      }
    }
  }

  type Settled = { stray: { publicKey: `0x${string}`; reason: string } | null; started: boolean; waiting: CheckAgainError | null };
  const grantNotVisible = (txHash?: TxHash) =>
    new CheckAgainError(
      "plan",
      "Your passkey approved the agent's key, but Celo does not show it yet. Autumn will not ask you to approve or pay again: check again in a minute.",
      txHash ? { txHash } : {},
    );
  const serverNotStarted = (txHash?: TxHash) =>
    new CheckAgainError(
      "plan",
      "The agent's key is granted, but the Autumn server has not started the plan yet. Nothing more will be paid: check again in a minute.",
      txHash ? { txHash } : {},
    );

  /**
   * Agent keys this browser asked to grant (saved before the passkey prompt), settled from the chain: granted ones
   * are handed to the server (with retries for `budgetMs`); a key is called stray only when a successful read proves
   * it cannot run its plan (other limits onchain, or the server's definite answer); ones never granted are
   * forgotten after the give-up window. A live key is never forgotten, and an unclear answer leaves it waiting.
   */
  async function settlePendingGrants(wallet: Address, opts: { budgetMs?: number } = {}): Promise<Settled> {
    const out: Settled = { stray: null, started: false, waiting: null };
    for (const p of loadPendings()) {
      if (p.wallet.toLowerCase() !== wallet.toLowerCase() || confirming.has(p.planId)) continue;
      const inFlight = !!(p.txHash || p.sentAt);
      let s: SessionState;
      try {
        s = await readSessionState(pub, { wallet, publicKey: p.publicKey });
      } catch {
        // Unknown: keep it, check again on the next refresh.
        if (inFlight) out.waiting ??= new CheckAgainError("plan", "Celo could not be read to check the agent's key. Nothing was sent again: check again in a minute.", p.txHash ? { txHash: p.txHash } : {});
        continue;
      }
      if (s.status !== "active") {
        // Not on the account (never granted, or revoked) or expired: nothing live to look after.
        if (s.onAccount || s.status === "expired" || Date.now() - (p.sentAt ?? p.createdAt) > PENDING_GIVE_UP_MS) dropPending(p.planId);
        else if (inFlight) out.waiting ??= grantNotVisible(p.txHash);
        continue;
      }
      // The key is live. It must be a plain session key with exactly the plan's limits (read just now), or it is stray.
      if (p.plan.amountPerBuy !== "0") {
        let check: ReturnType<typeof checkGrantOnchain>;
        try {
          const grant = planToSessionGrant(
            { amountPerBuy: BigInt(p.plan.amountPerBuy), period: p.plan.period, dipBuy: p.plan.dipBuy, expiresAt: p.plan.expiresAt },
            cfg.goldBuyer,
            s.blockTimestamp,
          );
          check = checkGrantOnchain(s, grant, cfg.goldBuyer);
        } catch (e) {
          check = { kind: "mismatch", reason: errText(e) };
        }
        if (check.kind === "mismatch") {
          out.stray = { publicKey: p.publicKey, reason: `its onchain limits are not the plan's: ${check.reason}` };
          continue;
        }
      }
      try {
        await activate(p.planId, p.expected, p.txHash, opts.budgetMs ?? 0);
        dropPending(p.planId);
        last.view = undefined;
        out.started = true;
      } catch (e) {
        const verdict = activateVerdict(e);
        if (verdict === "stray") out.stray = { publicKey: p.publicKey, reason: `the Autumn server cannot start a plan with it (${errText(e)})` };
        else out.waiting ??= verdict === "retry" ? serverNotStarted(p.txHash) : new CheckAgainError("plan", `The Autumn server did not start the plan: ${errText(e)}.`, p.txHash ? { txHash: p.txHash } : {});
      }
    }
    return out;
  }

  /** One read at a time: a call while one runs shares it (actions that need a newer read use freshState). */
  let stateFlight: Promise<AutumnState> | null = null;
  function getState(): Promise<AutumnState> {
    return (stateFlight ??= readState().finally(() => {
      stateFlight = null;
    }));
  }

  /**
   * With no wallet on this device the landing must show at once: its price and fee figures are read in the
   * background (at most once per poll interval) and shown when they arrive.
   */
  let landingReadAt = 0;
  let landingRead: Promise<void> | null = null;
  function landingState(): AutumnState {
    if (!landingRead && Date.now() - landingReadAt > POLL_MS - 1000) {
      landingReadAt = Date.now();
      landingRead = (async () => {
        await Promise.allSettled([
          readPoolState(pub).then((pool) => {
            last.price = { usdtPerOunce: pool.midUsdtPerXaut, observedAt: new Date(pool.blockTimestamp * 1000), priceCheckAvailable: pool.twapAvailable };
          }),
          Promise.all([readCeloUsdtRate(pub), pub.getGasPrice()]).then(([rate, gasPrice]) => {
            last.fees = { usdtPerCelo: celoToUsdtUnit(rate), relayFeeEstimate: estimateRelayFeeUsdt(gasPrice, rate), observedAt: new Date() };
          }),
          // What a new wallet's first plan would pay: no keys registered yet (the KeyStore has none for this placeholder address).
          readRegistration(pub, "0x0000000000000000000000000000000000000001").then((r) => {
            last.registration = { walletRegistered: false, nextGrantFeeCelo: r.nextGrantValue, perKeyFeeCelo: (r.feePerKey * REGISTRATION_VALUE_PERCENT) / 100n };
          }),
        ]);
      })().finally(() => {
        landingRead = null;
        emit();
      });
    }
    const notices = landingReadAt && !landingRead && !last.price ? ["The gold price could not be read from Celo right now."] : [];
    return {
      wallet: null, balances: null, registration: last.registration ?? null, price: last.price ?? null, plan: null, agent: { kind: "none" },
      activity: [], identity: null, fees: last.fees ?? null, strayKey: null, notices,
    };
  }

  async function readState(): Promise<AutumnState> {
    const notices: string[] = [];
    await reconcile();
    const w = storedWallet();
    if (!w) return landingState();

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

    const wallet: Wallet = { address: w.address, createdAt: new Date(w.createdAt), passkey: { discoverable: discoverableOf(w) } };

    if (serverMode === null) {
      serverMode = await api<{ configured: boolean; live: boolean }>("/api/health").catch(() => null);
    }
    if (serverMode && !serverMode.configured) notices.push("The Autumn server is not configured, so no agent runs for this app.");
    else if (serverMode && !serverMode.live) notices.push("The agent runs in dry-run mode on this server: it decides but sends no purchases.");

    const { stray: strayKey } = await settlePendingGrants(w.address);

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
    if (identity && !identity.registered && identityError) identity = { ...identity, lastError: identityError };

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

    // Purchase history: the server's run log (every purchase the agent made) first, the chain's GoldBuyer events to
    // fill gaps and confirm. The scan runs in the background with saved progress; it is awaited only briefly.
    const granted = view.plans.filter((p) => p.status !== "pending_grant");
    let chainPurchases: Purchase[] = scanResult?.wallet === w.address.toLowerCase() ? scanResult.purchases : cachedPurchases(w.address);
    let scanComplete = scanResult?.wallet === w.address.toLowerCase();
    if (granted.length) {
      const fromBlock = granted.reduce<bigint>(
        (min, p) => (p.createdBlock !== null && BigInt(p.createdBlock) < min ? BigInt(p.createdBlock) : min),
        BigInt(granted[0]!.createdBlock ?? cfg.goldBuyerDeployBlock),
      );
      const before = scanResult;
      const done = startScan(w.address, fromBlock > cfg.goldBuyerDeployBlock ? fromBlock : cfg.goldBuyerDeployBlock);
      const finished = await Promise.race([done.then(() => true), sleep(4000).then(() => false)]);
      if (finished && scanResult !== before && scanResult?.wallet === w.address.toLowerCase()) {
        chainPurchases = scanResult.purchases;
        scanComplete = true;
      } else if (finished) {
        notices.push("Purchases could not be read from Celo right now. The list may be incomplete.");
        chainPurchases = scanResult?.wallet === w.address.toLowerCase() ? scanResult.purchases : cachedPurchases(w.address);
      } else {
        void done.then(emit); // show the full history when the scan ends
      }
    } else scanComplete = true;
    // The run log is complete when the server sent fewer entries than its page size (100).
    const logComplete = srv.status === "fulfilled" && view.runLog.length < 100;
    const purchases = mergePurchases(chainPurchases, runLogPurchases(view.runLog, w.address));
    last.purchases = purchases;
    const historyKnown = scanComplete || logComplete;

    const agent = agentStatusFor({ plan: planView, chainStatus: session?.status ?? null, stopping: stopping && (!stopping.planId || stopping.planId === planView?.id) ? stopping : null, facts });
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
        nextPurchaseAt: historyKnown ? nextPurchaseFor(planView, purchases, nowSecs, agent) : null,
        historyLoading: !historyKnown && agent.kind === "active",
        limits,
        ...(planView.grantTxHash ? { txHash: planView.grantTxHash as TxHash } : {}),
      };
    }

    if (identity?.registered && !identity.agentId && granted.length && !agentIdSearched) {
      // In the background: the registry is not enumerable, so the id comes from its mint event.
      void findAgentId(w.address, granted)
        .then((id) => {
          if (id !== null) {
            last.identity = { registered: true, agentId: id };
            emit();
          }
        })
        .catch(() => undefined);
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
    // Right after each plan's grant first (where the old flow registered), then everything since the oldest plan
    // (the identity can also be registered later from the "Register identity" button).
    const starts = plans.map((p) => p.createdBlock).filter((b): b is string => b !== null).map(BigInt);
    const ranges: [bigint, bigint][] = starts.map((from) => [from, from + AGENT_ID_SEARCH_BLOCKS < head ? from + AGENT_ID_SEARCH_BLOCKS : head]);
    if (starts.length) ranges.push([starts.reduce((a, b) => (b < a ? b : a)), head]);
    for (const [from, to] of ranges) {
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

  /** Reads the state after an action: waits for a read already running (it may predate the action), then reads again. */
  async function freshState(): Promise<AutumnState> {
    await stateFlight?.catch(() => undefined);
    return getState();
  }

  /** After a plan was started: the running plan, read back from the chain and the server. */
  async function planAfterStart(): Promise<Plan> {
    last.view = undefined;
    emit();
    const notYet = () => new CheckAgainError("plan", "The plan started, but it could not be read back yet. Check again in a few seconds.");
    let state: AutumnState;
    try {
      state = await freshState();
    } catch {
      throw notYet();
    }
    if (!state.plan || state.agent.kind !== "active") throw notYet();
    return state.plan;
  }

  let confirmFlight: Promise<Plan> | null = null;
  function confirmPlan(input: PlanInput): Promise<Plan> {
    return (confirmFlight ??= doConfirmPlan(input).finally(() => {
      confirmFlight = null;
    }));
  }

  async function doConfirmPlan(input: PlanInput): Promise<Plan> {
    assertPasskeyOrigin();
    if (goldBuyerHasCode === false) throw new Error("GoldBuyer is not deployed at the configured address, so no plan can start.");
    const { wallet } = admin();
    const unit = 10n ** BigInt(DECIMALS.USDT);
    if (input.amount % unit !== 0n) throw new Error("Plans are whole USD₮ amounts.");
    const expiresAt = Math.floor(input.expiresAt.getTime() / 1000);

    // 0. A grant this browser already sent is settled first: a key the chain shows granted is started, never granted
    //    (and paid for) a second time; one that may still land makes the owner wait instead.
    const settled = await settlePendingGrants(wallet.address, { budgetMs: 30_000 });
    if (settled.started) return planAfterStart();
    if (settled.waiting) throw settled.waiting;

    // 1. The server makes the session key and keeps its private half. A retry with the same choices gets the same
    //    plan and key back; this browser has no grant in flight, so a different waiting plan may be replaced.
    let created: CreatePlanResponse;
    try {
      created = await api<CreatePlanResponse>("/api/plans", {
        method: "POST",
        body: { wallet: wallet.address, amountUsdt: Number(input.amount / unit), period: input.period, dipBuy: input.buyTheDip, expiresAt, replacePending: true },
      });
    } catch (e) {
      // A key for a waiting plan is granted onchain already (another tab or device): start that plan instead.
      if (e instanceof ApiError && e.code === "pending_plan_granted" && typeof e.body?.planId === "string" && e.body.expected) {
        try {
          await activate(e.body.planId, e.body.expected as SerializedSession, undefined, 45_000);
        } catch (err) {
          if (activateVerdict(err) === "retry") throw serverNotStarted();
          throw err;
        }
        return planAfterStart();
      }
      throw e;
    }

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
    const key = { wallet: wallet.address, publicKey: created.sessionPublicKey };
    // From the prompt on, the grant may be signed and sent even if this tab never hears back.
    const sent: StoredPending = { ...pending, sentAt: Date.now() };
    savePending(sent);
    // The passkey grants the session (and pays the KeyStore registration in CELO).
    let txHash: TxHash | undefined;
    try {
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
      txHash = result.transactionHash as TxHash | undefined;
      if (txHash) savePending({ ...sent, txHash });
    } catch (e) {
      const pk = passkeyFailure(e, "sign");
      if (pk) {
        // The prompt was closed: nothing was signed. A retry reuses this plan and key.
        savePending(pending);
        throw pk;
      }
      // Signed, and maybe sent (e.g. "Session grant did not confirm: pending" while the relay is slow): the chain decides.
      const s = await waitForSession(key, (x) => x.status === "active", 20_000);
      if (!s || s.status !== "active") throw grantNotVisible();
    }

    // 4. Before telling the server: the chain holds exactly the limits shown. Only a successful read that shows
    //    other limits is a mismatch; "not visible yet" or "could not read" is waiting, never a reason to revoke.
    const onchain = await waitForSession(key, (s) => s.status === "active" && s.spend.length > 0, 60_000);
    const check = checkGrantOnchain(onchain, grant, cfg.goldBuyer);
    if (check.kind === "unknown" || check.kind === "not_visible") throw grantNotVisible(txHash);
    if (check.kind === "mismatch") {
      let revoked = false;
      try {
        await revokeKey(created.sessionPublicKey);
        const s = await waitForSession(key, (x) => x.status !== "active", 60_000);
        revoked = !!s && s.status !== "active";
      } catch {
        /* reported below */
      }
      // Kept until the chain shows the key gone: Home then offers to revoke it.
      if (revoked) dropPending(created.planId);
      throw new Error(
        `The plan was not started: ${check.reason}. ` + (revoked ? "The agent's key was revoked." : "The agent's key may still be live: Autumn shows a button to revoke it."),
      );
    }

    // 5. Only now does the server activate it (it checks the chain again itself). Busy or unreachable: retried, then "check again".
    try {
      await activate(created.planId, expected, txHash, 60_000);
    } catch (e) {
      const verdict = activateVerdict(e);
      if (verdict === "retry") throw serverNotStarted(txHash);
      if (verdict === "stray") {
        throw new Error(`The plan was not started: ${errText(e)}. The agent's key is live: Autumn shows a button to revoke it.`);
      }
      throw e;
    }
    dropPending(created.planId);

    // 6. ERC-8004: the SDK does not register a passkey wallet by itself. One more prompt, never fatal: a failure is
    //    shown in "Onchain proof" with a "Register identity" button.
    await doRegisterIdentity().catch(() => undefined);
    return planAfterStart();
  }

  async function resumePlan(): Promise<Plan | null> {
    if (confirmFlight) return confirmFlight;
    const { wallet } = admin();
    const settled = await settlePendingGrants(wallet.address, { budgetMs: 30_000 });
    if (settled.started) return planAfterStart();
    if (settled.waiting) throw settled.waiting;
    const state = await freshState();
    return state.plan && state.agent.kind === "active" ? state.plan : null;
  }

  /* ---------- ERC-8004 agent identity ---------- */

  /** Why the last registration attempt in this page did not finish, in plain words; shown with the button. */
  let identityError: string | undefined;
  function identityFailureText(reason: string): string {
    if (/notallowed|not allowed|timed out|cancel|abort|denied/i.test(reason)) {
      return "The passkey prompt was closed or timed out, so the identity was not registered. Nothing was paid.";
    }
    if (/did not confirm/i.test(reason)) {
      return "The registration was sent but has not confirmed yet. Wait a minute before registering again: Autumn checks the registry first.";
    }
    if (/deficit|insufficient|not enough|balance/i.test(reason)) {
      return "The wallet does not hold enough USD₮ or CELO for the registration's network fee.";
    }
    return "The identity could not be registered right now (the relay did not accept it). Nothing was paid; try again later.";
  }

  let registerFlight: Promise<{ agentId: string | null; txHash?: TxHash }> | null = null;
  function registerIdentity() {
    return (registerFlight ??= (async () => {
      try {
        return await doRegisterIdentity();
      } finally {
        emit();
      }
    })().finally(() => {
      registerFlight = null;
    }));
  }

  /**
   * One `register` call in its own transaction, signed by the wallet's passkey with the same signer (and the same
   * device-bound getFn) as every other admin action. The registry is read first (a wallet that owns an identity is
   * never registered twice) and after (the chain is the proof).
   */
  async function doRegisterIdentity(): Promise<{ agentId: string | null; txHash?: TxHash }> {
    assertPasskeyOrigin();
    const { wallet, signer } = admin();
    const count = async () => {
      try {
        return await readAgentIdentityCount(pub, wallet.address);
      } catch {
        return null;
      }
    };
    const known = () => window.localStorage.getItem(agentIdKey(wallet.address));
    const before = await count();
    if (before === null) throw new Error((identityError = "Celo could not be read to check the agent's identity. Nothing was sent; try again."));
    if (before > 0n) {
      identityError = undefined;
      last.identity = { registered: true, ...(known() ? { agentId: known()! } : {}) };
      return { agentId: known() };
    }
    const outcome = await sdkClient().registerAgentIdentity({ wallet, signer, feeToken: [USDT, NATIVE_TOKEN], chainId: CELO_CHAIN_ID });
    if (outcome.status === "registered") {
      window.localStorage.setItem(agentIdKey(wallet.address), outcome.agentId);
      identityError = undefined;
      // Confirmed from the registry itself, a few reads at most (the public node can lag the relay by a block).
      for (let i = 0; i < 5; i++) {
        const n = await count();
        if (n !== null && n > 0n) break;
        await sleep(1500);
      }
      last.identity = { registered: true, agentId: outcome.agentId };
      return { agentId: outcome.agentId, ...(outcome.transactionHash ? { txHash: outcome.transactionHash as TxHash } : {}) };
    }
    if (outcome.status === "skipped" && outcome.reason === "already-registered") {
      identityError = undefined;
      last.identity = { registered: true };
      return { agentId: known() };
    }
    identityError = outcome.status === "skipped" ? "This network has no agent identity registry the wallet knows." : identityFailureText(outcome.reason);
    throw new Error(identityError);
  }

  /* ---------- Stop ---------- */

  let stopFlight: Promise<{ txHash?: TxHash }> | null = null;
  function stopAgent(): Promise<{ txHash?: TxHash }> {
    return (stopFlight ??= doStop().finally(() => {
      stopFlight = null;
    }));
  }

  const stopPending = (txHash?: TxHash) =>
    new CheckAgainError(
      "stop",
      txHash
        ? "The revoke was sent, but Celo does not show it yet. The agent may still be able to buy until it does. Check again in a minute: nothing will be sent twice."
        : "Autumn could not tell whether the revoke was sent, and Celo does not show it yet. Check again in a minute.",
      txHash ? { txHash } : {},
    );

  async function doStop(): Promise<{ txHash?: TxHash }> {
    assertPasskeyOrigin();
    // A revoke already sent is only ever checked, never sent again.
    if (stopping?.publicKey) return checkStop();
    stopping = { startedAt: Date.now() };
    emit();
    let plan: PlanView | null;
    try {
      const view = last.view ?? (await api<WalletView>(`/api/wallets/${admin().wallet.address}`));
      plan = currentPlan(view.plans);
      if (!plan) throw new Error("There is no plan to stop.");
    } catch (e) {
      stopping = null;
      emit();
      throw e;
    }
    stopping = { ...stopping, planId: plan.id, publicKey: plan.sessionPublicKey, wallet: plan.walletAddress };
    let txHash: TxHash | undefined;
    try {
      txHash = await revokeKey(plan.sessionPublicKey);
    } catch (e) {
      const pk = passkeyFailure(e, "sign");
      if (pk) {
        // The prompt was closed: nothing was signed or sent; stopping again is safe.
        stopping = null;
        emit();
        throw pk;
      }
      // Signed, maybe sent: from here only the chain can say (checkStop allows a new revoke after 3 minutes without one).
      emit();
      throw stopPending();
    }
    if (txHash) stopping = { ...stopping, txHash };
    emit();
    const s = await waitForSession({ wallet: plan.walletAddress, publicKey: plan.sessionPublicKey }, (x) => x.status !== "active", 90_000);
    if (!s || s.status === "active") throw stopPending(txHash);
    return finishStop(plan.id, txHash);
  }

  async function finishStop(planId: string, txHash?: TxHash): Promise<{ txHash?: TxHash }> {
    try {
      await api(`/api/plans/${planId}/stop`, { method: "POST", body: txHash ? { revokeTxHash: txHash } : {} });
    } catch {
      /* The chain already stops the agent; the runner also closes the plan when it sees the revoke. */
    }
    last.view = undefined;
    emit();
    return txHash ? { txHash } : {};
  }

  async function checkStop(): Promise<{ txHash?: TxHash }> {
    const st = stopping;
    if (!st?.publicKey || !st.wallet || !st.planId) {
      emit();
      return {};
    }
    let s: SessionState;
    try {
      s = await readSessionState(pub, { wallet: st.wallet, publicKey: st.publicKey });
    } catch {
      throw new CheckAgainError("stop", "Celo could not be read right now. Check again in a minute: nothing will be sent twice.", st.txHash ? { txHash: st.txHash } : {});
    }
    if (s.status !== "active") return finishStop(st.planId, st.txHash);
    // Still active. Stopping again is offered only when the chain proves the first revoke failed.
    if (st.txHash) {
      let receipt: Awaited<ReturnType<typeof pub.getTransactionReceipt>> | null = null;
      try {
        receipt = await pub.getTransactionReceipt({ hash: st.txHash });
      } catch {
        /* not mined yet, or not readable: still pending */
      }
      if (receipt && s.blockNumber >= receipt.blockNumber) {
        stopping = null;
        emit();
        throw new Error("The revoke transaction did not revoke the agent's key, so the agent is still running. You can stop it again.");
      }
      throw stopPending(st.txHash);
    }
    if (Date.now() - st.startedAt > 3 * 60_000) {
      stopping = null;
      emit();
      throw new Error("No revoke reached Celo, and the agent's key is still active. You can stop it again.");
    }
    throw stopPending();
  }

  let strayFlight: Promise<{ txHash?: TxHash }> | null = null;
  let strayRevoke: { publicKey: string; at: number; txHash?: TxHash } | null = null;
  function revokeStrayKey(): Promise<{ txHash?: TxHash }> {
    return (strayFlight ??= doRevokeStrayKey().finally(() => {
      strayFlight = null;
    }));
  }

  async function doRevokeStrayKey(): Promise<{ txHash?: TxHash }> {
    assertPasskeyOrigin();
    const { wallet } = admin();
    const { stray } = await settlePendingGrants(wallet.address);
    if (!stray) throw new Error("There is no unused agent key to revoke.");
    // A revoke of this key sent in the last 10 minutes is waited for, never sent again.
    const prior = strayRevoke && strayRevoke.publicKey === stray.publicKey.toLowerCase() && Date.now() - strayRevoke.at < 10 * 60_000 ? strayRevoke : null;
    const txHash = prior ? prior.txHash : await revokeKey(stray.publicKey);
    strayRevoke = { publicKey: stray.publicKey.toLowerCase(), at: prior?.at ?? Date.now(), ...(txHash ? { txHash } : {}) };
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

  let sendFlight: Promise<SendResult> | null = null;
  function send(req: SendRequest): Promise<SendResult> {
    return (sendFlight ??= doSend(req).finally(() => {
      sendFlight = null;
    }));
  }

  async function doSend(req: SendRequest): Promise<SendResult> {
    assertPasskeyOrigin();
    const { wallet, signer } = admin();
    const dest = checkDestination(req.to, { wallet: wallet.address, contracts: [cfg.goldBuyer] });
    if (!dest.ok) throw new Error(dest.problem);
    const call = buildSendCall(req.asset, dest.address, req.amount);
    let r: Awaited<ReturnType<Client["execute"]>>;
    try {
      r = await sdkClient().execute({ wallet, signer, calls: [call], feeToken: sendFeeTokens(req.asset), chainId: CELO_CHAIN_ID, agentIdentity: false });
    } catch (e) {
      const pk = passkeyFailure(e, "sign");
      if (pk) throw pk; // the prompt was closed: nothing was signed
      // A refusal before sending (fees, simulation) is "not sent". A dropped connection may have happened after the
      // relay accepted it: then only the balance can tell.
      if (/timed? ?out|fetch failed|network|load failed|aborted/i.test(errText(e))) {
        throw sendPending({}, "The connection to the relay dropped, so Autumn cannot tell whether the transfer was sent. Check your balance before sending again.");
      }
      throw e;
    }
    if (r.status === "FAILED") throw new Error("The transfer reverted onchain, so nothing was sent. Your funds are still in your wallet.");
    const ref = { ...(r.transactionHash ? { txHash: r.transactionHash as TxHash } : {}), callsId: r.callsId };
    if (r.status !== "CONFIRMED" || !r.transactionHash) throw sendPending(ref, "The relay accepted the transfer but has not confirmed it yet.");
    return confirmSent(req, wallet.address, r.transactionHash as TxHash, 120_000);
  }

  /**
   * From here the transaction exists. A read that fails must never be reported as "not sent": the public node often
   * cannot serve the newest block yet ("block is out of range"), so reads are retried, then what is known is said.
   */
  async function confirmSent(req: SendRequest, wallet: Address, txHash: TxHash, receiptMs: number): Promise<SendResult> {
    const pending = (what: string) => sendPending({ txHash }, what);
    const read = async <T,>(fn: () => Promise<T>): Promise<T> => {
      for (let i = 0; i < 12; i++) {
        try {
          return await fn();
        } catch {
          await sleep(1500);
        }
      }
      throw pending("The transfer was sent, but Celo's public node did not answer the balance check.");
    };
    // The receipt, with the same patience: not found yet, or the node not answering, is "pending", never "not sent".
    let receipt: Awaited<ReturnType<typeof pub.getTransactionReceipt>> | null = null;
    for (const until = Date.now() + receiptMs; !receipt; ) {
      try {
        receipt = await pub.getTransactionReceipt({ hash: txHash });
      } catch {
        if (Date.now() > until) throw pending("The transfer was sent, but Celo does not show it yet.");
        await sleep(2000);
      }
    }
    if (receipt.status !== "success") throw new Error("The transaction reverted onchain, so nothing was sent. Your funds are still in your wallet.");
    // The relay's transaction can succeed while the intent inside it fails: check the balance actually moved.
    const [before, after] = await read(() =>
      Promise.all([readBalances(pub, wallet, receipt.blockNumber - 1n), readBalances(pub, wallet, receipt.blockNumber)]),
    );
    if (balanceOf(before, req.asset) - balanceOf(after, req.asset) < req.amount) {
      throw pending("Celo shows the transaction but not the transfer in it. Check it on Celoscan.");
    }
    let now = await read(() => readBalances(pub, wallet));
    for (let i = 0; i < 10 && now.blockNumber < receipt.blockNumber; i++) {
      await sleep(1500);
      now = await read(() => readBalances(pub, wallet));
    }
    const block = await pub.getBlock({ blockNumber: now.blockNumber }).catch(() => null);
    const balances: Balances = { usdt: now.usdt, gold: now.xaut0, celo: now.celo, observedAt: block ? new Date(Number(block.timestamp) * 1000) : new Date() };
    last.balances = balances;
    emit();
    return { txHash, balances };
  }

  /** The relay's status of a call bundle: its code (1xx pending, 2xx confirmed, ≥300 failed) and transaction. */
  async function relayCallsStatus(callsId: string): Promise<{ code: number | null; txHash?: TxHash }> {
    const res = await fetch(network.relayUrl ?? RELAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wallet_getCallsStatus", params: [callsId] }),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as { result?: { status?: number | string; receipts?: { transactionHash?: string }[] } } | null;
    const st = data?.result?.status;
    const code = typeof st === "number" ? st : st === "CONFIRMED" ? 200 : st === "PENDING" ? 100 : null;
    const tx = data?.result?.receipts?.find((x) => x.transactionHash)?.transactionHash;
    return { code, ...(tx ? { txHash: tx as TxHash } : {}) };
  }

  async function checkSend(req: SendRequest, ref: { txHash?: TxHash; callsId?: string }): Promise<SendResult> {
    const { wallet } = admin();
    let txHash = ref.txHash;
    if (!txHash && ref.callsId) {
      let st: Awaited<ReturnType<typeof relayCallsStatus>>;
      try {
        st = await relayCallsStatus(ref.callsId);
      } catch {
        throw sendPending(ref, "The relay could not be reached to check the transfer.");
      }
      if (st.code !== null && st.code >= 300) throw new Error("The relay reports that the transfer failed, so nothing was sent. You can send again.");
      if (!st.txHash) throw sendPending(ref, "The relay is still working on the transfer.");
      txHash = st.txHash;
    }
    if (!txHash) throw sendPending({}, "Autumn has no transaction to check. Compare your balance with the amount before sending again.");
    return confirmSent(req, wallet.address, txHash, 15_000);
  }

  /* ---------- Converting CELO to USD₮ ---------- */

  /** The pool's quote for `amountIn` at block `bn`, checked against the reference rate. Unreadable or refused: unavailable. */
  async function checkedPoolQuote(amountIn: bigint, bn?: bigint) {
    let pq: Awaited<ReturnType<typeof quoteCeloToUsdt>>;
    try {
      pq = await quoteCeloToUsdt(pub, amountIn, bn !== undefined ? { blockNumber: bn } : {});
    } catch {
      throw new SwapUnavailableError("unreadable", SWAP_UNREADABLE);
    }
    if (!pq.ok) throw new SwapUnavailableError("price", `Converting is unavailable right now: ${pq.reason}. Nothing was sent.`);
    return pq as typeof pq & { ok: true; minOut: bigint };
  }

  async function quoteSwap(req: { amount?: bigint }): Promise<SwapQuote> {
    const { wallet, signer } = admin();
    let b: Awaited<ReturnType<typeof readBalances>>;
    let reg: Awaited<ReturnType<typeof readRegistration>>;
    try {
      const bn = await pinnedBlock(pub);
      [b, reg] = await Promise.all([readBalances(pub, wallet.address, bn), readRegistration(pub, wallet.address, bn)]);
    } catch {
      throw new SwapUnavailableError("unreadable", "Your CELO balance and Altana's registration fee could not be read from Celo right now. Try again in a minute.");
    }
    if (b.celo === 0n) throw new Error("The wallet holds no CELO to convert.");
    const probe = !(req.amount && req.amount > 0n);
    // Before an amount is entered, 1 CELO (or half the balance) stands in: the fee hardly depends on the amount.
    const amountIn = probe ? (b.celo >= 2n * 10n ** 18n ? 10n ** 18n : b.celo / 2n) : req.amount!;
    const pq = await checkedPoolQuote(amountIn, b.blockNumber);
    const calls = buildSwapCalls(wallet.address, amountIn, pq.minOut);
    // The fee in USD₮ when the wallet holds enough of it, otherwise in CELO.
    const quoteWith = (feeToken: Address) => sdkClient().quoteExecute({ wallet, signer, calls, feeToken, chainId: CELO_CHAIN_ID, agentIdentity: false });
    let q: Awaited<ReturnType<typeof quoteWith>> | null = null;
    if (b.usdt > 0n) {
      const inUsdt = await quoteWith(USDT).catch(() => null);
      if (inUsdt && inUsdt.feeToken.toLowerCase() === USDT.toLowerCase() && swapFeeInUsdt(b.usdt, inUsdt.fee)) q = inUsdt;
    }
    q ??= await quoteWith(NATIVE_TOKEN);
    if (q.fundedFromChainId !== undefined && q.fundedFromChainId !== CELO_CHAIN_ID) throw new Error("The relay offered to fund this from another chain. Autumn only converts on Celo; nothing was sent.");
    const native = q.feeToken.toLowerCase() === NATIVE_TOKEN.toLowerCase();
    const feeSymbol = native ? "CELO" : "USD₮";
    const registrationCelo = q.value; // the calls carry no value: anything here is the first-action registration
    const { keep, max } = swapKeepAndMax(b.celo, { walletRegistered: reg.walletRegistered, perKeyFeeCelo: (reg.feePerKey * REGISTRATION_VALUE_PERCENT) / 100n }, { fee: q.fee, feeSymbol, registrationCelo });
    return {
      amountIn,
      probe,
      expectedOut: pq.quotedOut,
      minOut: pq.minOut,
      referenceOut: pq.referenceOut,
      belowReferenceBps: pq.belowReferenceBps,
      fee: q.fee,
      feeSymbol,
      registrationCelo,
      keep,
      max,
      observedAt: new Date(),
    };
  }

  let swapFlight: Promise<SwapResult> | null = null;
  function swap(req: SwapRequest): Promise<SwapResult> {
    return (swapFlight ??= doSwap(req).finally(() => {
      swapFlight = null;
    }));
  }

  async function doSwap(req: SwapRequest): Promise<SwapResult> {
    assertPasskeyOrigin();
    const { wallet, signer } = admin();
    if (req.amountIn <= 0n || req.minOut <= 0n) throw new Error("Enter an amount above zero.");
    // A fresh quote right before signing: the price rules again, and the pool must still give the minimum shown.
    const pq = await checkedPoolQuote(req.amountIn);
    if (pq.quotedOut < req.minOut) {
      throw new Error(`The price moved: the pool now gives about ${usdtText(pq.quotedOut)} USD₮, less than the ${usdtText(req.minOut)} USD₮ minimum you reviewed. Nothing was sent. Review the new quote.`);
    }
    if (req.minOut < lowestAllowedMinOut(pq.referenceOut)) throw new Error("That minimum is lower than the price check allows. Nothing was sent.");
    const calls = buildSwapCalls(wallet.address, req.amountIn, req.minOut);
    decodeSwapCalls(calls, wallet.address); // exactly the two calls, paying this wallet
    let r: Awaited<ReturnType<Client["execute"]>>;
    try {
      r = await sdkClient().execute({ wallet, signer, calls, feeToken: req.feeSymbol === "CELO" ? NATIVE_TOKEN : USDT, chainId: CELO_CHAIN_ID, agentIdentity: false });
    } catch (e) {
      const pk = passkeyFailure(e, "sign");
      if (pk) throw pk; // the prompt was closed: nothing was signed
      if (/timed? ?out|fetch failed|network|load failed|aborted/i.test(errText(e))) {
        throw swapPending({}, "The connection to the relay dropped, so Autumn cannot tell whether the conversion was sent. Check your balances before converting again.");
      }
      throw e;
    }
    if (r.status === "FAILED") throw new Error("The conversion reverted onchain, so nothing was converted. Your CELO is still in your wallet.");
    const ref = { ...(r.transactionHash ? { txHash: r.transactionHash as TxHash } : {}), callsId: r.callsId };
    if (r.status !== "CONFIRMED" || !r.transactionHash) throw swapPending(ref, "The relay accepted the conversion but has not confirmed it yet.");
    return confirmSwapped(req, wallet.address, r.transactionHash as TxHash, 120_000);
  }

  /** From here the transaction exists: a failed read is "pending", never "not converted" (as confirmSent). */
  async function confirmSwapped(req: SwapRequest, wallet: Address, txHash: TxHash, receiptMs: number): Promise<SwapResult> {
    const pending = (what: string) => swapPending({ txHash }, what);
    const read = async <T,>(fn: () => Promise<T>): Promise<T> => {
      for (let i = 0; i < 12; i++) {
        try {
          return await fn();
        } catch {
          await sleep(1500);
        }
      }
      throw pending("The conversion was sent, but Celo's public node did not answer the check.");
    };
    let receipt: Awaited<ReturnType<typeof pub.getTransactionReceipt>> | null = null;
    for (const until = Date.now() + receiptMs; !receipt; ) {
      try {
        receipt = await pub.getTransactionReceipt({ hash: txHash });
      } catch {
        if (Date.now() > until) throw pending("The conversion was sent, but Celo does not show it yet.");
        await sleep(2000);
      }
    }
    if (receipt.status !== "success") throw new Error("The transaction reverted onchain, so nothing was converted. Your CELO is still in your wallet.");
    // The relay's transaction can succeed while the intent inside it fails: the pool's transfers must be in it.
    const check = checkSwapLogs(receipt.logs, { wallet, amountIn: req.amountIn, minOut: req.minOut });
    if (!check.ok) throw pending(`Celo shows the transaction, but not the expected conversion in it (${check.reason}). Check it on Celoscan.`);
    const allowanceLeft = await read(() =>
      pub.readContract({ address: CELO_TOKEN, abi: erc20Abi, functionName: "allowance", args: [wallet, SWAP_ROUTER_02], blockNumber: receipt.blockNumber }),
    );
    let now = await read(() => readBalances(pub, wallet));
    for (let i = 0; i < 10 && now.blockNumber < receipt.blockNumber; i++) {
      await sleep(1500);
      now = await read(() => readBalances(pub, wallet));
    }
    const block = await pub.getBlock({ blockNumber: now.blockNumber }).catch(() => null);
    const balances: Balances = { usdt: now.usdt, gold: now.xaut0, celo: now.celo, observedAt: block ? new Date(Number(block.timestamp) * 1000) : new Date() };
    last.balances = balances;
    emit();
    return { txHash, received: check.usdtOut, allowanceLeft, balances };
  }

  async function checkSwap(req: SwapRequest, ref: { txHash?: TxHash; callsId?: string }): Promise<SwapResult> {
    const { wallet } = admin();
    let txHash = ref.txHash;
    if (!txHash && ref.callsId) {
      let st: Awaited<ReturnType<typeof relayCallsStatus>>;
      try {
        st = await relayCallsStatus(ref.callsId);
      } catch {
        throw swapPending(ref, "The relay could not be reached to check the conversion.");
      }
      if (st.code !== null && st.code >= 300) throw new Error("The relay reports that the conversion failed, so nothing was converted. You can convert again.");
      if (!st.txHash) throw swapPending(ref, "The relay is still working on the conversion.");
      txHash = st.txHash;
    }
    if (!txHash) throw swapPending({}, "Autumn has no transaction to check. Compare your balances before converting again.");
    return confirmSwapped(req, wallet.address, txHash, 15_000);
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
      // The assertion is kept: it names the wallet (user handle) and the credential even when the SDK cannot finish.
      let picked: { id: string; userHandle: Uint8Array | null } | null = null;
      const get = browserGetFn();
      const getFn = (async (o: CredentialRequestOptions) => {
        const c = (await get(o)) as PublicKeyCredential | null;
        if (c) {
          const h = (c.response as AuthenticatorAssertionResponse).userHandle;
          picked = { id: c.id, userHandle: h ? new Uint8Array(h) : null };
        }
        return c;
      }) as NonNullable<PasskeyWebAuthnFns["getFn"]>;
      let w: Awaited<ReturnType<Client["recoverFromPasskey"]>>;
      try {
        w = await sdkClient().recoverFromPasskey({ rpId: cfg.rpId, chainId: CELO_CHAIN_ID, webAuthn: { getFn } });
      } catch (e) {
        const pk = passkeyFailure(e, "find");
        if (pk) throw pk;
        const found = picked as { id: string; userHandle: Uint8Array | null } | null;
        // The wallet has not made its first transaction, so the KeyStore holds no key yet: find it from the relay.
        if (/no keys registered in KeyStore/i.test(errText(e)) && found?.userHandle?.length === 20) {
          const { address, credential } = await restoreBeforeFirstTransaction(toHex(found.userHandle) as Address, found.id);
          const wallet = await remember(address, credential, true);
          emit();
          return wallet;
        }
        if (/userHandle/i.test(errText(e))) throw new Error("This passkey was not made by Autumn, so it names no wallet. Choose your Autumn passkey, or restore with your backup code.");
        throw new Error("Your wallet could not be found from this passkey right now. Try again in a minute, or restore with your backup code.");
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
    resumePlan,
    stopAgent,
    checkStop,
    registerIdentity,
    revokeStrayKey,
    quoteSend,
    send,
    checkSend,
    quoteSwap,
    swap,
    checkSwap,
  };
}

export type { PlanView };
