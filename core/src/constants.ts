import { getAddress, type Address } from "viem";

/**
 * Celo mainnet constants. Every address below was verified read-only against
 * https://forno.celo.org on 2026-11-21 (derisk/RESULTS.md, sections 1 and 4).
 */
export const CELO_CHAIN_ID = 42220 as const;

/** Public Celo RPC used by default for reads. Override with `CELO_RPC_URL`. */
export const DEFAULT_CELO_RPC_URL = "https://forno.celo.org";

/** Tether USD₮ on Celo, 6 decimals. Spend cap token and relay fee token. */
export const USDT: Address = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
export const USDT_DECIMALS = 6;

/** Tether Gold XAUt0 on Celo, 6 decimals (not the 18-decimal fee-currency adapter). */
export const XAUT0: Address = "0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff";
export const XAUT0_DECIMALS = 6;

/** Uniswap V3 USD₮/XAUt0 0.3% pool. token0 = USD₮, token1 = XAUt0. */
export const USDT_XAUT0_POOL: Address = "0xbb469A28f64C72aECC7d05Ca6e45B2FB1a63B4F9";
export const POOL_FEE = 3000 as const;

export const UNISWAP_V3_FACTORY: Address = "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc";
export const SWAP_ROUTER_02: Address = "0x5615CDAb10dc425a742d643d949a7F474C01abc4";
export const QUOTER_V2: Address = "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8";

/** Altana KeyStore on Celo mainnet (from @altananetwork/sdk 1.1.0 `CELO.keyStore`). */
export const ALTANA_KEYSTORE: Address = "0x83b30935f36d6ccf9B1ec3b5E47F2866b97cd27c";

/** ERC-8021 attribution code for this project (@celo/attribution-tags). */
export const ATTRIBUTION_CODE = "celo_c24c5a65e5a3";

/** The GoldBuyer contract's own TWAP window and max tick drop (contracts/src/GoldBuyer.sol). */
export const GOLD_BUYER_TWAP_WINDOW_SECS = 1800;
export const GOLD_BUYER_MAX_TICK_DROP = 100;

/**
 * Deployment-specific settings. GoldBuyer is not deployed yet, so its address
 * comes from configuration only; there is deliberately no default.
 */
export type AutumnConfig = {
  /** Deployed GoldBuyer address. */
  goldBuyer: Address;
  /** Block GoldBuyer was deployed in: the earliest block a purchase can be in. */
  goldBuyerDeployBlock: bigint;
  /** RPC used for reads. */
  rpcUrl: string;
};

/**
 * Reads AutumnConfig from an env-like object. Throws on a missing or malformed
 * GoldBuyer address: nothing should quietly fall back to a guessed contract.
 *
 * - `GOLD_BUYER_ADDRESS` (required)
 * - `GOLD_BUYER_DEPLOY_BLOCK` (required: purchase history is read from it)
 * - `CELO_RPC_URL` (optional, default forno)
 */
export function configFromEnv(env: Record<string, string | undefined>): AutumnConfig {
  const raw = env.GOLD_BUYER_ADDRESS;
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error("GOLD_BUYER_ADDRESS is missing or not a 20-byte hex address");
  }
  const block = env.GOLD_BUYER_DEPLOY_BLOCK;
  if (!block || !/^\d+$/.test(block)) {
    throw new Error("GOLD_BUYER_DEPLOY_BLOCK is missing or not a block number");
  }
  return {
    goldBuyer: getAddress(raw),
    goldBuyerDeployBlock: BigInt(block),
    rpcUrl: env.CELO_RPC_URL || DEFAULT_CELO_RPC_URL,
  };
}
