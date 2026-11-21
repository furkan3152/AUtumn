/**
 * Proof of the direct submitter (docs/direct-submit.md) on a local anvil fork
 * of Celo mainnet. No real funds and no mainnet transaction: every write goes
 * to the local fork. Skipped when anvil is not installed.
 *
 * It sets up an Altana wallet the way mainnet has one (EIP-7702 delegation to
 * the real Altana account proxy, an admin key, a session key with our grant's
 * permissions and cap plus the Orchestrator any-selector entry the SDK's Porto
 * layer adds to every session key, KeyStore registrations paying the real fee
 * with fork CELO), deploys GoldBuyer, and then runs, with the agent's own EOA
 * as submitter:
 *   0. core's sessionLimitsMismatch accepts that allowlist, and the session
 *      key cannot use the Orchestrator entry to send CELO or to approve past
 *      the cap (preflight eth_calls of signed intents; nothing is sent),
 *   1. one purchase (must buy; Celo's verifyTx must return our code),
 *   2. one purchase over the cap (must be refused, and when forced on chain, must buy nothing),
 *   3. one purchase after revoking the key (must be refused, and when forced, must buy nothing),
 *   4. the runner end to end with this executor on the same real-shaped grant
 *      (buys once, then already_bought), and a control wallet whose session
 *      also has any-function on GoldBuyer (the runner refuses it).
 *
 * Env: ANVIL_BIN (default ~/.foundry/bin/anvil or PATH), FORK_URL (default
 * forno), FORK_BLOCK (default latest), DIRECT_FORK_OUT (write the JSON record there).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  pad,
  padHex,
  parseAbi,
  parseEventLogs,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { signerFromPrivateKey, type SerializedSession } from "@altananetwork/sdk";
import {
  ALTANA_ACCOUNT_PROXY,
  ALTANA_KEYSTORE,
  ALTANA_KEYSTORE_CONTROLLER,
  ALTANA_ORCHESTRATOR,
  ATTRIBUTION_CODE,
  ATTRIBUTION_SUFFIX,
  buildBuyCalls,
  buildSessionIntent,
  createCeloPublicClient,
  directLaneSeqKey,
  executeCalldata,
  fromDataSuffix,
  intentDigest,
  ithacaAccountNonceAbi,
  orchestratorAbi,
  ANY_SELECTOR,
  quoteBuy,
  readSessionState,
  sessionKeyIds,
  SPEND_PERIOD,
  sessionLimitsMismatch,
  USDT,
  verifyTx,
  XAUT0,
  wrapKeySignature,
  type Call,
} from "@autumn/core";
import { createDirectExecutor } from "../src/direct.js";
import { createChainReader } from "../src/adapters.js";
import { decryptSessionKey } from "../src/crypto.js";
import { createPlan } from "../src/plans.js";
import { createRunner } from "../src/runner.js";
import { MemoryStorage } from "../src/storage/memory.js";

function findAnvil(): string | undefined {
  const candidates = [process.env.ANVIL_BIN, join(homedir(), ".foundry/bin/anvil")].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  const w = spawnSync("sh", ["-c", "command -v anvil"], { encoding: "utf8" });
  return w.status === 0 && w.stdout.trim() ? w.stdout.trim() : undefined;
}
const ANVIL = findAnvil();
const GOLD_BUYER_ARTIFACT = fileURLToPath(new URL("../../contracts/out/GoldBuyer.sol/GoldBuyer.json", import.meta.url));

const accountAbi = parseAbi([
  "function execute(bytes32 mode, bytes executionData) payable",
  "function authorize((uint40 expiry, uint8 keyType, bool isSuperAdmin, bytes publicKey) key) returns (bytes32)",
  "function revoke(bytes32 keyHash)",
  "function setCanExecute(bytes32 keyHash, address target, bytes4 fnSel, bool can)",
  "function setSpendLimit(bytes32 keyHash, address token, uint8 period, uint256 limit)",
  "function getKeys() view returns ((uint40 expiry, uint8 keyType, bool isSuperAdmin, bytes publicKey)[] keys, bytes32[] keyHashes)",
]);
const controllerAbi = parseAbi([
  "function initialRegisterKey(bytes32 keyId, address validator, bytes metadata, bytes publicKey, uint40 expiry) payable",
  "function registerKey(bytes32 keyId, address validator, bytes metadata, bytes publicKey, uint40 expiry) payable",
  "function getRegistrationFeeInWei() view returns (uint256)",
]);
const keyStoreAbi = parseAbi([
  "function revokeKey(address user, bytes32 keyId)",
  "function isValidKey(address user, bytes32 keyId) view returns (bool)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** ERC-7821 batch mode without opData (self-call by the EOA). */
const MODE_BATCH = pad("0x01", { dir: "right", size: 32 });
/** USD₮ `balanceOf` mapping slot (found on the fork by probing; not a public constant). */
const USDT_BALANCE_SLOT = 51n;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

describe.skipIf(!ANVIL || !existsSync(GOLD_BUYER_ARTIFACT))("direct submitter on a Celo mainnet fork", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let pub: PublicClient;
  let coreClient: ReturnType<typeof createCeloPublicClient>;
  const record: Record<string, unknown> = {};
  const funderPk = generatePrivateKey(); // deploys GoldBuyer and submits admin intents
  const agentKey = generatePrivateKey(); // the agent EOA (direct submitter)
  let goldBuyer: Address;

  const rpcCall = async (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
  const setNextTime = async (t: bigint) => {
    await rpcCall("evm_setNextBlockTimestamp", [toHex(t)]);
    await rpcCall("evm_mine", []);
  };
  const mine = (n: number) => rpcCall("anvil_mine", [toHex(n), toHex(1)]);
  /** Advance time by mining one block per second, as Celo does (the runner's block search assumes ~1 s blocks). */
  const advance = (secs: number) => mine(secs);
  const nowTs = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
  const usdtOf = (a: Address) => pub.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [a] });
  const giveUsdt = async (a: Address, amount: bigint) => {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [a, USDT_BALANCE_SLOT]));
    await rpcCall("anvil_setStorageAt", [USDT, slot, pad(toHex(amount), { size: 32 })]);
    expect(await usdtOf(a)).toBe(amount);
  };
  const send = async (pk: Hex, tx: { to: Address; data: Hex; value?: bigint }) => {
    const w = createWalletClient({ chain: celo, transport: http(rpc), account: privateKeyToAccount(pk) });
    const hash = await w.sendTransaction({ ...tx, chain: celo });
    return pub.waitForTransactionReceipt({ hash });
  };

  /** The account's view of a secp256k1 key: publicKey is abi.encode(address). */
  const accountKey = (address: Address, opts: { expiry: number; superAdmin: boolean }) => ({
    expiry: opts.expiry,
    keyType: 2,
    isSuperAdmin: opts.superAdmin,
    publicKey: padHex(address, { size: 32 }),
  });
  const keyHashOf = (address: Address) =>
    keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [2, keccak256(padHex(address, { size: 32 }))]));

  /** An admin intent, signed by the admin key and submitted through the real Orchestrator (as the relay would). */
  async function adminIntent(wallet: Address, adminPk: Hex, calls: Call[], fundsFrom: Hex) {
    const admin = signerFromPrivateKey(adminPk);
    const keyHash = keyHashOf(admin.address);
    const nonce = await pub.readContract({ address: wallet, abi: ithacaAccountNonceAbi, functionName: "getNonce", args: [directLaneSeqKey(keyHash)] });
    const { intent } = buildSessionIntent({ wallet, calls, nonce, combinedGas: 2_000_000n, expiry: (await nowTs()) + 600n });
    intent.signature = wrapKeySignature(await admin.signDigest(intentDigest({ ...intent, calls })), keyHash);
    const receipt = await send(fundsFrom, { to: ALTANA_ORCHESTRATOR, data: executeCalldata(intent, null) });
    const ev = parseEventLogs({ abi: orchestratorAbi, eventName: "IntentExecuted", logs: receipt.logs });
    expect(ev.at(-1)?.args.err).toBe("0x00000000");
    return receipt;
  }

  /**
   * A wallet as mainnet has one after `createWallet` + `grantSession`:
   * - code = 0xef0100 ‖ Altana's account proxy (EIP-7702), implementation IthacaAccount 0.5.10;
   * - an admin key (super admin) authorised on the account and registered as root in the KeyStore;
   * - the session key: expiry, the allowlist a real grant stores (`grant.onchainCalls`: USD₮.approve,
   *   GoldBuyer.buy and the Orchestrator any-selector entry Porto adds; plus `extraCalls` for a control),
   *   one USD₮ cap, KeyStore-registered.
   */
  async function setUpWallet(
    ownerPk: Hex,
    sessionPublicKey: Hex,
    grant: { periodCap: bigint; period: "day" | "week"; expiry: number; onchainCalls: readonly { target: Address; selector: Hex }[] },
    extraCalls: { target: Address; selector: Hex }[] = [],
  ) {
    const owner = privateKeyToAccount(ownerPk);
    const adminPk = generatePrivateKey();
    const admin = privateKeyToAccount(adminPk);
    const wallet = owner.address;
    await rpcCall("anvil_setBalance", [wallet, toHex(100n * 10n ** 18n)]);
    await giveUsdt(wallet, 20_000_000n);
    // Warm the fork's cache for slots the runner reads later (a cold slot is fetched from forno, which can be slow).
    await pub.readContract({ address: XAUT0, abi: erc20, functionName: "balanceOf", args: [wallet] });

    // 1. EIP-7702: delegate to the Altana proxy and authorise the admin key, in one self-sponsored type-4 tx.
    const ownerClient = createWalletClient({ chain: celo, transport: http(rpc), account: owner });
    const authorization = await ownerClient.signAuthorization({ contractAddress: ALTANA_ACCOUNT_PROXY, executor: "self" });
    const calls1 = [{ to: wallet, value: 0n, data: encodeFunctionData({ abi: accountAbi, functionName: "authorize", args: [accountKey(admin.address, { expiry: 0, superAdmin: true })] }) }];
    const execData = encodeAbiParameters([{ type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], [calls1]);
    const h1 = await ownerClient.sendTransaction({
      chain: celo, to: wallet, authorizationList: [authorization],
      data: encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [MODE_BATCH, execData] }),
    });
    const r1 = await pub.waitForTransactionReceipt({ hash: h1 });
    expect(r1.status).toBe("success");
    expect(await pub.getCode({ address: wallet })).toBe(`0xef0100${ALTANA_ACCOUNT_PROXY.slice(2).toLowerCase()}`);

    // 2. The grant, as one admin intent through the Orchestrator: KeyStore registrations (real fee) + account permissions.
    const fee = await pub.readContract({ address: ALTANA_KEYSTORE_CONTROLLER, abi: controllerAbi, functionName: "getRegistrationFeeInWei" });
    const value = (fee * 110n) / 100n; // the SDK's 10% headroom, refunded by the controller
    const session = sessionKeyIds(sessionPublicKey);
    const self = (data: Hex): Call => ({ to: wallet, value: 0n, data });
    const grantCalls: Call[] = [
      { to: ALTANA_KEYSTORE_CONTROLLER, value, data: encodeFunctionData({ abi: controllerAbi, functionName: "initialRegisterKey", args: [keccak256(admin.publicKey), "0x0000000000000000000000000000000000000000", "0x", admin.publicKey, 0] }) },
      { to: ALTANA_KEYSTORE_CONTROLLER, value, data: encodeFunctionData({ abi: controllerAbi, functionName: "registerKey", args: [session.keyId, "0x0000000000000000000000000000000000000000", "0x", session.publicKey, grant.expiry] }) },
      self(encodeFunctionData({ abi: accountAbi, functionName: "authorize", args: [accountKey(session.address, { expiry: grant.expiry, superAdmin: false })] })),
      ...[...grant.onchainCalls, ...extraCalls].map((c) =>
        self(encodeFunctionData({ abi: accountAbi, functionName: "setCanExecute", args: [session.keyHash, c.target, c.selector, true] })),
      ),
      self(encodeFunctionData({ abi: accountAbi, functionName: "setSpendLimit", args: [session.keyHash, USDT, SPEND_PERIOD[grant.period], grant.periodCap] })),
    ];
    const celoBefore = await pub.getBalance({ address: wallet });
    const rg = await adminIntent(wallet, adminPk, grantCalls, funderPk);
    const celoAfter = await pub.getBalance({ address: wallet });
    return { wallet, adminPk, admin: admin.address, grantTx: rg.transactionHash, grantGas: rg.gasUsed, registrationFeeWei: fee, celoSpentOnGrant: celoBefore - celoAfter, keyIds: { session: session.keyId } };
  }

  beforeAll(async () => {
    const port = 18_000 + Math.floor(Math.random() * 2000);
    rpc = `http://127.0.0.1:${port}`;
    // --prune-history keeps states in memory only (anvil otherwise writes old states to ~/.foundry/anvil/tmp).
    const args = ["--fork-url", process.env.FORK_URL ?? "https://forno.celo.org", "--hardfork", "prague", "--port", String(port), "--silent", "--prune-history", "400", "--timeout", "15000", "--retries", "8"];
    if (process.env.FORK_BLOCK) args.push("--fork-block-number", process.env.FORK_BLOCK);
    let anvilErr = "";
    anvil = spawn(ANVIL!, args, { stdio: ["ignore", "ignore", "pipe"] });
    anvil.stderr?.on("data", (d) => (anvilErr += String(d)));
    pub = createPublicClient({ chain: celo, transport: http(rpc, { retryCount: 0, timeout: 5_000 }) }) as PublicClient;
    for (let i = 0; ; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        if (i > 120 || anvil.exitCode !== null) throw new Error(`anvil did not start: ${anvilErr.slice(0, 500)}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    pub = createPublicClient({ chain: celo, transport: http(rpc, { timeout: 60_000 }) }) as PublicClient;
    coreClient = createCeloPublicClient(rpc);
    const forkBlock = await pub.getBlock({ blockTag: "latest" });
    // One time jump, before GoldBuyer exists: 31 minutes, so the pool's single oracle observation is old enough
    // for GoldBuyer's 30-minute TWAP; past the next Monday 00:00 UTC if that is close, so the weekly cap
    // cannot reset in the middle of the run. After this, time only moves by mining 1-second blocks.
    let start = forkBlock.timestamp + 31n * 60n;
    const week = 7n * 86_400n;
    const nextMonday = ((start - 4n * 86_400n) / week + 1n) * week + 4n * 86_400n; // epoch day 0 was a Thursday
    if (nextMonday - start < 3n * 3600n) start = nextMonday + 60n;
    await setNextTime(start);
    record.fork = { rpc: "local anvil", forkOf: process.env.FORK_URL ?? "https://forno.celo.org", block: forkBlock.number, timestamp: forkBlock.timestamp, anvil: spawnSync(ANVIL!, ["--version"], { encoding: "utf8" }).stdout.split("\n")[0] };

    await rpcCall("anvil_setBalance", [privateKeyToAccount(funderPk).address, toHex(100n * 10n ** 18n)]);
    await rpcCall("anvil_setBalance", [privateKeyToAccount(agentKey).address, toHex(10n ** 18n)]);
    const artifact = JSON.parse(readFileSync(GOLD_BUYER_ARTIFACT, "utf8")) as { bytecode: { object: Hex } };
    const fw = createWalletClient({ chain: celo, transport: http(rpc), account: privateKeyToAccount(funderPk) });
    const deployHash = await fw.deployContract({ abi: [], bytecode: artifact.bytecode.object, chain: celo });
    const dr = await pub.waitForTransactionReceipt({ hash: deployHash });
    goldBuyer = getAddress(dr.contractAddress!);
    record.goldBuyer = { address: goldBuyer, deployTx: deployHash, block: dr.blockNumber };
  }, 120_000);

  afterAll(() => {
    anvil?.kill("SIGKILL");
    if (process.env.DIRECT_FORK_OUT) writeFileSync(process.env.DIRECT_FORK_OUT, json(record));
    console.log(json(record));
  });

  it("buys once, refuses over the cap and after revoke, and Celo's verifyTx finds our tag", async () => {
    const t0 = await nowTs();

    const storage = new MemoryStorage();
    const encryptionKey = randomBytes(32);
    const ownerPk = generatePrivateKey();
    const { plan, sessionPublicKey, grant } = await createPlan(
      { storage, encryptionKey, goldBuyer, now: Number(t0) },
      { walletAddress: privateKeyToAccount(ownerPk).address, amountPerBuy: 1_000_000n, period: "week", expiresAt: Number(t0) + 30 * 86_400, dayOfWeek: 0, hourUtc: 0 },
    );
    const sessionPk = decryptSessionKey((await storage.getEncryptedSessionKey(plan.id))!, plan.id, encryptionKey);
    const w = await setUpWallet(ownerPk, sessionPublicKey, grant);
    const session: SerializedSession = {
      walletAddress: w.wallet,
      publicKey: sessionPublicKey,
      permissions: { calls: grant.permissions.calls, spend: grant.permissions.spend.map((s) => ({ limit: s.limit.toString(), period: s.period, token: s.token! })) },
      expiry: grant.expiry,
    };
    const state = await readSessionState(coreClient, { wallet: w.wallet, publicKey: sessionPublicKey, blockNumber: await pub.getBlockNumber() });
    record.wallet = {
      address: w.wallet, code: await pub.getCode({ address: w.wallet }), grantTx: w.grantTx, grantGasUsed: w.grantGas,
      registrationFeeWeiPerKey: w.registrationFeeWei, celoSpentOnGrantWei: w.celoSpentOnGrant,
      sessionState: { status: state.status, keyStoreValid: state.keyStoreValid, allowedCalls: state.allowedCalls, spend: state.spend, expiry: state.accountExpiry },
      plan: { amountPerBuy: 1_000_000n, period: grant.period, periodCap: grant.periodCap },
    };
    expect(state.status).toBe("active");

    const direct = createDirectExecutor({ rpcUrl: rpc, submitterKey: agentKey, goldBuyer, intentTtlSecs: 600 });
    const forced = createDirectExecutor({ rpcUrl: rpc, submitterKey: agentKey, goldBuyer, intentTtlSecs: 600, unsafeSkipPreflight: true });
    const agentCelo0 = await pub.getBalance({ address: direct.submitter });

    // ---- 0. The real-shaped allowlist passes core's check; the Orchestrator entry cannot move funds ----
    {
      expect(grant.onchainCalls.map((c) => c.target)).toContain(getAddress(ALTANA_ORCHESTRATOR));
      const key = (c: { target: Address; selector: Hex }) => `${c.target.toLowerCase()}:${c.selector.toLowerCase()}`;
      expect(new Set(state.allowedCalls.map(key))).toEqual(new Set(grant.onchainCalls.map(key)));
      expect(state.allowedCalls.find((c) => c.target === getAddress(ALTANA_ORCHESTRATOR))?.selector).toBe(ANY_SELECTOR);
      expect(sessionLimitsMismatch(state, grant, goldBuyer)).toBeUndefined();

      // What the session key could try with the entry, signed and checked by eth_call (forced mode: nothing is sent).
      const attacker = privateKeyToAccount(generatePrivateKey()).address;
      const withdraw = (token: Address, amount: bigint) =>
        encodeFunctionData({ abi: parseAbi(["function withdrawTokens(address token, address recipient, uint256 amount)"]), functionName: "withdrawTokens", args: [token, attacker, amount] });
      const approve = (spender: Address, amount: bigint) =>
        encodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 amount)"]), functionName: "approve", args: [spender, amount] });
      const probe = async (calls: Call[]) => {
        const p = await forced.prepare({ session, privateKey: sessionPk, calls }, true);
        return p.preflightErrName ?? p.preflightErr;
      };
      const probes = {
        // Send 1 CELO of the wallet's to the Orchestrator (anyone can then sweep it with withdrawTokens): no native limit.
        celoToOrchestrator: await probe([{ to: ALTANA_ORCHESTRATOR, value: 10n ** 18n, data: "0x" }]),
        // The same with calldata: every other Orchestrator entry point is non-payable or reverts in this context.
        celoWithWithdrawCall: await probe([{ to: ALTANA_ORCHESTRATOR, value: 10n ** 18n, data: withdraw("0x0000000000000000000000000000000000000000", 0n) }]),
        // Approve an attacker for more than the cap, next to an Orchestrator call (withdrawTokens calls out to any
        // `token` contract, so a contract the attacker controls would run mid-batch): the approval itself is metered.
        approvePastCap: await probe([
          { to: USDT, value: 0n, data: approve(attacker, 2_000_000n) },
          { to: ALTANA_ORCHESTRATOR, value: 0n, data: withdraw(USDT, 0n) },
        ]),
        // The entry itself is usable (value 0, the Orchestrator's own balance): it moves nothing of the wallet's.
        withdrawNothing: await probe([{ to: ALTANA_ORCHESTRATOR, value: 0n, data: withdraw(USDT, 0n) }]),
      };
      expect(probes.celoToOrchestrator).toBe("NoSpendPermissions");
      expect(probes.celoWithWithdrawCall).toBe("CallError"); // withdrawTokens is not payable: the batch reverts
      expect(probes.approvePastCap).toBe("ExceededSpendLimit");
      expect(probes.withdrawNothing).toBe("0x00000000");
      record.orchestratorEntry = { allowedCalls: state.allowedCalls, sessionLimitsMismatch: "undefined (accepted)", probes };
    }

    // ---- 1. One purchase ----
    await mine(1);
    const q = await quoteBuy(coreClient, 1_000_000n);
    expect(q.twapTick).not.toBeNull();
    const calls = buildBuyCalls(1_000_000n, q.minOut, goldBuyer);
    const fee = await direct.quote({ session, privateKey: sessionPk, calls });
    expect(fee).toEqual({ fee: 0n, feeToken: USDT });
    const usdt0 = await usdtOf(w.wallet);
    const r1 = await direct.execute({ session, privateKey: sessionPk, calls });
    const o1 = direct.lastOutcome()!;
    expect(r1.status).toBe("CONFIRMED");
    expect(o1.bought?.amountIn).toBe(1_000_000n);
    expect(await usdtOf(w.wallet)).toBe(usdt0 - 1_000_000n); // no fee taken from the wallet
    const tx1 = await pub.getTransaction({ hash: r1.transactionHash! });
    expect(getAddress(tx1.from)).toBe(direct.submitter);
    expect(tx1.input.toLowerCase().endsWith(ATTRIBUTION_SUFFIX.slice(2).toLowerCase())).toBe(true);
    const verified = await verifyTx({ client: coreClient, hash: r1.transactionHash! });
    const tail = fromDataSuffix(tx1.input);
    expect(verified?.codes).toEqual([ATTRIBUTION_CODE]);
    expect(tail?.codes).toEqual([ATTRIBUTION_CODE]);
    const after1 = await readSessionState(coreClient, { wallet: w.wallet, publicKey: sessionPublicKey, blockNumber: await pub.getBlockNumber() });
    record.buy = {
      tx: r1.transactionHash, from: tx1.from, to: tx1.to, gasUsed: o1.gasUsed, intentExecuted: o1.intentExecuted, bought: o1.bought,
      minOut: q.minOut, inputBytes: (tx1.input.length - 2) / 2, last35Bytes: `0x${tx1.input.slice(-70)}`,
      verifyTx: verified, fromDataSuffix: tail, walletUsdtDelta: -1_000_000n, capSpentAfter: after1.usdtCap?.spent,
      nonce: `0x${(await pub.readContract({ address: w.wallet, abi: ithacaAccountNonceAbi, functionName: "getNonce", args: [directLaneSeqKey(after1.keyHash)] })).toString(16)}`,
    };

    // ---- 2. Over the cap: 1.05 USD₮/week cap, 1 USD₮ already spent this week ----
    await advance(31 * 60); // the purchase wrote a fresh oracle observation: 30 quiet minutes for the TWAP again
    const q2 = await quoteBuy(coreClient, 1_000_000n);
    expect(q2.twapTick).not.toBeNull();
    const calls2 = buildBuyCalls(1_000_000n, q2.minOut, goldBuyer);
    const usdt1 = await usdtOf(w.wallet);
    const sentBefore = await pub.getTransactionCount({ address: direct.submitter });
    const refused = await direct.execute({ session, privateKey: sessionPk, calls: calls2 }).then(() => null, (e) => e as Error & { kind?: string; bought?: string });
    expect(refused?.name).toBe("DirectSubmitError");
    expect(refused?.kind).toBe("cap_exceeded");
    expect(refused?.bought).toBe("no");
    expect(await pub.getTransactionCount({ address: direct.submitter })).toBe(sentBefore); // nothing was sent
    // Forced onto the chain: the account itself must refuse (and the nonce is consumed).
    const r2 = await forced.execute({ session, privateKey: sessionPk, calls: calls2 });
    const o2 = forced.lastOutcome()!;
    expect(r2.status).toBe("FAILED");
    expect(o2.bought).toBeUndefined();
    expect(o2.intentExecuted?.errName).toBe("ExceededSpendLimit");
    expect(o2.intentExecuted?.incremented).toBe(true);
    expect(await usdtOf(w.wallet)).toBe(usdt1);
    record.overCap = { preflight: { error: refused?.message, kind: refused?.kind, sent: false }, forced: { tx: r2.transactionHash, status: r2.status, gasUsed: o2.gasUsed, intentExecuted: o2.intentExecuted, walletUsdtDelta: 0n } };

    // ---- 3. Revoke the key (admin intent: account revoke + KeyStore revoke), then try again ----
    const rv = await adminIntent(w.wallet, w.adminPk, [
      { to: w.wallet, value: 0n, data: encodeFunctionData({ abi: accountAbi, functionName: "revoke", args: [sessionKeyIds(sessionPublicKey).keyHash] }) },
      { to: ALTANA_KEYSTORE, value: 0n, data: encodeFunctionData({ abi: keyStoreAbi, functionName: "revokeKey", args: [w.wallet, w.keyIds.session] }) },
    ], funderPk);
    await advance(60);
    const calls3 = buildBuyCalls(1_000_000n, q2.minOut, goldBuyer);
    const usdt2 = await usdtOf(w.wallet);
    const sent2 = await pub.getTransactionCount({ address: direct.submitter });
    const refused3 = await direct.execute({ session, privateKey: sessionPk, calls: calls3 }).then(() => null, (e) => e as Error & { kind?: string; bought?: string });
    expect(refused3?.name).toBe("DirectSubmitError");
    expect(refused3?.kind).toBe("session_ended");
    expect(await pub.getTransactionCount({ address: direct.submitter })).toBe(sent2);
    const r3 = await forced.execute({ session, privateKey: sessionPk, calls: calls3 });
    const o3 = forced.lastOutcome()!;
    expect(r3.status).toBe("FAILED");
    expect(o3.bought).toBeUndefined();
    expect(o3.intentExecuted?.errName).toBe("VerificationError");
    expect(o3.intentExecuted?.incremented).toBe(false);
    expect(await usdtOf(w.wallet)).toBe(usdt2);
    const keyStoreValid = await pub.readContract({ address: ALTANA_KEYSTORE, abi: keyStoreAbi, functionName: "isValidKey", args: [w.wallet, w.keyIds.session] });
    expect(keyStoreValid).toBe(false);
    record.afterRevoke = { revokeTx: rv.transactionHash, keyStoreValid, preflight: { error: refused3?.message, kind: refused3?.kind, sent: false }, forced: { tx: r3.transactionHash, status: r3.status, gasUsed: o3.gasUsed, intentExecuted: o3.intentExecuted, walletUsdtDelta: 0n } };
    record.agentCeloSpentWei = agentCelo0 - (await pub.getBalance({ address: direct.submitter }));
  }, 300_000);

  it("runs through the runner: buys once, then already_bought (idempotent), tag at the end", async () => {
    const t0 = await nowTs();
    const storage = new MemoryStorage();
    const encryptionKey = randomBytes(32);
    const ownerPk = generatePrivateKey();
    const { plan, sessionPublicKey, grant } = await createPlan(
      { storage, encryptionKey, goldBuyer, now: Number(t0) },
      { walletAddress: privateKeyToAccount(ownerPk).address, amountPerBuy: 1_000_000n, period: "week", expiresAt: Number(t0) + 30 * 86_400, dayOfWeek: 0, hourUtc: 0 },
    );
    // The grant as a real one lands: grant.onchainCalls, Orchestrator entry included. The runner's own checks run unchanged.
    const w = await setUpWallet(ownerPk, sessionPublicKey, grant);
    await storage.activatePlan(plan.id, {
      walletAddress: w.wallet, publicKey: sessionPublicKey,
      permissions: { calls: grant.permissions.calls, spend: grant.permissions.spend.map((s) => ({ limit: s.limit.toString(), period: s.period, token: s.token! })) },
      expiry: grant.expiry,
    });
    // The previous test's last swap is more than 30 minutes old by now (it advanced 31 + 1 minutes since).
    await mine(5);
    const direct = createDirectExecutor({ rpcUrl: rpc, submitterKey: agentKey, goldBuyer });
    const runner = createRunner({
      storage, chain: createChainReader({ goldBuyer, goldBuyerDeployBlock: (record.goldBuyer as { block: bigint }).block, rpcUrl: rpc }),
      executor: direct, encryptionKey, goldBuyer, recheckDelayMs: 0, sleep: async () => {},
    });
    const first = (await runner.tick()).plans[0]!;
    record.runnerFirstRaw = first;
    expect(first).toMatchObject({ decision: "bought", slot: "weekly", amountIn: 1_000_000n });
    const tx = await pub.getTransaction({ hash: first.txHash! });
    expect((await verifyTx({ client: coreClient, hash: first.txHash! }))?.codes).toEqual([ATTRIBUTION_CODE]);
    await mine(5);
    const second = (await runner.tick()).plans[0]!;
    expect(second).toMatchObject({ decision: "already_bought", txHash: first.txHash });
    record.runner = { wallet: w.wallet, first, second, from: tx.from, gasUsed: direct.lastOutcome()?.gasUsed, attempts: storage.attempts.map((a) => ({ status: a.status, txHash: a.txHash, callsId: a.callsId })) };

    // Control: the same grant plus any-function on GoldBuyer. The runner refuses before signing anything.
    const cStorage = new MemoryStorage();
    const cOwner = generatePrivateKey();
    const c = await createPlan(
      { storage: cStorage, encryptionKey, goldBuyer, now: Number(await nowTs()) },
      { walletAddress: privateKeyToAccount(cOwner).address, amountPerBuy: 1_000_000n, period: "week", expiresAt: Number(t0) + 30 * 86_400, dayOfWeek: 0, hourUtc: 0 },
    );
    const cw = await setUpWallet(cOwner, c.sessionPublicKey, c.grant, [{ target: goldBuyer, selector: ANY_SELECTOR }]);
    await cStorage.activatePlan(c.plan.id, {
      walletAddress: cw.wallet, publicKey: c.sessionPublicKey,
      permissions: { calls: c.grant.permissions.calls, spend: c.grant.permissions.spend.map((s) => ({ limit: s.limit.toString(), period: s.period, token: s.token! })) },
      expiry: c.grant.expiry,
    });
    await mine(5); // past the readers' confirmation lag
    const cRunner = createRunner({
      storage: cStorage, chain: createChainReader({ goldBuyer, goldBuyerDeployBlock: (record.goldBuyer as { block: bigint }).block, rpcUrl: rpc }),
      executor: direct, encryptionKey, goldBuyer, recheckDelayMs: 0, sleep: async () => {},
    });
    const sentBefore = await pub.getTransactionCount({ address: direct.submitter });
    const control = (await cRunner.tick()).plans[0]!;
    expect(control).toMatchObject({ decision: "skipped", kind: "limits_mismatch" });
    expect(control.reason).toMatch(/any function of/);
    expect(await pub.getTransactionCount({ address: direct.submitter })).toBe(sentBefore);
    record.runnerControlExtraWildcard = control;
  }, 300_000);
});
