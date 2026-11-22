import { parseAbi, parseAbiItem } from "viem";

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** contracts/src/GoldBuyer.sol */
export const goldBuyerAbi = parseAbi([
  "function buy(uint256 amountIn, uint256 minOut) returns (uint256 out)",
  "event Bought(address indexed buyer, uint256 amountIn, uint256 out)",
]);

/** Uniswap V3 QuoterV2 (non-view, called with eth_call). */
export const quoterV2Abi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

/** Uniswap SwapRouter02 (IV3SwapRouter: no deadline field). */
export const swapRouter02Abi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
]);

export const erc20TransferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export const uniswapV3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);

/**
 * The Altana account (IthacaAccount, verified on Celoscan at implementation
 * 0x4b5d20cd8a3927b500540d9bccddc27385c9fa79): key and guard reads.
 * SpendPeriod enum: Minute 0, Hour 1, Day 2, Week 3, Month 4, Year 5, Forever 6.
 */
export const altanaAccountAbi = parseAbi([
  "function getKeys() view returns ((uint40 expiry, uint8 keyType, bool isSuperAdmin, bytes publicKey)[] keys, bytes32[] keyHashes)",
  "function getKey(bytes32 keyHash) view returns ((uint40 expiry, uint8 keyType, bool isSuperAdmin, bytes publicKey) key)",
  "function spendInfos(bytes32 keyHash) view returns ((address token, uint8 period, uint256 limit, uint256 spent, uint256 lastUpdated, uint256 currentSpent, uint256 current)[] results)",
  "function canExecutePackedInfos(bytes32 keyHash) view returns (bytes32[])",
  "function startOfSpendPeriod(uint256 unixTimestamp, uint8 period) pure returns (uint256)",
]);

/** Altana KeyStore: `isValidKey` is registered, unexpired and unrevoked. */
export const altanaKeyStoreAbi = parseAbi([
  "function isValidKey(address user, bytes32 keyId) view returns (bool)",
  "function getKeys(address user) view returns (bytes32[])",
]);

/** KeyStore `KeyRegistered`, emitted by the KeyStore itself (from @altananetwork/sdk internal/keystore). */
export const keyRegisteredEvent = parseAbiItem(
  "event KeyRegistered(address indexed user, bytes32 indexed keyId, address indexed validator, uint40 expiry, bool isRoot)",
);

/** Altana KeyStoreController: the registration fee, paid in CELO, per key. */
export const altanaKeyStoreControllerAbi = parseAbi(["function getRegistrationFeeInWei() view returns (uint256)"]);

/** ERC-8004 identity registry is an ERC-721. */
export const erc721BalanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

export const SPEND_PERIOD = {
  minute: 0,
  hour: 1,
  day: 2,
  week: 3,
  month: 4,
  year: 5,
  forever: 6,
} as const;
