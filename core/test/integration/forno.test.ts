/**
 * Read-only checks against Celo mainnet (https://forno.celo.org, or AUTUMN_CELO_RPC_URL).
 * Sends no transaction. Run with `npm run test:integration`.
 */
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { altanaAccountAbi, SPEND_PERIOD } from "../../src/abis.js";
import { createCeloPublicClient } from "../../src/client.js";
import { USDT_XAUT0_POOL } from "../../src/constants.js";
import { quoteBuy } from "../../src/quote.js";
import { blockAtOrBefore, readAgentIdentityCount, readBalances, readPoolState, readPurchases, readRegistration, readSessionState } from "../../src/readers.js";
import { periodStart } from "../../src/period.js";
import { weekStart } from "../../src/week.js";

const client = createCeloPublicClient(process.env.AUTUMN_CELO_RPC_URL);
/** A live Altana wallet on Celo mainnet (EIP-7702 delegated), seen in a public relay transaction. */
const ALTANA_WALLET = "0x731a878df9da4c1dcb87bd0df4bfa8cf783a364f" as const;

describe("Celo mainnet, read-only", () => {
  it("quotes a 5 USD₮ purchase through QuoterV2 with a TWAP check", async () => {
    const q = await quoteBuy(client, 5_000_000n);
    expect(q.amountOut).toBeGreaterThan(0n);
    expect(q.minOut).toBe((q.amountOut * 9950n) / 10_000n);
    // Gold has traded between $1,500 and $10,000 per ounce for years: a sanity band, not a price assertion.
    expect(q.priceUsdtPerXaut).toBeGreaterThan(1_500_000_000n);
    expect(q.priceUsdtPerXaut).toBeLessThan(10_000_000_000n);
    if (q.twapTick === null) {
      // The pool's oracle had no 30-minute history at this block: the quote must refuse.
      expect(q.withinBound).toBe(false);
      expect(q.reason).toMatch(/30 minutes of price history/);
    } else {
      expect(Math.abs(q.twapDeviationBps!)).toBeLessThan(500);
      expect(q.withinBound).toBe(q.reason === undefined);
    }
    console.log("quote", { out: q.amountOut, minOut: q.minOut, price: q.priceUsdtPerXaut, devBps: q.twapDeviationBps, withinBound: q.withinBound, reason: q.reason });
  });

  it("week helper agrees with the account contract's startOfSpendPeriod(Week)", async () => {
    const block = await client.getBlock();
    for (const ts of [Number(block.timestamp), 1_795_305_599, 1_795_305_600, 1_800_000_000]) {
      const onchain = await client.readContract({
        address: ALTANA_WALLET,
        abi: altanaAccountAbi,
        functionName: "startOfSpendPeriod",
        args: [BigInt(ts), SPEND_PERIOD.week],
      });
      expect(Number(onchain)).toBe(weekStart(ts));
    }
  });

  it("day helper agrees with the account contract's startOfSpendPeriod(Day)", async () => {
    const block = await client.getBlock();
    for (const ts of [Number(block.timestamp), 1_795_305_599, 1_795_305_600, 1_795_391_999]) {
      const onchain = await client.readContract({
        address: ALTANA_WALLET,
        abi: altanaAccountAbi,
        functionName: "startOfSpendPeriod",
        args: [BigInt(ts), SPEND_PERIOD.day],
      });
      expect(Number(onchain)).toBe(periodStart(ts, "day"));
    }
  });

  it("reads the registration fee and the wallet's KeyStore state", async () => {
    const r = await readRegistration(client, ALTANA_WALLET);
    expect(r.walletRegistered).toBe(true);
    expect(r.feePerKey).toBeGreaterThan(10n ** 17n);
    expect(r.nextGrantValue).toBe((r.feePerKey * 110n) / 100n);
    const fresh = await readRegistration(client, privateKeyToAccount(generatePrivateKey()).address);
    expect(fresh.walletRegistered).toBe(false);
    expect(fresh.nextGrantValue).toBe((fresh.feePerKey * 220n) / 100n);
  });

  it("reads the pool's mid price, oracle cardinality and TWAP availability", async () => {
    const p = await readPoolState(client);
    expect(p.midUsdtPerXaut).toBeGreaterThan(1_500_000_000n);
    expect(p.observationCardinality).toBeGreaterThanOrEqual(1);
    console.log("pool", { mid: p.midUsdtPerXaut, cardinality: p.observationCardinality, twapAvailable: p.twapAvailable });
  });

  it("reads ERC-8004 identities", async () => {
    expect(await readAgentIdentityCount(client, privateKeyToAccount(generatePrivateKey()).address)).toBe(0n);
  });

  it("reads balances", async () => {
    const b = await readBalances(client, ALTANA_WALLET);
    expect(typeof b.usdt).toBe("bigint");
    expect(b.blockNumber).toBeGreaterThan(0n);
  });

  it("reads a never-granted session as revoked, without throwing", async () => {
    const pk = privateKeyToAccount(generatePrivateKey()).publicKey;
    const s = await readSessionState(client, { wallet: ALTANA_WALLET, publicKey: pk });
    expect(s).toMatchObject({ status: "revoked", onAccount: false, keyStoreValid: false, spend: [], allowedCalls: [] });
    // Same on an address with no code at all.
    const bare = await readSessionState(client, { wallet: privateKeyToAccount(generatePrivateKey()).address, publicKey: pk });
    expect(bare.status).toBe("revoked");
  });

  it("locates the block at a timestamp", async () => {
    const latest = await client.getBlock();
    const ts = Number(latest.timestamp) - 3 * 86_400 - 17;
    const n = await blockAtOrBefore(client, ts);
    const [b, next] = await Promise.all([client.getBlock({ blockNumber: n }), client.getBlock({ blockNumber: n + 1n })]);
    expect(Number(b.timestamp)).toBeLessThanOrEqual(ts);
    expect(Number(next.timestamp)).toBeGreaterThan(ts);
  });

  it("scans Bought logs in forno-sized windows (none at an address that is not GoldBuyer)", async () => {
    const to = await client.getBlockNumber();
    const logs = await readPurchases(client, { goldBuyer: USDT_XAUT0_POOL, fromBlock: to - 12_000n, toBlock: to });
    expect(logs).toEqual([]);
  });
});
