// Builds (does NOT send) the two calls a session key would submit for a USD₮ -> XAUt0 buy on Celo mainnet,
// and simulates the router call with eth_call from a holder-less address only to show the call decodes.
import { encodeFunctionData, parseAbi } from "viem";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", XAUT0 = "0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff";
const ROUTER02 = "0x5615CDAb10dc425a742d643d949a7F474C01abc4";
const wallet = process.argv[2] ?? "0xED58Da0B13bF9f63c3608F9068d488559cDCAA51";
const amountIn = BigInt(process.argv[3] ?? 5_000_000);       // 5 USD₮
const minOut = BigInt(process.argv[4] ?? 1393);              // quote 1407 minus ~1% slippage
const calls = [
  { to: USDT, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [ROUTER02, amountIn] }) },
  { to: ROUTER02, data: encodeFunctionData({ abi: parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]), functionName: "exactInputSingle", args: [{ tokenIn: USDT, tokenOut: XAUT0, fee: 3000, recipient: wallet, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] }) },
];
console.log(JSON.stringify(calls, null, 2));
