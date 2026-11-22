/**
 * Read-only checks of the conversion routes against Celo mainnet (forno, or
 * AUTUMN_CELO_RPC_URL). Sends no transaction. Run with `npm run test:integration`.
 */
import { describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeAbiParameters, getAddress, keccak256, pad, parseAbi, toHex, type Address } from "viem";
import { erc20Abi, swapRouter02Abi } from "../../src/abis.js";
import { createCeloPublicClient, pinnedBlock } from "../../src/client.js";
import { CELO_TOKEN, CELO_USDT_POOL, CELO_USDT_POOL_FEE, POOL_FEE, SWAP_ROUTER_02, UNISWAP_V3_FACTORY, USDT, USDT_XAUT0_POOL, XAUT0 } from "../../src/constants.js";
import { NoGoldAverageError, SWAP_ASSETS, buildSwapCalls, quoteSwapRoute, type SwapAsset } from "../../src/swap.js";

const client = createCeloPublicClient(process.env.AUTUMN_CELO_RPC_URL);
/** An Altana passkey wallet on Celo mainnet (EIP-7702 delegated account). */
const ALTANA_WALLET = getAddress("0x15855ae2E04Fd00eFA45cB70D2C29E5777925429") as Address;
/** Allowance mapping slots, found by matching eth_createAccessList: GoldToken (CELO) at 3; USD₮ and XAUt0 (same implementation layout) share a slot. */
const allowanceSlot = (token: Address, owner: Address, spender: Address) => {
  const base = getAddress(token) === CELO_TOKEN ? 3n : null;
  if (base !== null) {
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, base]))]));
  }
  return null;
};
const SMALL: Record<SwapAsset, bigint> = { CELO: 2n * 10n ** 18n, USDT: 100_000n, XAUT0: 1_000n };
const PAIRS: [SwapAsset, SwapAsset][] = SWAP_ASSETS.flatMap((a) => SWAP_ASSETS.filter((b) => b !== a).map((b) => [a, b] as [SwapAsset, SwapAsset]));

describe("conversion routes on Celo mainnet, read-only", () => {
  it("the factory's pools are the pinned pools", async () => {
    const getPool = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
    const celoPool = await client.readContract({ address: UNISWAP_V3_FACTORY, abi: getPool, functionName: "getPool", args: [CELO_TOKEN, USDT, CELO_USDT_POOL_FEE] });
    const goldPool = await client.readContract({ address: UNISWAP_V3_FACTORY, abi: getPool, functionName: "getPool", args: [USDT, XAUT0, POOL_FEE] });
    expect(getAddress(celoPool)).toBe(getAddress(CELO_USDT_POOL));
    expect(getAddress(goldPool)).toBe(getAddress(USDT_XAUT0_POOL));
  });

  it("quotes small amounts in all six directions against the reference prices", async () => {
    const blockNumber = await pinnedBlock(client);
    for (const [from, to] of PAIRS) {
      try {
        const q = await quoteSwapRoute(client, from, to, SMALL[from], { blockNumber });
        console.log(`${from} → ${to}`, { in: q.amountIn, out: q.quotedOut, ref: q.referenceOut, belowBps: q.belowReferenceBps, ok: q.ok, ...(q.ok ? { minOut: q.minOut } : { reason: q.reason }) });
        expect(q.quotedOut).toBeGreaterThan(0n);
        expect(q.referenceOut).toBeGreaterThan(0n);
        expect(Math.abs(q.belowReferenceBps)).toBeLessThan(2_000);
      } catch (e) {
        // The gold pool's 30-minute average is unavailable right after a swap in it: the quote must refuse, not guess.
        if (e instanceof NoGoldAverageError && (from === "XAUT0" || to === "XAUT0")) continue;
        throw e;
      }
    }
  }, 60_000);

  it("a large gold purchase is refused as moving the pool's price", async () => {
    try {
      const q = await quoteSwapRoute(client, "USDT", "XAUT0", 100_000n * 1_000_000n);
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.refusal).toBe("impact");
    } catch (e) {
      if (!(e instanceof NoGoldAverageError)) throw e;
    }
  });

  it("every swap works with a contract account (the Altana wallet) as caller once the exact approval is in place", async () => {
    const blockNumber = await pinnedBlock(client);
    const code = await client.getCode({ address: ALTANA_WALLET, blockNumber });
    expect(code?.startsWith("0xef0100")).toBe(true); // EIP-7702 delegation: the caller has code
    for (const [from, to] of PAIRS) {
      const token = { CELO: CELO_TOKEN, USDT, XAUT0 }[from];
      const balance =
        from === "CELO"
          ? await client.getBalance({ address: ALTANA_WALLET, blockNumber })
          : await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [ALTANA_WALLET], blockNumber });
      const amountIn = balance < SMALL[from] ? balance : SMALL[from];
      if (amountIn === 0n) continue;
      // The allowance slot: computed for CELO, found with eth_createAccessList for the token proxies.
      let slot = allowanceSlot(token, ALTANA_WALLET, SWAP_ROUTER_02);
      if (!slot) {
        const al = (await client.request({
          method: "eth_createAccessList" as never,
          params: [{ to: token, data: `0xdd62ed3e${pad(ALTANA_WALLET).slice(2)}${pad(SWAP_ROUTER_02).slice(2)}` }, toHex(blockNumber)] as never,
        })) as { accessList: { address: string; storageKeys: `0x${string}`[] }[] };
        const keys = al.accessList.find((x) => getAddress(x.address) === token)?.storageKeys ?? [];
        // The mapping slot is the key that is neither the EIP-1967 implementation nor the admin slot.
        slot = keys.find((k) => !k.startsWith("0x360894") && !k.startsWith("0xb53127")) ?? null;
      }
      expect(slot).not.toBeNull();
      const [, swap] = buildSwapCalls(ALTANA_WALLET, from, to, amountIn, 1n);
      const r = await client.call({
        account: ALTANA_WALLET,
        to: swap.to,
        data: swap.data,
        blockNumber,
        stateOverride: [{ address: token, stateDiff: [{ slot: slot!, value: pad(toHex(amountIn), { size: 32 }) }] }],
      });
      const out = decodeFunctionResult({ abi: swapRouter02Abi, functionName: swap.data.startsWith("0x04e45aaf") ? "exactInputSingle" : "exactInput", data: r.data! });
      console.log(`eth_call ${from} → ${to} from the Altana wallet`, { amountIn, out });
      expect(out).toBeGreaterThan(0n);
    }
  }, 60_000);
});
