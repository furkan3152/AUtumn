/**
 * Test-only fakes for the runner's two ports. Never imported by src/.
 */
import { getAddress, keccak256, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import type { ExecuteResult, SerializedSession } from "@altananetwork/sdk";
import {
  decodeBuyCalls,
  priceUsdtPerXaut,
  sessionKeyIds,
  SPEND_PERIOD,
  USDT,
  nextPeriodStart,
  periodStart,
  type Balances,
  type PlanPeriod,
  type TxFacts,
  type BuyQuote,
  type Call,
  type Purchase,
  type SessionState,
} from "@autumn/core";
import type { ChainReader, SessionExecutor } from "../src/ports.js";

export const GOLD_BUYER = getAddress("0x1111111111111111111111111111111111111111");

export class FakeChain implements ChainReader {
  now: number;
  block = 1_000n;
  status: SessionState["status"] = "active";
  cap = 0n;
  spent = 0n;
  usdt = 100_000_000n;
  purchases: Purchase[] = [];
  receipts = new Map<string, Purchase[]>();
  quoteOut = 1_400n; // XAUt0 out for amountIn of 5 USD₮
  quoteWithin = true;
  allowedCalls: { target: Address; selector: Hex }[] = [
    { target: getAddress(USDT), selector: toFunctionSelector("approve(address,uint256)") },
    { target: GOLD_BUYER, selector: toFunctionSelector("buy(uint256,uint256)") },
  ];
  sessionReads = 0;
  /** The spend period the fake account meters the session's USD₮ cap over. */
  period: PlanPeriod = "week";
  /** The expiry the fake account stores for the key (set to the grant's expiry by tests). */
  expiry = 0;
  /** Receipts for grant/revoke transactions, by hash. */
  txs = new Map<string, TxFacts>();
  quoteTwap = true;
  superAdmin = false;

  constructor(now: number) {
    this.now = now;
  }

  /** Puts a purchase onchain, as a landed GoldBuyer.buy would. */
  land(buyer: Address, amountIn: bigint, out: bigint, at = this.now): Purchase {
    const txHash = keccak256(toHex(`tx-${this.purchases.length}-${buyer}-${at}`));
    const p: Purchase = {
      buyer: getAddress(buyer), amountIn, out, priceUsdtPerXaut: priceUsdtPerXaut(amountIn, out),
      txHash, blockNumber: this.block++, logIndex: 0, timestamp: at,
    };
    this.purchases.push(p);
    this.receipts.set(txHash.toLowerCase(), [p]);
    if (periodStart(at, this.period) === periodStart(this.now, this.period)) this.spent += amountIn + 3_000n;
    this.usdt -= amountIn + 3_000n;
    return p;
  }

  async head() {
    return { number: this.block, timestamp: this.now };
  }
  async sessionState(wallet: Address, publicKey: Hex): Promise<SessionState> {
    this.sessionReads++;
    const { keyId, keyHash } = sessionKeyIds(publicKey);
    const on = this.status !== "revoked";
    const ps = periodStart(this.now, this.period);
    const spend = on
      ? [{ token: getAddress(USDT), period: SPEND_PERIOD[this.period], limit: this.cap, spentThisPeriod: this.spent, periodStart: ps }]
      : [];
    return {
      status: this.status, keyId, keyHash, keyStoreValid: on, onAccount: on,
      ...(on ? { accountExpiry: this.expiry, keyType: 2, isSuperAdmin: this.superAdmin } : {}),
      spend, allowedCalls: on ? this.allowedCalls : [],
      ...(on
        ? { usdtCap: { period: this.period, limit: this.cap, spent: this.spent, remaining: this.cap > this.spent ? this.cap - this.spent : 0n, periodStart: ps, resetsAt: nextPeriodStart(this.now, this.period) } }
        : {}),
      blockNumber: this.block, blockTimestamp: this.now,
    };
  }
  async balances(_wallet: Address): Promise<Balances> {
    return { usdt: this.usdt, xaut0: 0n, celo: 0n, blockNumber: this.block };
  }
  /** Earliest `since` asked for, and how many scans ran: the runner reads only from what it needs. */
  scans: number[] = [];
  async purchasesSince(since: number): Promise<Purchase[]> {
    this.scans.push(since);
    return this.purchases.filter((p) => p.timestamp >= since && p.timestamp <= this.now);
  }
  async txFacts(txHash: Hex, _wallet: Address): Promise<TxFacts | null> {
    return this.txs.get(txHash.toLowerCase()) ?? null;
  }
  async purchasesInTx(txHash: Hex): Promise<Purchase[] | null> {
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
  async quote(amountIn: bigint): Promise<BuyQuote> {
    const out = (this.quoteOut * amountIn) / 5_000_000n;
    return {
      amountIn, amountOut: out, minOut: (out * 9950n) / 10_000n,
      twapAmountOut: this.quoteTwap ? out : null, twapDeviationBps: this.quoteTwap ? 0 : null, twapTick: this.quoteTwap ? -81_700 : null,
      tickAfter: -81_700, withinBound: this.quoteWithin && this.quoteTwap,
      ...(!this.quoteTwap
        ? { reason: "the pool has less than 30 minutes of price history, so GoldBuyer would refuse the purchase" }
        : this.quoteWithin ? {} : { reason: "the quote is 3.00% below the 30-minute average price (limit 1.00%)" }),
      priceUsdtPerXaut: priceUsdtPerXaut(amountIn, out), blockNumber: this.block,
    };
  }
}

export type ExecCall = { session: SerializedSession; privateKey: Hex; calls: readonly Call[] };

/**
 * A scripted executor. `behaviour` decides each send: "confirm" lands the
 * purchase and returns CONFIRMED; "throw-landed" lands it but throws an
 * ambiguous error; "throw-lost" throws without landing; or a custom function.
 */
export class FakeExecutor implements SessionExecutor {
  calls: ExecCall[] = [];
  behaviour: "confirm" | "throw-landed" | "throw-lost" | "pending-lost" | ((c: ExecCall) => Promise<ExecuteResult>) = "confirm";
  delayMs = 0;
  /** What the relay quotes as its fee (USD₮ base units), or a function that throws. */
  fee: bigint | (() => Promise<{ fee: bigint; feeToken: Address }>) = 3_000n;
  quotes = 0;
  /** Calls currently inside execute, per wallet, and the most seen at once. */
  inFlight = new Map<string, number>();
  maxInFlightPerWallet = 0;
  maxInFlight = 0;

  constructor(private readonly chain: FakeChain) {}

  async quote(_c: ExecCall): Promise<{ fee: bigint; feeToken: Address }> {
    this.quotes++;
    return typeof this.fee === "function" ? this.fee() : { fee: this.fee, feeToken: getAddress(USDT) };
  }

  async execute(c: ExecCall): Promise<ExecuteResult> {
    this.calls.push(c);
    const w = c.session.walletAddress.toLowerCase();
    this.inFlight.set(w, (this.inFlight.get(w) ?? 0) + 1);
    this.maxInFlightPerWallet = Math.max(this.maxInFlightPerWallet, this.inFlight.get(w)!);
    this.maxInFlight = Math.max(this.maxInFlight, [...this.inFlight.values()].reduce((a, b) => a + b, 0));
    try {
      return await this.run(c);
    } finally {
      this.inFlight.set(w, this.inFlight.get(w)! - 1);
    }
  }

  private async run(c: ExecCall): Promise<ExecuteResult> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const { amountIn, minOut } = decodeBuyCalls(c.calls, GOLD_BUYER);
    const out = this.chain.quoteOut * amountIn / 5_000_000n;
    if (out < minOut) throw new Error("fake: below minOut");
    const callsId = keccak256(toHex(`calls-${this.calls.length}`));
    const b = this.behaviour;
    if (typeof b === "function") return b(c);
    if (b === "confirm") {
      const p = this.chain.land(c.session.walletAddress, amountIn, out);
      return { callsId, transactionHash: p.txHash, status: "CONFIRMED", statusCode: 200 };
    }
    if (b === "throw-landed") {
      this.chain.land(c.session.walletAddress, amountIn, out);
      throw Object.assign(new Error("Could not reach the Altana relay."), { name: "AltanaError", code: "relay_unreachable" });
    }
    if (b === "pending-lost") return { callsId, status: "PENDING" };
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  }
}
