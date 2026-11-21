import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  getAddress,
  parseAbiItem,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  altanaAccountAbi,
  altanaKeyStoreAbi,
  altanaKeyStoreControllerAbi,
  erc20Abi,
  erc721BalanceAbi,
  goldBuyerAbi,
  keyRegisteredEvent,
  SPEND_PERIOD,
} from "./abis.js";
import { USDT_XAUT0_POOL } from "./constants.js";
import { uniswapV3PoolAbi } from "./abis.js";
import { ALTANA_KEYSTORE, ALTANA_KEYSTORE_CONTROLLER, ERC8004_IDENTITY_REGISTRY, USDT, XAUT0 } from "./constants.js";
import { sessionKeyIds } from "./keys.js";
import { priceUsdtPerXaut, readTwapTick } from "./quote.js";
import { WEEK_SECS, weekStart } from "./week.js";
import { nextPeriodStart, periodStart, type PlanPeriod } from "./period.js";
import { pinnedBlock } from "./client.js";

/** forno.celo.org refuses eth_getLogs over more than 5000 blocks. */
export const DEFAULT_LOG_BLOCK_RANGE = 5000n;

export type Balances = { usdt: bigint; xaut0: bigint; celo: bigint; blockNumber: bigint };

export async function readBalances(client: PublicClient, wallet: Address, blockNumber?: bigint): Promise<Balances> {
  const bn = blockNumber ?? (await pinnedBlock(client));
  const [usdt, xaut0, celo] = await Promise.all([
    client.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [wallet], blockNumber: bn }),
    client.readContract({ address: XAUT0, abi: erc20Abi, functionName: "balanceOf", args: [wallet], blockNumber: bn }),
    client.getBalance({ address: wallet, blockNumber: bn }),
  ]);
  return { usdt, xaut0, celo, blockNumber: bn };
}

export type SpendLimit = {
  token: Address;
  period: number;
  limit: bigint;
  /** Spent in the period that is current at the read block. */
  spentThisPeriod: bigint;
  /** Start of that period, unix seconds. */
  periodStart: number;
};

export type AllowedCall = { target: Address; selector: Hex };

export type SessionStatus =
  /** On the account, unexpired, and valid in the KeyStore. */
  | "active"
  /** The expiry has passed. */
  | "expired"
  /** Not on the account, or no longer valid in the KeyStore, before its expiry: revoked (or never granted). */
  | "revoked";

export type SessionState = {
  status: SessionStatus;
  keyId: Hex;
  keyHash: Hex;
  keyStoreValid: boolean;
  onAccount: boolean;
  /** Expiry the account stores for the key, unix seconds (0 = none); undefined when not on the account. */
  accountExpiry?: number;
  /** Key type the account stores (2 = secp256k1); undefined when not on the account. */
  keyType?: number;
  /** Whether the account stores the key as a super admin; undefined when not on the account. A plan's key must be false. */
  isSuperAdmin?: boolean;
  spend: SpendLimit[];
  allowedCalls: AllowedCall[];
  /**
   * The session's USD₮ cap, when it has exactly one (a plan grants one, per
   * day or per week). `periodStart`/`resetsAt` come from the account's own
   * period arithmetic for the read block.
   */
  usdtCap?: { period: PlanPeriod; limit: bigint; spent: bigint; remaining: bigint; periodStart: number; resetsAt: number };
  blockNumber: bigint;
  blockTimestamp: number;
};

/** True for a call that reverted or returned nothing, as opposed to an RPC/transport failure. */
function isRevertOrNoData(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return !!err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError);
}

/** Packed canExecute entries: target in the upper 20 bytes, selector in the lower 4. */
export function unpackCanExecute(packed: Hex): AllowedCall {
  const hex = packed.slice(2).padStart(64, "0");
  return { target: getAddress(`0x${hex.slice(0, 40)}`), selector: `0x${hex.slice(56)}` as Hex };
}

/**
 * Everything the chain says about a session key, at one block. A transport
 * error throws: an unreadable chain is never taken to mean "revoked".
 */
export async function readSessionState(
  client: PublicClient,
  args: { wallet: Address; publicKey: Hex; blockNumber?: bigint },
): Promise<SessionState> {
  const { keyId, keyHash } = sessionKeyIds(args.publicKey);
  const block = await client.getBlock({ blockNumber: args.blockNumber ?? (await pinnedBlock(client)) });
  const bn = block.number;
  const now = Number(block.timestamp);

  const keyStoreValid = await client.readContract({
    address: ALTANA_KEYSTORE,
    abi: altanaKeyStoreAbi,
    functionName: "isValidKey",
    args: [args.wallet, keyId],
    blockNumber: bn,
  });

  let accountExpiry: number | undefined;
  let keyType: number | undefined;
  let isSuperAdmin: boolean | undefined;
  try {
    const key = await client.readContract({
      address: args.wallet,
      abi: altanaAccountAbi,
      functionName: "getKey",
      args: [keyHash],
      blockNumber: bn,
    });
    accountExpiry = Number(key.expiry);
    keyType = Number(key.keyType);
    isSuperAdmin = key.isSuperAdmin;
  } catch (err) {
    if (!isRevertOrNoData(err)) throw err;
  }
  const onAccount = accountExpiry !== undefined;

  let spend: SpendLimit[] = [];
  let allowedCalls: AllowedCall[] = [];
  if (onAccount) {
    const [infos, packed] = await Promise.all([
      client.readContract({ address: args.wallet, abi: altanaAccountAbi, functionName: "spendInfos", args: [keyHash], blockNumber: bn }),
      client.readContract({ address: args.wallet, abi: altanaAccountAbi, functionName: "canExecutePackedInfos", args: [keyHash], blockNumber: bn }),
    ]);
    spend = infos.map((i) => ({
      token: getAddress(i.token),
      period: Number(i.period),
      limit: i.limit,
      spentThisPeriod: i.currentSpent,
      periodStart: Number(i.current),
    }));
    allowedCalls = packed.map(unpackCanExecute);
  }

  const expired = accountExpiry !== undefined && accountExpiry !== 0 && accountExpiry <= now;
  const status: SessionStatus = expired ? "expired" : onAccount && keyStoreValid ? "active" : "revoked";

  const usdtCaps = spend.filter((s) => s.token === getAddress(USDT));
  const only = usdtCaps.length === 1 ? usdtCaps[0]! : undefined;
  const capPeriod: PlanPeriod | undefined =
    only?.period === SPEND_PERIOD.week ? "week" : only?.period === SPEND_PERIOD.day ? "day" : undefined;
  const usdtCap =
    only && capPeriod
      ? {
          period: capPeriod,
          limit: only.limit,
          spent: only.spentThisPeriod,
          remaining: only.limit > only.spentThisPeriod ? only.limit - only.spentThisPeriod : 0n,
          periodStart: periodStart(now, capPeriod),
          resetsAt: nextPeriodStart(now, capPeriod),
        }
      : undefined;

  return {
    status,
    keyId,
    keyHash,
    keyStoreValid,
    onAccount,
    ...(accountExpiry !== undefined ? { accountExpiry } : {}),
    ...(keyType !== undefined ? { keyType } : {}),
    ...(isSuperAdmin !== undefined ? { isSuperAdmin } : {}),
    spend,
    allowedCalls,
    ...(usdtCap ? { usdtCap } : {}),
    blockNumber: bn,
    blockTimestamp: now,
  };
}

export type Purchase = {
  buyer: Address;
  amountIn: bigint;
  out: bigint;
  /** USD₮ base units per whole XAUt0 paid in this purchase. */
  priceUsdtPerXaut: bigint;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number;
};

export type PurchaseQuery = {
  goldBuyer: Address;
  /** Only this buyer; omit for every buyer (one scan shared by several wallets). */
  buyer?: Address;
  fromBlock: bigint;
  toBlock?: bigint;
  /** Max blocks per eth_getLogs request. Default 5000 (forno). */
  blockRange?: bigint;
  /** Parallel getLogs requests. Default 8. */
  concurrency?: number;
};

/** GoldBuyer `Bought` events, oldest first, with block timestamps. */
export async function readPurchases(client: PublicClient, q: PurchaseQuery): Promise<Purchase[]> {
  const to = q.toBlock ?? (await pinnedBlock(client));
  const range = q.blockRange ?? DEFAULT_LOG_BLOCK_RANGE;
  if (range <= 0n) throw new Error("blockRange must be positive");
  const windows: [bigint, bigint][] = [];
  for (let from = q.fromBlock; from <= to; from += range) {
    windows.push([from, from + range - 1n > to ? to : from + range - 1n]);
  }
  const event = goldBuyerAbi.find((x) => x.type === "event" && x.name === "Bought")!;
  const logs: Awaited<ReturnType<typeof client.getLogs<typeof event>>> = [];
  const concurrency = Math.max(1, q.concurrency ?? 8);
  for (let i = 0; i < windows.length; i += concurrency) {
    const batch = await Promise.all(
      windows.slice(i, i + concurrency).map(([fromBlock, toBlock]) =>
        client.getLogs({
          address: q.goldBuyer,
          event,
          ...(q.buyer ? { args: { buyer: q.buyer } } : {}),
          fromBlock,
          toBlock,
          strict: true,
        }),
      ),
    );
    for (const b of batch) logs.push(...b);
  }
  const parsed = parseEventLogs({ abi: goldBuyerAbi, logs, eventName: "Bought" });
  const timestamps = new Map<bigint, number>();
  const blocks = [...new Set(parsed.map((l) => l.blockNumber))];
  await Promise.all(
    blocks.map(async (n) => timestamps.set(n, Number((await client.getBlock({ blockNumber: n })).timestamp))),
  );
  return parsed
    .map((l) => ({
      buyer: getAddress(l.args.buyer),
      amountIn: l.args.amountIn,
      out: l.args.out,
      priceUsdtPerXaut: l.args.out > 0n ? priceUsdtPerXaut(l.args.amountIn, l.args.out) : 0n,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      timestamp: timestamps.get(l.blockNumber)!,
    }))
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

/**
 * The last block whose timestamp is at or before `ts`. Celo mainnet produces
 * one block per second, so the estimate is usually exact; it is corrected by
 * reading real timestamps either way.
 */
export async function blockAtOrBefore(client: PublicClient, ts: number, floor = 0n): Promise<bigint> {
  const latest = await client.getBlock({ blockNumber: await pinnedBlock(client) });
  if (Number(latest.timestamp) <= ts) return latest.number;
  let guess = latest.number - BigInt(Number(latest.timestamp) - ts);
  if (guess < floor) guess = floor;
  for (let i = 0; i < 64; i++) {
    const b = await client.getBlock({ blockNumber: guess });
    const t = Number(b.timestamp);
    if (t > ts) {
      if (guess <= floor) return floor;
      const step = BigInt(Math.max(1, t - ts));
      guess = guess - step < floor ? floor : guess - step;
      continue;
    }
    // t <= ts: make sure the next block is past ts.
    const next = await client.getBlock({ blockNumber: guess + 1n });
    if (Number(next.timestamp) > ts) return guess;
    guess += BigInt(Math.max(1, ts - Number(next.timestamp)));
  }
  throw new Error(`could not locate the block at ${ts}`);
}

/** Purchases (optionally by one buyer) in the calendar week containing `at` (unix seconds), up to now. */
export async function readPurchasesInWeek(
  client: PublicClient,
  q: Omit<PurchaseQuery, "fromBlock" | "toBlock"> & { deployBlock: bigint; at: number },
): Promise<Purchase[]> {
  const start = weekStart(q.at);
  const from = (await blockAtOrBefore(client, start, q.deployBlock)) ;
  const purchases = await readPurchases(client, { ...q, fromBlock: from < q.deployBlock ? q.deployBlock : from });
  return purchases.filter((p) => p.timestamp >= start && p.timestamp < start + WEEK_SECS);
}

/**
 * Purchases (optionally by one buyer) from unix time `since` up to now. The
 * runner reads only from the oldest moment it needs (the current period's
 * start, or its oldest open attempt), not a whole week each time.
 */
export async function readPurchasesSince(
  client: PublicClient,
  q: Omit<PurchaseQuery, "fromBlock" | "toBlock"> & { deployBlock: bigint; since: number },
): Promise<Purchase[]> {
  const from = await blockAtOrBefore(client, q.since, q.deployBlock);
  const purchases = await readPurchases(client, { ...q, fromBlock: from < q.deployBlock ? q.deployBlock : from });
  return purchases.filter((p) => p.timestamp >= q.since);
}

/** The Bought event(s) a given transaction emitted, from its receipt; null when the receipt does not exist yet. */
export async function readPurchasesInTx(client: PublicClient, goldBuyer: Address, txHash: Hex): Promise<Purchase[] | null> {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (err) {
    if (err instanceof BaseError && err.name === "TransactionReceiptNotFoundError") return null;
    throw err;
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const logs = parseEventLogs({
    abi: goldBuyerAbi,
    logs: receipt.logs.filter((l) => getAddress(l.address) === getAddress(goldBuyer)),
    eventName: "Bought",
  });
  return logs.map((l) => ({
    buyer: getAddress(l.args.buyer),
    amountIn: l.args.amountIn,
    out: l.args.out,
    priceUsdtPerXaut: l.args.out > 0n ? priceUsdtPerXaut(l.args.amountIn, l.args.out) : 0n,
    txHash,
    blockNumber: receipt.blockNumber,
    logIndex: l.logIndex,
    timestamp: Number(block.timestamp),
  }));
}

/** Fee a KeyStore registration carries above the quoted fee: 10% headroom, refunded (SDK REGISTRATION_FEE_MARGIN_PERCENT). */
export const REGISTRATION_VALUE_PERCENT = 110n;

export type Registration = {
  /** The wallet's admin key (the passkey) is in the KeyStore: its first admin action has landed. */
  walletRegistered: boolean;
  /** KeyStoreController.getRegistrationFeeInWei() now (oracle driven, CELO wei per key). */
  feePerKey: bigint;
  /**
   * CELO the next plan's grant sends with it: one registration for the
   * session key, plus one for the wallet's admin key on its first grant, each
   * with the SDK's 10% headroom (the excess is refunded).
   */
  nextGrantValue: bigint;
  blockNumber: bigint;
};

/** The wallet's KeyStore registration state and what the next grant's registration costs, in CELO. */
export async function readRegistration(client: PublicClient, wallet: Address, blockNumber?: bigint): Promise<Registration> {
  const bn = blockNumber ?? (await pinnedBlock(client));
  const [keys, feePerKey] = await Promise.all([
    client.readContract({ address: ALTANA_KEYSTORE, abi: altanaKeyStoreAbi, functionName: "getKeys", args: [wallet], blockNumber: bn }),
    client.readContract({ address: ALTANA_KEYSTORE_CONTROLLER, abi: altanaKeyStoreControllerAbi, functionName: "getRegistrationFeeInWei", blockNumber: bn }),
  ]);
  const walletRegistered = keys.length > 0;
  const keysToRegister = walletRegistered ? 1n : 2n;
  return {
    walletRegistered,
    feePerKey,
    nextGrantValue: (feePerKey * REGISTRATION_VALUE_PERCENT * keysToRegister) / 100n,
    blockNumber: bn,
  };
}

/** How many ERC-8004 agent identities the wallet owns on Celo (the registry is an ERC-721). */
export async function readAgentIdentityCount(client: PublicClient, wallet: Address): Promise<bigint> {
  return client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: erc721BalanceAbi, functionName: "balanceOf", args: [wallet] });
}

const erc721TransferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

/**
 * The ERC-8004 agent id minted to `wallet` between two blocks (the newest
 * mint found), or null. The registry is not enumerable, so the id comes from
 * its mint event; callers pass the narrow range right after a plan's grant.
 */
export async function readAgentIdMinted(
  client: PublicClient,
  wallet: Address,
  fromBlock: bigint,
  toBlock: bigint,
  blockRange = DEFAULT_LOG_BLOCK_RANGE,
): Promise<bigint | null> {
  let found: bigint | null = null;
  for (let from = fromBlock; from <= toBlock; from += blockRange) {
    const to = from + blockRange - 1n > toBlock ? toBlock : from + blockRange - 1n;
    const logs = await client.getLogs({
      address: ERC8004_IDENTITY_REGISTRY,
      event: erc721TransferEvent,
      args: { from: "0x0000000000000000000000000000000000000000", to: wallet },
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    for (const l of logs) found = l.args.tokenId;
  }
  return found;
}

export type PoolState = {
  /** Mid price from slot0, USD₮ base units per whole XAUt0 (no pool fee, no price impact). */
  midUsdtPerXaut: bigint;
  tick: number;
  observationCardinality: number;
  observationCardinalityNext: number;
  /** False when the pool cannot report a 30-minute average now, so GoldBuyer.buy would revert "OLD". */
  twapAvailable: boolean;
  blockNumber: bigint;
  blockTimestamp: number;
};

/** USD₮ per whole XAUt0 from a pool sqrtPriceX96 (token0 = USD₮, token1 = XAUt0, both 6 decimals). */
export function midPriceFromSqrtPriceX96(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 <= 0n) throw new Error("sqrtPriceX96 must be positive");
  // price(token1 per token0) = sqrtP² / 2¹⁹²; USD₮ per XAUt0 = 2¹⁹² / sqrtP², scaled to 6 decimals.
  return ((1n << 192n) * 1_000_000n) / (sqrtPriceX96 * sqrtPriceX96);
}

/** The USD₮/XAUt0 pool's mid price and whether its 30-minute TWAP (GoldBuyer's floor) can be read now. */
export async function readPoolState(client: PublicClient, blockNumber?: bigint): Promise<PoolState> {
  const bn = blockNumber ?? (await pinnedBlock(client));
  const [slot0, twapTick, block] = await Promise.all([
    client.readContract({ address: USDT_XAUT0_POOL, abi: uniswapV3PoolAbi, functionName: "slot0", blockNumber: bn }),
    readTwapTick(client, bn),
    client.getBlock({ blockNumber: bn }),
  ]);
  const [sqrtPriceX96, tick, , cardinality, cardinalityNext] = slot0;
  return {
    midUsdtPerXaut: midPriceFromSqrtPriceX96(sqrtPriceX96),
    tick: Number(tick),
    observationCardinality: Number(cardinality),
    observationCardinalityNext: Number(cardinalityNext),
    twapAvailable: twapTick !== null,
    blockNumber: bn,
    blockTimestamp: Number(block.timestamp),
  };
}

export type TxFacts = {
  txHash: Hex;
  succeeded: boolean;
  blockNumber: bigint;
  timestamp: number;
  /** KeyStore `KeyRegistered` events for the wallet in this transaction. */
  keysRegistered: { keyId: Hex; isRoot: boolean }[];
  /** True when any log in the transaction was emitted by the wallet's own account. */
  touchedWallet: boolean;
};

/** What a (grant, revoke) transaction did for a wallet, from its receipt; null while there is no receipt. */
export async function readTxFacts(client: PublicClient, txHash: Hex, wallet: Address): Promise<TxFacts | null> {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (err) {
    if (err instanceof BaseError && err.name === "TransactionReceiptNotFoundError") return null;
    throw err;
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const w = getAddress(wallet);
  const registered = parseEventLogs({
    abi: [keyRegisteredEvent],
    logs: receipt.logs.filter((l) => getAddress(l.address) === getAddress(ALTANA_KEYSTORE)),
    eventName: "KeyRegistered",
  })
    .filter((l) => getAddress(l.args.user) === w)
    .map((l) => ({ keyId: l.args.keyId, isRoot: l.args.isRoot }));
  return {
    txHash,
    succeeded: receipt.status === "success",
    blockNumber: receipt.blockNumber,
    timestamp: Number(block.timestamp),
    keysRegistered: registered,
    touchedWallet: receipt.logs.some((l) => getAddress(l.address) === w),
  };
}
