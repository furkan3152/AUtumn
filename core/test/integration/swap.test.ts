/**
 * Read-only checks of the CELO → USD₮ route against Celo mainnet (forno, or
 * AUTUMN_CELO_RPC_URL). Sends no transaction. Run with `npm run test:integration`.
 */
import { describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeAbiParameters, getAddress, keccak256, pad, parseAbi, toHex, type Address } from "viem";
import { swapRouter02Abi } from "../../src/abis.js";
import { createCeloPublicClient, pinnedBlock } from "../../src/client.js";
import { CELO_TOKEN, CELO_USDT_POOL, CELO_USDT_POOL_FEE, SWAP_ROUTER_02, UNISWAP_V3_FACTORY, USDT } from "../../src/constants.js";
import { buildSwapCalls, quoteCeloToUsdt } from "../../src/swap.js";

const client = createCeloPublicClient(process.env.AUTUMN_CELO_RPC_URL);
/** An Altana passkey wallet on Celo mainnet (EIP-7702 delegated account). */
const ALTANA_WALLET = getAddress("0x15855ae2E04Fd00eFA45cB70D2C29E5777925429") as Address;
/** GoldToken (CELO) `allowed` mapping slot: keccak(spender . keccak(owner . 3)). Found by matching eth_createAccessList. */
const CELO_ALLOWANCE_SLOT = 3n;

describe("CELO → USD₮ route on Celo mainnet, read-only", () => {
  it("the factory's CELO/USD₮ fee-100 pool is the pinned pool", async () => {
    const pool = await client.readContract({
      address: UNISWAP_V3_FACTORY,
      abi: parseAbi(["function getPool(address,address,uint24) view returns (address)"]),
      functionName: "getPool",
      args: [CELO_TOKEN, USDT, CELO_USDT_POOL_FEE],
    });
    expect(getAddress(pool)).toBe(getAddress(CELO_USDT_POOL));
  });

  it("quotes 10 CELO within 3% of Celo's reference rate", async () => {
    const q = await quoteCeloToUsdt(client, 10n * 10n ** 18n);
    console.log("swap quote", { out: q.quotedOut, ref: q.referenceOut, belowBps: q.belowReferenceBps, ok: q.ok });
    expect(q.quotedOut).toBeGreaterThan(0n);
    expect(q.ok).toBe(true);
  });

  it("the swap works with a contract account (the Altana wallet) as caller, once the exact approval is in place", async () => {
    const amountIn = 10n ** 18n;
    const blockNumber = await pinnedBlock(client);
    const q = await quoteCeloToUsdt(client, amountIn, { blockNumber });
    if (!q.ok) throw new Error(q.reason);
    const code = await client.getCode({ address: ALTANA_WALLET, blockNumber });
    expect(code?.startsWith("0xef0100")).toBe(true); // EIP-7702 delegation: the caller has code
    const balance = await client.getBalance({ address: ALTANA_WALLET, blockNumber });
    if (balance < amountIn) return; // the sample wallet no longer holds 1 CELO: nothing to simulate against
    const [, swap] = buildSwapCalls(ALTANA_WALLET, amountIn, q.minOut);
    const slot = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [SWAP_ROUTER_02, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ALTANA_WALLET, CELO_ALLOWANCE_SLOT]))]),
    );
    // Without the approval the router cannot pull the CELO.
    await expect(client.call({ account: ALTANA_WALLET, to: swap.to, data: swap.data, blockNumber })).rejects.toThrow(/STF/);
    // With exactly amountIn approved, the swap from the wallet returns at least the floor.
    const r = await client.call({
      account: ALTANA_WALLET,
      to: swap.to,
      data: swap.data,
      blockNumber,
      stateOverride: [{ address: CELO_TOKEN, stateDiff: [{ slot, value: pad(toHex(amountIn), { size: 32 }) }] }],
    });
    const out = decodeFunctionResult({ abi: swapRouter02Abi, functionName: "exactInputSingle", data: r.data! });
    console.log("swap from the Altana wallet (eth_call)", { amountIn, out, minOut: q.minOut });
    expect(out).toBeGreaterThanOrEqual(q.minOut);
  });
});
