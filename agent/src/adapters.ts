import { CELO, createClient, deserializeSession, signerFromPrivateKey } from "@altananetwork/sdk";
import {
  createCeloPublicClient,
  pinnedBlock,
  quoteBuy,
  readBalances,
  readPurchasesInTx,
  readPurchasesInWeek,
  readSessionState,
  USDT,
  type AutumnConfig,
  type QuoteOptions,
} from "@autumn/core";
import type { ChainReader, SessionExecutor } from "./ports.js";

/** Chain reads for the runner, over a viem public client. */
export function createChainReader(
  cfg: AutumnConfig,
  opts: { quote?: QuoteOptions; logBlockRange?: bigint } = {},
): ChainReader {
  const client = createCeloPublicClient(cfg.rpcUrl);
  return {
    async head() {
      const b = await client.getBlock({ blockNumber: await pinnedBlock(client) });
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    sessionState: (wallet, publicKey) => readSessionState(client, { wallet, publicKey }),
    balances: (wallet) => readBalances(client, wallet),
    purchasesInWeek: (at) =>
      readPurchasesInWeek(client, {
        goldBuyer: cfg.goldBuyer,
        deployBlock: cfg.goldBuyerDeployBlock,
        at,
        ...(opts.logBlockRange ? { blockRange: opts.logBlockRange } : {}),
      }),
    purchasesInTx: (txHash) => readPurchasesInTx(client, cfg.goldBuyer, txHash),
    quote: (amountIn) => quoteBuy(client, amountIn, opts.quote),
  };
}

/**
 * Executes through the Altana relay with the session key, on Celo mainnet,
 * paying the relay fee in USD₮. `execute` waits for the relay's terminal
 * status (up to the SDK's 240 s), so CONFIRMED means included.
 */
export function createAltanaExecutor(rpcUrl?: string): SessionExecutor {
  const network = rpcUrl ? { ...CELO, publicRpcUrl: rpcUrl } : CELO;
  const client = createClient({ chains: [network], agentIdentity: false });
  return {
    async execute({ session, privateKey, calls }) {
      const live = deserializeSession(session, signerFromPrivateKey(privateKey));
      return client.execute({ session: live, calls, feeToken: USDT, chainId: CELO.chainId });
    },
  };
}
