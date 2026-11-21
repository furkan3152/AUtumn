import { getAddress, type Address } from "viem";

/**
 * Celo mainnet constants. Every address below was verified read-only against
 * https://forno.celo.org on 2026-11-21 (derisk/RESULTS.md, sections 1 and 4).
 */
export const CELO_CHAIN_ID = 42220 as const;

/** Public Celo RPC used by default for reads. Override with `AUTUMN_CELO_RPC_URL`. */
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

/**
 * Altana Orchestrator on Celo mainnet: relay `wallet_getCapabilities` for
 * 0xa4ec (`contracts.orchestrator`, v0.5.5, no legacy orchestrators, read
 * 2026-11-21), verified source "Orchestrator" 0.5.5 on Sourcify, and the
 * immutable `ORCHESTRATOR()` of the account implementation every Altana
 * wallet on Celo delegates to.
 */
export const ALTANA_ORCHESTRATOR: Address = "0xAF140d0416A994Aebb3fA6212B16CE6700f09751";

/** The Orchestrator a session key's allowlist may name, per chain. Only Celo mainnet is supported. */
export const ALTANA_ORCHESTRATOR_BY_CHAIN: Readonly<Record<number, Address>> = { [CELO_CHAIN_ID]: ALTANA_ORCHESTRATOR };

/** GuardedExecutor wildcards (IthacaAccount 0.5.10, GuardedExecutor.sol lines 132 and 135; Porto `Call.anyTarget` / `Call.anySelector`). */
export const ANY_TARGET: Address = "0x3232323232323232323232323232323232323232";
export const ANY_SELECTOR = "0x32323232" as const;

/** Altana KeyStore on Celo mainnet (from @altananetwork/sdk 1.1.0 `CELO.keyStore`). */
export const ALTANA_KEYSTORE: Address = "0x83b30935f36d6ccf9B1ec3b5E47F2866b97cd27c";

/** Altana KeyStoreController on Celo mainnet (SDK `CELO.keyStoreController`): registration fees in CELO. */
export const ALTANA_KEYSTORE_CONTROLLER: Address = "0x47bA5fc2A5b0CcB24BA3fAC9D4B59400eE9fd1D6";

/** ERC-8004 identity registry on Celo (docs.altana.network, "ERC-8004: agent identity"; code present 2026-11-21). */
export const ERC8004_IDENTITY_REGISTRY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

/** Celo FeeCurrencyDirectory and the 18-decimal USD₮ fee adapter it lists (read 2026-11-21): CELO's price in USD₮. */
export const FEE_CURRENCY_DIRECTORY: Address = "0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276";
export const USDT_FEE_ADAPTER: Address = "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72";

/** Altana's public Keystore explorer (docs.altana.network, "Keystore Explorer"). */
export const ALTANA_EXPLORER = "https://explorer.altana.network";

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
 * - `AUTUMN_GOLD_BUYER_ADDRESS` (required)
 * - `AUTUMN_GOLD_BUYER_DEPLOY_BLOCK` (required: purchase history is read from it)
 * - `AUTUMN_CELO_RPC_URL` (optional, default forno)
 *
 * `prefix` lets the browser read the same settings from `NEXT_PUBLIC_AUTUMN_…`.
 */
export function configFromEnv(env: Record<string, string | undefined>, prefix = "AUTUMN_"): AutumnConfig {
  const raw = env[`${prefix}GOLD_BUYER_ADDRESS`];
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${prefix}GOLD_BUYER_ADDRESS is missing or not a 20-byte hex address`);
  }
  const block = env[`${prefix}GOLD_BUYER_DEPLOY_BLOCK`];
  if (!block || !/^\d+$/.test(block)) {
    throw new Error(`${prefix}GOLD_BUYER_DEPLOY_BLOCK is missing or not a block number`);
  }
  return {
    goldBuyer: getAddress(raw),
    goldBuyerDeployBlock: BigInt(block),
    rpcUrl: env[`${prefix}CELO_RPC_URL`] || DEFAULT_CELO_RPC_URL,
  };
}
