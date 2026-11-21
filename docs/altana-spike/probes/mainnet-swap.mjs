// Read-only against Celo mainnet (forno.celo.org): verify the deepest USD₮/XAUt0 pool, the Uniswap V3
// router/quoter that serve it, and quote $5 / $50 buys. Only eth_call / eth_getCode; nothing is signed.
import { createPublicClient, http, parseAbi, toFunctionSelector, formatUnits } from "viem";
import { celo } from "viem/chains";
const c = createPublicClient({ chain: celo, transport: http("https://forno.celo.org") });
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const XAUT0 = "0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff";
const POOL = "0xbb469a28f64c72aecc7d05ca6e45b2fb1a63b4f9";
const FACTORY = "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc";
const ROUTER02 = "0x5615CDAb10dc425a742d643d949a7F474C01abc4";
const QUOTER2 = "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8";
const UNIVERSAL = "0x643770E279d5D0733F21d6DC03A8efbABf3255B4";
const out = { block: await c.getBlockNumber() };
const poolAbi = parseAbi(["function token0() view returns (address)","function token1() view returns (address)","function fee() view returns (uint24)","function liquidity() view returns (uint128)","function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)","function factory() view returns (address)"]);
const r = (address, abi, functionName, args=[]) => c.readContract({ address, abi, functionName, args });
out.pool = { token0: await r(POOL,poolAbi,"token0"), token1: await r(POOL,poolAbi,"token1"), fee: await r(POOL,poolAbi,"fee"), liquidity: await r(POOL,poolAbi,"liquidity"), factory: await r(POOL,poolAbi,"factory") };
const s0 = await r(POOL,poolAbi,"slot0"); out.pool.sqrtPriceX96 = s0[0]; out.pool.tick = s0[1];
const fAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
out.factoryPools = {};
for (const fee of [100, 500, 3000, 10000]) out.factoryPools[fee] = await r(FACTORY, fAbi, "getPool", [USDT, XAUT0, fee]);
const erc = parseAbi(["function balanceOf(address) view returns (uint256)"]);
out.poolBalances = { USDT: formatUnits(await r(USDT,erc,"balanceOf",[POOL]),6), XAUt0: formatUnits(await r(XAUT0,erc,"balanceOf",[POOL]),6) };
const rAbi = parseAbi(["function factory() view returns (address)","function WETH9() view returns (address)","function factoryV2() view returns (address)"]);
out.router02 = { codeLen: (await c.getCode({address:ROUTER02}))?.length, factory: await r(ROUTER02,rAbi,"factory"), WETH9: await r(ROUTER02,rAbi,"WETH9") };
try { out.router02.factoryV2 = await r(ROUTER02,rAbi,"factoryV2"); } catch {}
out.quoter2 = { codeLen: (await c.getCode({address:QUOTER2}))?.length, factory: await r(QUOTER2,rAbi,"factory") };
out.universalRouterCodeLen = (await c.getCode({address:UNIVERSAL}))?.length;
// Mid price: token0/token1 ordering decides the direction. Both tokens have 6 decimals.
const p = (Number(s0[0]) / 2**96) ** 2; // token1 per token0
const usdtIs0 = out.pool.token0.toLowerCase() === USDT.toLowerCase();
const usdtPerXau = usdtIs0 ? 1/p : p;
out.midPriceUSDTperXAUt0 = usdtPerXau;
const qAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
out.quotes = {};
for (const usd of [5, 50, 500]) {
  const amountIn = BigInt(usd) * 1_000_000n;
  const { result } = await c.simulateContract({ address: QUOTER2, abi: qAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: USDT, tokenOut: XAUT0, amountIn, fee: 3000, sqrtPriceLimitX96: 0n }] });
  const outXau = Number(result[0]) / 1e6;
  const execPrice = usd / outXau;
  out.quotes[`$${usd}`] = { amountInUSDT: usd, amountOutXAUt0: outXau, rawOut: result[0], execPriceUSDTperXAUt0: execPrice,
    totalCostVsMidPct: ((execPrice / usdtPerXau) - 1) * 100,
    priceImpactExFeePct: ((execPrice * 0.997 / usdtPerXau) - 1) * 100,
    ticksCrossed: result[2], gasEstimate: result[3] };
}
out.selectors = {
  "SwapRouter02.exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))": toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"),
  "SwapRouter02.exactInput((bytes,address,uint256,uint256))": toFunctionSelector("exactInput((bytes,address,uint256,uint256))"),
  "SwapRouter02.multicall(uint256,bytes[])": toFunctionSelector("multicall(uint256,bytes[])"),
  "SwapRouter02.multicall(bytes[])": toFunctionSelector("multicall(bytes[])"),
  "SwapRouter02.sweepToken(address,uint256,address)": toFunctionSelector("sweepToken(address,uint256,address)"),
  "ERC20.approve(address,uint256)": toFunctionSelector("approve(address,uint256)"),
};
console.log(JSON.stringify(out, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
