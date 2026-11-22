/**
 * Converting between CELO, USD₮ and gold ("Convert" in the app) on a local
 * anvil fork of Celo mainnet. No real funds and no mainnet transaction: every
 * write goes to the local fork. Skipped when anvil is not installed.
 *
 * It sets up an Altana wallet the way mainnet has one (EIP-7702 delegation to
 * the real Altana account proxy, a super-admin key standing in for the
 * passkey) holding only CELO, and sends core's two conversion calls as admin
 * intents through the real Orchestrator, as Altana's relay does:
 *   1. the wallet's first transaction: the KeyStore registration of its own key
 *      (what the SDK prepends to a first admin action), then CELO → USD₮;
 *   2. USD₮ → gold, gold → USD₮, CELO → gold and gold → CELO (two pools in one
 *      exactInput through USD₮), USD₮ → CELO;
 *   3. a USD₮ allowance left by an interrupted attempt, overwritten by the next
 *      conversion's exact approve.
 * Each must deliver at least the floor, take exactly the amount, pass core's
 * receipt check, and leave the router's allowance at zero. A last intent with
 * a floor above the quote must change nothing.
 *
 * anvil runs with --celo: CELO's ERC-20 (GoldToken) moves native balance
 * through Celo's transfer precompile, which plain anvil lacks.
 *
 * Env: ANVIL_BIN (default ~/.foundry/bin/anvil or PATH), FORK_URL (default forno), FORK_BLOCK (default a few blocks behind the head).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  padHex,
  parseAbi,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { signerFromPrivateKey } from "@altananetwork/sdk";
import {
  ALTANA_ACCOUNT_PROXY,
  ALTANA_KEYSTORE_CONTROLLER,
  ALTANA_ORCHESTRATOR,
  CELO_TOKEN,
  SWAP_ROUTER_02,
  SWAP_TOKEN,
  buildSessionIntent,
  buildSwapCalls,
  checkSwapLogs,
  createCeloPublicClient,
  decodeSwapCalls,
  directLaneSeqKey,
  executeCalldata,
  intentDigest,
  ithacaAccountNonceAbi,
  orchestratorAbi,
  pinnedBlock,
  quoteSwapRoute,
  wrapKeySignature,
  type Call,
  type SwapAsset,
} from "@autumn/core";

function findAnvil(): string | undefined {
  const candidates = [process.env.ANVIL_BIN, join(homedir(), ".foundry/bin/anvil")].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  const w = spawnSync("sh", ["-c", "command -v anvil"], { encoding: "utf8" });
  return w.status === 0 && w.stdout.trim() ? w.stdout.trim() : undefined;
}
const ANVIL = findAnvil();

const accountAbi = parseAbi([
  "function execute(bytes32 mode, bytes executionData) payable",
  "function authorize((uint40 expiry, uint8 keyType, bool isSuperAdmin, bytes publicKey) key) returns (bytes32)",
]);
const controllerAbi = parseAbi([
  "function initialRegisterKey(bytes32 keyId, address validator, bytes metadata, bytes publicKey, uint40 expiry) payable",
  "function getRegistrationFeeInWei() view returns (uint256)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address, address) view returns (uint256)"]);
const MODE_BATCH = pad("0x01", { dir: "right", size: 32 });
const CELO = 10n ** 18n;

describe.skipIf(!ANVIL)("conversions between CELO, USD₮ and gold from an Altana wallet on a Celo mainnet fork", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let pub: PublicClient;
  let core: ReturnType<typeof createCeloPublicClient>;
  const funderPk = generatePrivateKey(); // submits the admin intents, as the relay would

  const rpcCall = async (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
  const nowTs = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;
  const keyHashOf = (address: Address) =>
    keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [2, keccak256(padHex(address, { size: 32 }))]));

  async function adminIntent(wallet: Address, adminPk: Hex, calls: Call[]) {
    const admin = signerFromPrivateKey(adminPk);
    const keyHash = keyHashOf(admin.address);
    const nonce = await pub.readContract({ address: wallet, abi: ithacaAccountNonceAbi, functionName: "getNonce", args: [directLaneSeqKey(keyHash)] });
    const { intent } = buildSessionIntent({ wallet, calls, nonce, combinedGas: 2_000_000n, expiry: (await nowTs()) + 600n });
    intent.signature = wrapKeySignature(await admin.signDigest(intentDigest({ ...intent, calls })), keyHash);
    const w = createWalletClient({ chain: celo, transport: http(rpc), account: privateKeyToAccount(funderPk) });
    const hash = await w.sendTransaction({ to: ALTANA_ORCHESTRATOR, data: executeCalldata(intent, null), chain: celo });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: orchestratorAbi, eventName: "IntentExecuted", logs: receipt.logs });
    return { receipt, err: ev.at(-1)?.args.err };
  }

  beforeAll(async () => {
    const port = 20_000 + Math.floor(Math.random() * 2000);
    rpc = `http://127.0.0.1:${port}`;
    const args = ["--fork-url", process.env.FORK_URL ?? "https://forno.celo.org", "--celo", "--hardfork", "prague", "--port", String(port), "--silent", "--prune-history", "400", "--timeout", "15000", "--retries", "8"];
    // forno's nodes lag each other by a block or two: fork a few blocks behind the head, not "latest".
    const forkBlock = process.env.FORK_BLOCK ?? String(await pinnedBlock(createCeloPublicClient(process.env.FORK_URL)));
    args.push("--fork-block-number", forkBlock);
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
    core = createCeloPublicClient(rpc);
    await rpcCall("anvil_setBalance", [privateKeyToAccount(funderPk).address, toHex(100n * CELO)]);
  }, 150_000);

  afterAll(() => {
    anvil?.kill("SIGKILL");
  });

  it("converts in every direction with an exact approval, delivers at least the floor and leaves no allowance", async () => {
    // A wallet holding only CELO, delegated to Altana's account, with an admin key.
    const owner = privateKeyToAccount(generatePrivateKey());
    const adminPk = generatePrivateKey();
    const admin = privateKeyToAccount(adminPk);
    const wallet = owner.address;
    await rpcCall("anvil_setBalance", [wallet, toHex(60n * CELO)]);
    expect(await pub.readContract({ address: CELO_TOKEN, abi: erc20, functionName: "balanceOf", args: [wallet] })).toBe(60n * CELO);
    expect(await pub.readContract({ address: SWAP_TOKEN.USDT, abi: erc20, functionName: "balanceOf", args: [wallet] })).toBe(0n);
    const ownerClient = createWalletClient({ chain: celo, transport: http(rpc), account: owner });
    const authorization = await ownerClient.signAuthorization({ contractAddress: ALTANA_ACCOUNT_PROXY, executor: "self" });
    const authorize = encodeFunctionData({ abi: accountAbi, functionName: "authorize", args: [{ expiry: 0, keyType: 2, isSuperAdmin: true, publicKey: padHex(admin.address, { size: 32 }) }] });
    const execData = encodeAbiParameters([{ type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], [[{ to: wallet, value: 0n, data: authorize }]]);
    const h = await ownerClient.sendTransaction({ chain: celo, to: wallet, authorizationList: [authorization], data: encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [MODE_BATCH, execData] }) });
    expect((await pub.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    expect(await pub.getCode({ address: wallet })).toBe(`0xef0100${ALTANA_ACCOUNT_PROXY.slice(2).toLowerCase()}`);

    const balanceOf = async (asset: SwapAsset, blockNumber?: bigint) =>
      asset === "CELO"
        ? pub.getBalance({ address: wallet, ...(blockNumber ? { blockNumber } : {}) })
        : pub.readContract({ address: SWAP_TOKEN[asset], abi: erc20, functionName: "balanceOf", args: [wallet], ...(blockNumber ? { blockNumber } : {}) });
    const allowanceOf = (asset: SwapAsset, blockNumber?: bigint) =>
      pub.readContract({ address: SWAP_TOKEN[asset], abi: erc20, functionName: "allowance", args: [wallet, SWAP_ROUTER_02], ...(blockNumber ? { blockNumber } : {}) });

    const convert = async (from: SwapAsset, to: SwapAsset, amountIn: bigint, prepend: Call[] = []) => {
      const q = await quoteSwapRoute(core, from, to, amountIn, { blockNumber: await pub.getBlockNumber() });
      if (!q.ok) throw new Error(`${from} → ${to}: ${q.reason}`);
      const calls = buildSwapCalls(wallet, from, to, amountIn, q.minOut);
      expect(decodeSwapCalls(calls, wallet)).toEqual({ from, to, amountIn, minOut: q.minOut });
      const in0 = await balanceOf(from);
      const out0 = await balanceOf(to);
      const { receipt, err } = await adminIntent(wallet, adminPk, [...prepend, ...calls]);
      expect(receipt.status).toBe("success");
      expect(err).toBe("0x00000000");
      const check = checkSwapLogs(receipt.logs, { wallet, from, to, amountIn, minOut: q.minOut });
      expect(check.ok).toBe(true);
      const got = (await balanceOf(to)) - out0;
      const spent = in0 - (await balanceOf(from));
      expect(got).toBeGreaterThanOrEqual(q.minOut);
      expect(check.ok && check.amountOut).toBe(got);
      // Exactly amountIn left the wallet (plus, for CELO, the registration value of the prepended call, part refunded).
      const prependValue = from === "CELO" ? prepend.reduce((x, c) => x + c.value, 0n) : 0n;
      expect(spent).toBeGreaterThanOrEqual(amountIn);
      expect(spent).toBeLessThanOrEqual(amountIn + prependValue);
      expect(await allowanceOf(from, receipt.blockNumber)).toBe(0n);
      record.push({ from, to, amountIn, quoted: q.quotedOut, minOut: q.minOut, reference: q.referenceOut, belowReferenceBps: q.belowReferenceBps, got, gasUsed: receipt.gasUsed });
      return got;
    };
    const record: Record<string, unknown>[] = [];

    // 1. First passkey transaction: registers the wallet's own key, then converts CELO → USD₮.
    const fee = await pub.readContract({ address: ALTANA_KEYSTORE_CONTROLLER, abi: controllerAbi, functionName: "getRegistrationFeeInWei" });
    const register: Call = {
      to: ALTANA_KEYSTORE_CONTROLLER,
      value: (fee * 110n) / 100n,
      data: encodeFunctionData({ abi: controllerAbi, functionName: "initialRegisterKey", args: [keccak256(admin.publicKey), "0x0000000000000000000000000000000000000000", "0x", admin.publicKey, 0] }),
    };
    await convert("CELO", "USDT", 25n * CELO, [register]);

    // 2. Every other direction: USD₮ → gold, gold → USD₮, CELO → gold and gold → CELO through USD₮, USD₮ → CELO.
    const gold = await convert("USDT", "XAUT0", 500_000n);
    await convert("XAUT0", "USDT", gold);
    const gold2 = await convert("CELO", "XAUT0", 5n * CELO + CELO / 2n);
    await convert("XAUT0", "CELO", gold2);
    await convert("USDT", "CELO", 200_000n);

    // 3. An allowance left by an interrupted attempt is overwritten by the exact approve and used up.
    const [approveOnly] = buildSwapCalls(wallet, "USDT", "XAUT0", 777_777n, 1n);
    expect((await adminIntent(wallet, adminPk, [approveOnly])).err).toBe("0x00000000");
    expect(await allowanceOf("USDT")).toBe(777_777n);
    await convert("USDT", "XAUT0", 100_000n);

    // 4. A floor above what the pool gives: the intent fails, nothing moves, no allowance is left.
    const q = await quoteSwapRoute(core, "CELO", "XAUT0", CELO, { blockNumber: await pub.getBlockNumber() });
    const celo0 = await balanceOf("CELO");
    const gold0 = await balanceOf("XAUT0");
    const { receipt, err } = await adminIntent(wallet, adminPk, buildSwapCalls(wallet, "CELO", "XAUT0", CELO, q.quotedOut * 2n));
    expect(err).not.toBe("0x00000000");
    expect(checkSwapLogs(receipt.logs, { wallet, from: "CELO", to: "XAUT0", amountIn: CELO, minOut: q.quotedOut * 2n })).toMatchObject({ ok: false });
    expect(await balanceOf("CELO")).toBe(celo0);
    expect(await balanceOf("XAUT0")).toBe(gold0);
    expect(await allowanceOf("CELO")).toBe(0n);
    console.log("fork conversions", JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
  }, 240_000);
});
