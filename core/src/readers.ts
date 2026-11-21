import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  getAddress,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { altanaAccountAbi, altanaKeyStoreAbi, erc20Abi, goldBuyerAbi, SPEND_PERIOD } from "./abis.js";
import { ALTANA_KEYSTORE, USDT, XAUT0 } from "./constants.js";
import { sessionKeyIds } from "./keys.js";
import { priceUsdtPerXaut } from "./quote.js";
import { weekStart } from "./week.js";
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
  spend: SpendLimit[];
  allowedCalls: AllowedCall[];
  /** The weekly USD₮ cap, when the session has one. */
  usdtWeekly?: { limit: bigint; spent: bigint; remaining: bigint; weekStart: number };
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
  try {
    const key = await client.readContract({
      address: args.wallet,
      abi: altanaAccountAbi,
      functionName: "getKey",
      args: [keyHash],
      blockNumber: bn,
    });
    accountExpiry = Number(key.expiry);
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

  const weekly = spend.find((s) => s.token === getAddress(USDT) && s.period === SPEND_PERIOD.week);
  const usdtWeekly = weekly
    ? {
        limit: weekly.limit,
        spent: weekly.spentThisPeriod,
        remaining: weekly.limit > weekly.spentThisPeriod ? weekly.limit - weekly.spentThisPeriod : 0n,
        weekStart: weekStart(now),
      }
    : undefined;

  return {
    status,
    keyId,
    keyHash,
    keyStoreValid,
    onAccount,
    ...(accountExpiry !== undefined ? { accountExpiry } : {}),
    spend,
    allowedCalls,
    ...(usdtWeekly ? { usdtWeekly } : {}),
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
  return purchases.filter((p) => p.timestamp >= start && p.timestamp < start + 604_800);
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
