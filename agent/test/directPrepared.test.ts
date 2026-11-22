/**
 * The relay-prepared, self-submitted executor (src/directPrepared.ts) against
 * a fake Celo node and a fake relay. The relay's answers use the exact
 * envelope Altana's relay returned on 2026-11-22 and the field values of our
 * relay-sent mainnet purchase 0xe6f4… (core/test/fixtures/relay-prepared-intents.json):
 * fee in USD₮ to Altana's recipient, paymentAmount = paymentMaxAmount,
 * expiry 0, the SDK's nonce lane, the pinned account implementation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  custom,
  decodeAbiParameters,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  size,
  slice,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { SerializedSession } from "@altananetwork/sdk";
import {
  ALTANA_ACCOUNT_IMPLEMENTATION,
  ALTANA_FEE_RECIPIENT,
  ALTANA_ORCHESTRATOR,
  ATTRIBUTION_CODE,
  ATTRIBUTION_SUFFIX,
  altanaAccountAbi,
  buildBuyCalls,
  encodeExecutionData,
  encodeIntent,
  explainAltanaError,
  goldBuyerAbi,
  INTENT_ABI_PARAMETER,
  intentDigest,
  ithacaAccountNonceAbi,
  laneNonce,
  orchestratorAbi,
  sdkLaneSeqKey,
  sessionKeyIds,
  USDT,
  verifyTx,
  type Call,
  type Intent,
} from "@autumn/core";
import { createDirectPreparedExecutor, type RelayRequest } from "../src/directPrepared.js";
import { createPlan } from "../src/plans.js";
import { createRunner } from "../src/runner.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { FakeChain, GOLD_BUYER } from "./fakes.js";

const fixture = JSON.parse(readFileSync(new URL("../../core/test/fixtures/relay-prepared-intents.json", import.meta.url), "utf8")) as {
  prepareCalls: { result: { context: { quote: { quotes: Record<string, unknown>[] } } } };
  mainnetIntents: { hash: Hex; intent: Record<string, string | boolean | string[]> }[];
};
const REAL = fixture.mainnetIntents.find((m) => m.hash.startsWith("0xe6f4"))!.intent;

const chain = defineChain({ id: 42220, name: "Celo (fake node)", nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 }, rpcUrls: { default: { http: ["http://fake"] } } });
const NOW = 1_795_400_000n;
const transferEvent = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

type Answer = Record<string, unknown>;

/** A Celo node with one Altana wallet, the Orchestrator and GoldBuyer, as far as the executor reads them. */
class FakeNode {
  block = 1_000n;
  impl: Address = ALTANA_ACCOUNT_IMPLEMENTATION;
  counter = 4n;
  preflightErr: Hex = "0x00000000";
  /** What a landed purchase emits: "buy" (IntentExecuted ok + fee + Bought), "nobuy" (IntentExecuted err), or "none" (no receipt yet). */
  landing: "buy" | "nobuy" | "none" = "buy";
  balance = 10n ** 18n;
  txCount = 0;
  sent: { hash: Hex; from: Address; to: Address; data: Hex; nonce: number }[] = [];
  preflights: Hex[] = [];
  methods: string[] = [];
  onSend?: (hash: Hex, data: Hex) => void;
  constructor(readonly wallet: Address, readonly keyHash: Hex, readonly keyAddress: Address) {}

  nonce() {
    return laneNonce(sdkLaneSeqKey(this.keyHash), this.counter);
  }
  private blockObj() {
    return {
      number: toHex(this.block), hash: keccak256(toHex(`b${this.block}`)), parentHash: keccak256(toHex(`b${this.block - 1n}`)),
      timestamp: toHex(NOW), baseFeePerGas: toHex(25_000_000_000n), gasLimit: toHex(50_000_000n), gasUsed: "0x0",
      miner: ALTANA_FEE_RECIPIENT, transactions: [], logsBloom: `0x${"00".repeat(256)}`, extraData: "0x", size: "0x1",
      stateRoot: keccak256("0x01"), receiptsRoot: keccak256("0x02"), transactionsRoot: keccak256("0x03"), uncles: [], sha3Uncles: keccak256("0x04"),
    };
  }
  private log(address: Address, topics: Hex[], data: Hex, hash: Hex, i: number) {
    return { address, topics, data, blockNumber: toHex(this.block), blockHash: keccak256(toHex(`b${this.block}`)), transactionHash: hash, transactionIndex: "0x0", logIndex: toHex(i), removed: false };
  }
  private receipt(hash: Hex) {
    const tx = this.sent.find((t) => t.hash === hash);
    if (!tx || this.landing === "none") return null;
    const { args } = decodeFunctionData({ abi: orchestratorAbi, data: tx.data });
    const [intent] = decodeAbiParameters([INTENT_ABI_PARAMETER], args[0] as Hex);
    const ok = this.landing === "buy";
    const logs = [
      ...(ok ? [this.log(USDT, encodeEventTopics({ abi: transferEvent, eventName: "Transfer", args: { from: this.wallet, to: intent.paymentRecipient } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [intent.paymentAmount]), hash, 0)] : []),
      ...(ok ? [this.log(GOLD_BUYER, encodeEventTopics({ abi: goldBuyerAbi, eventName: "Bought", args: { buyer: this.wallet } }) as Hex[], encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1_000_000n, 280n]), hash, 1)] : []),
      this.log(ALTANA_ORCHESTRATOR, encodeEventTopics({ abi: orchestratorAbi, eventName: "IntentExecuted", args: { eoa: intent.eoa, nonce: intent.nonce } }) as Hex[],
        encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [true, ok ? "0x00000000" : "0x9054c912"]), hash, 2),
    ];
    return {
      transactionHash: hash, transactionIndex: "0x0", blockHash: keccak256(toHex(`b${this.block}`)), blockNumber: toHex(this.block),
      from: tx.from, to: tx.to, cumulativeGasUsed: "0x5c5be", gasUsed: "0x5c5be", effectiveGasPrice: toHex(25_000_000_000n),
      contractAddress: null, logs, logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2",
    };
  }
  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    this.methods.push(method);
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId": return toHex(42220);
      case "eth_blockNumber": return toHex(this.block);
      case "eth_getBlockByNumber": return this.blockObj();
      case "eth_maxPriorityFeePerGas": return toHex(1_000_000n);
      case "eth_getBalance": return toHex(this.balance);
      case "eth_getTransactionCount": return toHex(this.txCount);
      case "eth_estimateGas": return toHex(520_000n);
      case "eth_getTransactionReceipt": return this.receipt(p[0] as Hex);
      case "eth_sendRawTransaction": {
        const raw = p[0] as Hex;
        const tx = parseTransaction(raw);
        const hash = keccak256(raw);
        const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
        this.sent.push({ hash, from, to: getAddress(tx.to!), data: tx.data!, nonce: tx.nonce! });
        this.txCount++;
        this.onSend?.(hash, tx.data!);
        return hash;
      }
      case "eth_call": {
        const { to, data } = p[0] as { to: Address; data: Hex };
        const sel = data.slice(0, 10);
        if (getAddress(to) === ALTANA_ORCHESTRATOR && sel === toFunctionSelector("accountImplementationOf(address)")) {
          return encodeFunctionResult({ abi: orchestratorAbi, functionName: "accountImplementationOf", result: this.impl });
        }
        if (getAddress(to) === ALTANA_ORCHESTRATOR && sel === toFunctionSelector("execute(bytes)")) {
          this.preflights.push(data);
          return encodeFunctionResult({ abi: orchestratorAbi, functionName: "execute", result: this.preflightErr });
        }
        if (getAddress(to) === this.wallet && sel === toFunctionSelector("getKey(bytes32)")) {
          return encodeFunctionResult({
            abi: altanaAccountAbi, functionName: "getKey",
            result: { expiry: Number(NOW) + 86_400, keyType: 2, isSuperAdmin: false, publicKey: `0x${this.keyAddress.slice(2).toLowerCase().padStart(64, "0")}` },
          });
        }
        if (getAddress(to) === this.wallet && sel === toFunctionSelector("getNonce(uint192)")) {
          return encodeFunctionResult({ abi: ithacaAccountNonceAbi, functionName: "getNonce", result: this.nonce() });
        }
        throw new Error(`fake node: unexpected eth_call to ${to} ${sel}`);
      }
    }
    throw new Error(`fake node: unexpected ${method}`);
  }
}

/** A relay that prepares like Altana's (fields of the real 0xe6f4… intent) and records every call. */
class FakeRelay {
  calls: { method: string; params: unknown[] }[] = [];
  fee = BigInt(REAL.paymentMaxAmount as string); // 19,648 USD₮ base units: the relay's maximum on our real purchase
  patch: (intent: Record<string, unknown>, params: Record<string, any>) => void = () => {};
  fail?: Error;
  request: RelayRequest = async (method, params) => {
    this.calls.push({ method, params: [...params] });
    if (this.fail) throw this.fail;
    if (method !== "wallet_prepareCalls") throw new Error(`fake relay: ${method} is not served`);
    const q = params[0] as Record<string, any>;
    const calls: Call[] = q.calls.map((c: { to: Address; data: Hex; value: Hex }) => ({ to: c.to, data: c.data, value: BigInt(c.value) }));
    const answer = structuredClone(fixture.prepareCalls.result) as unknown as Answer & { context: { quote: { quotes: Record<string, unknown>[] } } };
    const intent: Record<string, unknown> = {
      ...REAL,
      eoa: q.from.toLowerCase(),
      executionData: encodeExecutionData(calls),
      nonce: q.capabilities.meta.nonce,
      paymentToken: q.capabilities.meta.feeToken.toLowerCase(),
      paymentMaxAmount: toHex(this.fee),
      paymentAmount: toHex(this.fee),
      paymentRecipient: ALTANA_FEE_RECIPIENT.toLowerCase(),
      signature: "0x",
    };
    this.patch(intent, q);
    answer.context.quote.quotes[0]!.intent = intent;
    return answer;
  };
}

async function setup(opts: { quoteMaxAgeMs?: number; clock?: () => number } = {}) {
  const sessionPk = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionPk);
  const ids = sessionKeyIds(sessionAccount.publicKey);
  const wallet = getAddress("0xA177651FC7F9BfF0804ad123c4fdb8aa6625683C");
  const node = new FakeNode(wallet, ids.keyHash, ids.address);
  const relay = new FakeRelay();
  const agentKey = generatePrivateKey();
  const logs: { msg: string; data?: Record<string, unknown> }[] = [];
  const ex = createDirectPreparedExecutor({
    rpcUrl: "http://unused", transport: custom({ request: (a) => node.request(a) }), chain,
    submitterKey: agentKey, goldBuyer: GOLD_BUYER, relayRequest: relay.request,
    receiptTimeoutMs: 3_000, nonceSettleMs: 0, log: (msg, data) => logs.push({ msg, ...(data ? { data } : {}) }),
    ...(opts.quoteMaxAgeMs !== undefined ? { quoteMaxAgeMs: opts.quoteMaxAgeMs } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const session: SerializedSession = { walletAddress: wallet, publicKey: sessionAccount.publicKey, permissions: { calls: [], spend: [] }, expiry: Number(NOW) + 86_400 };
  const calls = buildBuyCalls(1_000_000n, 280n, GOLD_BUYER);
  return { node, relay, ex, session, sessionPk, sessionAccount, ids, wallet, calls, agent: privateKeyToAccount(agentKey).address, logs };
}

const sentIntent = (data: Hex): Intent => {
  const body = slice(data, 0, size(data) - size(ATTRIBUTION_SUFFIX));
  const { args } = decodeFunctionData({ abi: orchestratorAbi, data: body });
  return decodeAbiParameters([INTENT_ABI_PARAMETER], args[0] as Hex)[0] as Intent;
};

describe("direct-prepared executor", () => {
  it("quote: asks the relay exactly as the SDK would, checks the answer, returns the relay's fee; signs and sends nothing", async () => {
    const s = await setup();
    const q = await s.ex.quote({ session: s.session, privateKey: s.sessionPk, calls: s.calls });
    expect(q).toEqual({ fee: 19_648n, feeToken: USDT });
    expect(s.relay.calls.map((c) => c.method)).toEqual(["wallet_prepareCalls"]);
    const params = s.relay.calls[0]!.params[0] as Record<string, any>;
    expect(params.from).toBe(s.wallet);
    expect(params.key).toEqual({ prehash: false, publicKey: `0x${s.ids.address.slice(2).toLowerCase().padStart(64, "0")}`, type: "secp256k1" });
    expect(BigInt(params.capabilities.meta.nonce)).toBe(laneNonce(sdkLaneSeqKey(s.ids.keyHash), 4n)); // the SDK's lane, the account's counter
    expect(params.capabilities.meta.feeToken).toBe(USDT);
    expect(params.calls.map((c: { data: Hex }) => c.data)).toEqual(s.calls.map((c) => c.data)); // each call still carries the tag
    expect(s.node.sent).toHaveLength(0);
    expect(s.node.preflights).toHaveLength(0);
  });

  it("execute after quote: signs the very intent quoted, sends it from the agent EOA with the tag last, and Celo's verifyTx credits it", async () => {
    const s = await setup();
    await s.ex.quote({ session: s.session, privateKey: s.sessionPk, calls: s.calls });
    const r = await s.ex.execute({ session: s.session, privateKey: s.sessionPk, calls: s.calls });
    expect(r.status).toBe("CONFIRMED");
    expect(s.relay.calls).toHaveLength(1); // the quoted intent was reused, not re-prepared
    expect(s.relay.calls.every((c) => c.method === "wallet_prepareCalls")).toBe(true);

    expect(s.node.sent).toHaveLength(1);
    const tx = s.node.sent[0]!;
    expect(tx.hash).toBe(r.transactionHash);
    expect(tx.from).toBe(s.agent);
    expect(tx.to).toBe(ALTANA_ORCHESTRATOR);
    expect(tx.data.slice(0, 10)).toBe(toFunctionSelector("execute(bytes)"));
    expect(tx.data.toLowerCase().endsWith(ATTRIBUTION_SUFFIX.slice(2).toLowerCase())).toBe(true);
    expect(await verifyTx({ client: { getTransaction: async () => ({ input: tx.data }) } as never, hash: tx.hash })).toEqual({ codes: [ATTRIBUTION_CODE], schemaId: 0 });
    expect(s.node.preflights).toEqual([tx.data]); // the preflight ran on the exact bytes that were sent

    // Every field is the relay's; only the signature is ours, over the locally computed digest, by the session key.
    const i = sentIntent(tx.data);
    expect(i.paymentToken).toBe(USDT);
    expect(i.paymentRecipient).toBe(ALTANA_FEE_RECIPIENT);
    expect(i.paymentAmount).toBe(19_648n);
    expect(i.paymentMaxAmount).toBe(19_648n);
    expect(i.expiry).toBe(0n);
    expect(i.combinedGas).toBe(BigInt(REAL.combinedGas as string));
    expect(i.supportedAccountImplementation).toBe(ALTANA_ACCOUNT_IMPLEMENTATION);
    expect(i.nonce).toBe(s.node.nonce());
    expect(i.executionData).toBe(encodeExecutionData(s.calls).toLowerCase());
    expect(size(i.signature)).toBe(98);
    expect(slice(i.signature, 65, 97)).toBe(s.ids.keyHash);
    expect(slice(i.signature, 97)).toBe("0x00");
    const digest = intentDigest({ ...i, calls: s.calls });
    expect(await recoverAddress({ hash: digest, signature: slice(i.signature, 0, 65) })).toBe(s.ids.address);
    expect(slice(tx.data, 0, size(tx.data) - 35)).toBe(
      encodeFunctionData({ abi: orchestratorAbi, functionName: "execute", args: [encodeIntent(i)] }),
    );
    expect(s.ex.lastOutcome()).toMatchObject({ bought: { amountIn: 1_000_000n, out: 280n }, intentExecuted: { incremented: true, err: "0x00000000" } });
  });

  it("execute without a quote (the probe path) prepares afresh and holds the fee to the ceiling", async () => {
    const s = await setup();
    const r = await s.ex.execute({ session: s.session, privateKey: s.sessionPk, calls: s.calls });
    expect(r.status).toBe("CONFIRMED");
    expect(s.relay.calls).toHaveLength(1);

    const t = await setup();
    t.relay.fee = 50_001n; // above the 0.05 USD₮ ceiling
    const e = await t.ex.execute({ session: t.session, privateKey: t.sessionPk, calls: t.calls }).then(() => null, (x) => x);
    expect(explainAltanaError(e)).toMatchObject({ kind: "relay_failure", bought: "no" });
    expect((e as Error).message).toMatch(/above the plan's allowance 50000/);
    expect(t.node.sent).toHaveLength(0);
  });

  it("re-prepares when the quoted intent is stale or its nonce was used meanwhile", async () => {
    let now = 0;
    const s = await setup({ clock: () => now, quoteMaxAgeMs: 1_000 });
    await s.ex.quote({ session: s.session, privateKey: s.sessionPk, calls: s.calls });
    now = 5_000;
    await s.ex.execute({ session: s.session, privateKey: s.sessionPk, calls: s.calls });
    expect(s.relay.calls).toHaveLength(2);

    const t = await setup();
    await t.ex.quote({ session: t.session, privateKey: t.sessionPk, calls: t.calls });
    t.node.counter++; // something else landed on the lane
    await t.ex.execute({ session: t.session, privateKey: t.sessionPk, calls: t.calls });
    expect(t.relay.calls).toHaveLength(2);
    expect(sentIntent(t.node.sent[0]!.data).nonce).toBe(t.node.nonce());
  });

  it("refuses, before signing or sending, any prepared intent that is not exactly what was asked for", async () => {
    const other = "0x2222222222222222222222222222222222222222";
    const cases: [string, (i: Record<string, unknown>, q: Record<string, any>) => void, RegExp][] = [
      ["fee to someone else", (i) => (i.paymentRecipient = other), /fee recipient/],
      ["fee in CELO", (i) => (i.paymentToken = "0x0000000000000000000000000000000000000000"), /fee token/],
      ["another wallet", (i) => (i.eoa = other), /eoa is/],
      ["an extra call", (i, q) => (i.executionData = encodeExecutionData([...q.calls.map((c: any) => ({ ...c, value: BigInt(c.value) })), { to: USDT, data: "0x", value: 0n }])), /executionData/],
      ["another nonce", (i) => (i.nonce = "0x1"), /nonce/],
      ["a payer", (i) => (i.payer = other), /payer/],
      ["pre-calls", (i) => (i.encodedPreCalls = ["0x00"]), /pre-calls/],
      ["no account pin", (i) => (i.supportedAccountImplementation = "0x0000000000000000000000000000000000000000"), /supportedAccountImplementation/],
    ];
    for (const [label, patch, msg] of cases) {
      const s = await setup();
      s.relay.patch = patch;
      for (const op of ["quote", "execute"] as const) {
        const e = await s.ex[op]({ session: s.session, privateKey: s.sessionPk, calls: s.calls }).then(() => null, (x) => x);
        expect((e as Error)?.message, `${label} (${op})`).toMatch(msg);
        expect(explainAltanaError(e), label).toMatchObject({ bought: "no" });
      }
      expect(s.node.sent, label).toHaveLength(0);
      expect(s.node.preflights, label).toHaveLength(0);
    }
  });

  it("maps relay refusals and the preflight to the runner's kinds, with nothing sent", async () => {
    const relayErr = async (message: string) => {
      const s = await setup();
      s.relay.fail = new Error(message);
      const e = await s.ex.quote({ session: s.session, privateKey: s.sessionPk, calls: s.calls }).then(() => null, (x) => x);
      expect(s.node.sent).toHaveLength(0);
      return explainAltanaError(e);
    };
    expect(await relayErr("execution reverted: ExceededSpendLimit(0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e)")).toMatchObject({ kind: "cap_exceeded", bought: "no" });
    expect(await relayErr("execution reverted: OLD")).toMatchObject({ kind: "twap_unavailable", bought: "no" });
    expect(await relayErr("fetch failed")).toMatchObject({ kind: "relay_failure", bought: "no" });

    const s = await setup();
    s.node.preflightErr = "0x9054c912"; // ExceededSpendLimit
    const e = await s.ex.execute({ session: s.session, privateKey: s.sessionPk, calls: s.calls }).then(() => null, (x) => x);
    expect(explainAltanaError(e)).toMatchObject({ kind: "cap_exceeded", bought: "no" });
    expect(s.node.sent).toHaveLength(0);

    const w = await setup();
    w.node.impl = "0x0000000000000000000000000000000000000001";
    const we = await w.ex.quote({ session: w.session, privateKey: w.sessionPk, calls: w.calls }).then(() => null, (x) => x);
    expect((we as Error).message).toMatch(/account implementation/);
    expect(w.relay.calls).toHaveLength(0); // refused before asking the relay
  });

  it("reports FAILED when the intent lands without a purchase, PENDING without a receipt, and never decides from the outer status", async () => {
    const s = await setup();
    s.node.landing = "nobuy";
    expect(await s.ex.execute({ session: s.session, privateKey: s.sessionPk, calls: s.calls })).toMatchObject({ status: "FAILED", statusCode: 500 });
    expect(s.ex.lastOutcome()?.intentExecuted?.errName).toBe("ExceededSpendLimit");

    const t = await setup();
    t.node.landing = "none";
    const r = await t.ex.execute({ session: t.session, privateKey: t.sessionPk, calls: t.calls });
    expect(r.status).toBe("PENDING");
    expect(r.transactionHash).toBe(t.node.sent[0]!.hash);
  }, 20_000);

  it("refuses to send with too little CELO in the agent EOA", async () => {
    const s = await setup();
    s.node.balance = 1n;
    const e = await s.ex.execute({ session: s.session, privateKey: s.sessionPk, calls: s.calls }).then(() => null, (x) => x);
    expect(explainAltanaError(e)).toMatchObject({ kind: "relay_failure", bought: "no" });
    expect((e as Error).message).toMatch(/gas account/);
    expect(s.node.sent).toHaveLength(0);
  });
});

describe("the runner with the direct-prepared executor", () => {
  /** A plan whose session key is the one the fake node knows. The runner's chain port is the usual FakeChain. */
  async function runnerSetup() {
    const now = Number(NOW);
    const storage = new MemoryStorage();
    const fakeChain = new FakeChain(now);
    const encryptionKey = randomBytes(32);
    const wallet = getAddress("0xA177651FC7F9BfF0804ad123c4fdb8aa6625683C");
    const { plan, sessionPublicKey, grant } = await createPlan(
      { storage, encryptionKey, goldBuyer: GOLD_BUYER, now },
      { walletAddress: wallet, amountPerBuy: 1_000_000n, period: "day", expiresAt: now + 60 * 86_400, dayOfWeek: 0, hourUtc: 0 },
    );
    fakeChain.cap = grant.periodCap;
    fakeChain.period = grant.period;
    fakeChain.expiry = grant.expiry;
    fakeChain.quoteOut = 1_400n;
    await storage.activatePlan(plan.id, {
      walletAddress: wallet, publicKey: sessionPublicKey,
      permissions: { calls: grant.permissions.calls, spend: grant.permissions.spend.map((x) => ({ limit: x.limit.toString(), period: x.period, token: x.token! })) },
      expiry: grant.expiry,
    });
    const ids = sessionKeyIds(sessionPublicKey);
    const node = new FakeNode(wallet, ids.keyHash, ids.address);
    const relay = new FakeRelay();
    const ex = createDirectPreparedExecutor({
      rpcUrl: "http://unused", transport: custom({ request: (a) => node.request(a) }), chain,
      submitterKey: generatePrivateKey(), goldBuyer: GOLD_BUYER, relayRequest: relay.request, receiptTimeoutMs: 3_000, nonceSettleMs: 0,
    });
    // A landed transaction shows up in the runner's chain reads as the wallet's purchase.
    node.onSend = (hash) => {
      const p = fakeChain.land(wallet, 1_000_000n, 280n);
      fakeChain.receipts.set(hash.toLowerCase(), [{ ...p, txHash: hash }]);
      fakeChain.purchases[fakeChain.purchases.length - 1] = { ...p, txHash: hash };
    };
    const runner = createRunner({ storage, chain: fakeChain, executor: ex, encryptionKey, goldBuyer: GOLD_BUYER, recheckDelayMs: 0, sleep: async () => {} });
    return { runner, node, relay, fakeChain };
  }

  it("buys once with the relay's fee inside the allowance, then already_bought", async () => {
    const s = await runnerSetup();
    const first = (await s.runner.tick()).plans[0]!;
    expect(first).toMatchObject({ decision: "bought", txHash: s.node.sent[0]!.hash });
    expect(s.relay.calls).toHaveLength(1); // quote's prepared intent is the one signed
    const second = (await s.runner.tick()).plans[0]!;
    expect(second).toMatchObject({ decision: "already_bought" });
    expect(s.node.sent).toHaveLength(1);
  });

  it("skips with fee_too_high when the relay's fee is above the plan's allowance; nothing signed or sent", async () => {
    const s = await runnerSetup();
    s.relay.fee = 50_001n;
    const r = (await s.runner.tick()).plans[0]!;
    expect(r).toMatchObject({ decision: "skipped", kind: "fee_too_high" });
    expect(s.node.sent).toHaveLength(0);
    expect(s.node.preflights).toHaveLength(0);
  });
});
