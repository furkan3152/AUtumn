import { createPublicClient, http, type PublicClient } from "viem";
import { celo } from "viem/chains";
import { DEFAULT_CELO_RPC_URL } from "./constants.js";

/** A read-only Celo mainnet client. */
export function createCeloPublicClient(rpcUrl: string = DEFAULT_CELO_RPC_URL): PublicClient {
  return createPublicClient({ chain: celo, transport: http(rpcUrl, { retryCount: 2, timeout: 20_000 }) }) as PublicClient;
}

/**
 * Blocks behind the head that pinned reads use. forno.celo.org balances
 * requests across nodes that lag each other by a block or two, and a read
 * pinned to the newest block can land on a node that answers "block is out
 * of range" (seen 2026-11-21). Three one-second blocks is enough margin.
 */
export const READ_LAG_BLOCKS = 3n;

/** A block number reads can safely be pinned to: head − READ_LAG_BLOCKS. */
export async function pinnedBlock(client: PublicClient): Promise<bigint> {
  const n = await client.getBlockNumber({ cacheTime: 0 });
  return n > READ_LAG_BLOCKS ? n - READ_LAG_BLOCKS : n;
}
