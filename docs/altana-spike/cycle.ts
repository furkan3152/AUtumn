// De-risk spike: grant -> act -> refuse -> revoke -> refuse, on Celo Sepolia only.
//
// Usage:
//   npx tsx cycle.ts preflight   # no transactions: wallet address, balances, fee tokens, grant quote
//   npx tsx cycle.ts run         # full cycle (needs a funded wallet); appends to runs/<timestamp>.json
//
// Secrets live only in ./.env (ADMIN_KEY, SESSION_KEY, RECIPIENT_KEY). Nothing here prints them.
import "dotenv/config";
import fs from "node:fs";
import {
  createClient,
  CELO_SEPOLIA,
  signerFromPrivateKey,
  serializeSession,
  isAltanaError,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  http,
  encodeFunctionData,
  parseAbi,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toDataSuffix, verifyTx, fromDataSuffix } from "@celo/attribution-tags";
import { concat } from "viem";

// ERC-8021 attribution tag, testnet only for now. Appended to every session call's data (the only place
// the SDK lets us put it). ATTRIBUTION=off disables it.
const ATTR_CODE = "celo_c24c5a65e5a3";
const TAG = process.env.ATTRIBUTION === "off" ? undefined : (toDataSuffix(ATTR_CODE) as Hex);
const MARK = "80218021802180218021802180218021";
const tagged = (data: Hex): Hex => (TAG ? concat([data, TAG]) : data);

const CHAIN_ID = 11142220;
if (CELO_SEPOLIA.chainId !== CHAIN_ID) throw new Error("unexpected CELO_SEPOLIA config");

// Stablecoin used for the cap and the relay fee. Default: Celo Sepolia USD₮ (listed by the testnet relay).
const STABLE: Address = (process.env.STABLE as Address) ?? "0xd077A400968890Eacc75cdc901F0356c943e4fDb";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";

const erc20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

function need(name: string): Hex {
  const v = process.env[name];
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`.env is missing ${name}`);
  return v as Hex;
}

const pub = createPublicClient({ chain: CELO_SEPOLIA.chain, transport: http(CELO_SEPOLIA.publicRpcUrl) });
const client = createClient({
  chains: [CELO_SEPOLIA],
  agentIdentity: { name: "Autumn spike (testnet)", description: "Throwaway de-risk wallet for a USD₮->XAUt0 agent" },
});
const admin = signerFromPrivateKey(need("ADMIN_KEY"));
const sessionSigner = signerFromPrivateKey(need("SESSION_KEY"));
const recipient = privateKeyToAccount(need("RECIPIENT_KEY")).address;

const log: any = { startedAt: new Date().toISOString(), chainId: CHAIN_ID, stable: STABLE, steps: [] as any[] };
const runFile = `runs/${log.startedAt.replace(/[:.]/g, "-")}.json`;
function save() {
  fs.mkdirSync("runs", { recursive: true });
  fs.writeFileSync(runFile, JSON.stringify(log, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function describeError(e: any) {
  const out: any = { name: e?.name, message: e?.message };
  if (isAltanaError(e)) Object.assign(out, { code: e.code, relayMessage: e.relayMessage, detail: e.detail });
  if (e?.cause) out.cause = String(e.cause?.message ?? e.cause);
  if (e?.result) out.result = e.result;
  return out;
}

async function balances(addr: Address) {
  const [celo, stable] = await Promise.all([
    pub.getBalance({ address: addr }),
    pub.readContract({ address: STABLE, abi: erc20, functionName: "balanceOf", args: [addr] }),
  ]);
  return { celo, stable };
}

async function step<T>(name: string, expect: "success" | "refused", fn: () => Promise<T>, walletAddr?: Address) {
  const before = walletAddr ? await balances(walletAddr) : undefined;
  const entry: any = { name, expect, at: new Date().toISOString() };
  try {
    const r: any = await fn();
    entry.result = r && typeof r === "object" ? pick(r) : r;
    const failed = r?.status === "FAILED" || r?.status === "failed";
    entry.outcome = failed ? "returned-failed" : "ok";
  } catch (e) {
    entry.outcome = "threw";
    entry.error = describeError(e);
  }
  if (walletAddr && before) {
    // Let the RPC catch up with the relay receipt before reading balances.
    await new Promise((r) => setTimeout(r, 4000));
    const after = await balances(walletAddr);
    entry.balanceDelta = { celoWei: after.celo - before.celo, stableUnits: after.stable - before.stable };
  }
  const h = entry.result?.transactionHash as Hex | undefined;
  if (h && TAG) entry.attribution = await checkAttribution(h);
  entry.matchedExpectation =
    expect === "success" ? entry.outcome === "ok" : entry.outcome === "threw" || entry.outcome === "returned-failed";
  log.steps.push(entry);
  save();
  console.log(`[${entry.matchedExpectation ? "as expected" : "UNEXPECTED"}] ${name}: ${entry.outcome}`,
    entry.error ? `- ${entry.error.code ?? ""} ${entry.error.message}` : entry.result?.transactionHash ?? "");
  return entry;
}

// What Celo's checker sees (verifyTx reads the tail of tx.input, and ERC-4337 handleOps), plus every
// tag embedded anywhere in the outer calldata.
async function checkAttribution(hash: Hex) {
  try {
    const tx = await pub.getTransaction({ hash });
    const hex = tx.input.slice(2);
    const embedded: any[] = [];
    for (let i = hex.indexOf(MARK); i !== -1; i = hex.indexOf(MARK, i + 1)) {
      if (i % 2) continue;
      embedded.push({ byteOffset: i / 2, bytesAfter: (hex.length - i - MARK.length) / 2, decoded: fromDataSuffix(("0x" + hex.slice(0, i + MARK.length)) as Hex) });
    }
    return { outerTo: tx.to, outerFrom: tx.from, selector: tx.input.slice(0, 10), inputBytes: hex.length / 2,
      verifyTx: await verifyTx({ client: pub as any, hash }), tailParse: fromDataSuffix(tx.input), embedded };
  } catch (e) {
    return { error: describeError(e) };
  }
}

function pick(r: any) {
  const keys = ["status", "transactionHash", "callsId", "statusCode", "feeToken", "keyId", "keyHash", "legs", "agentIdentities", "agentIdentity", "expiry", "permissions"];
  const o: any = {};
  for (const k of keys) if (r[k] !== undefined) o[k] = r[k];
  if (o.legs) o.legs = o.legs.map((l: any) => ({ ...l }));
  return o;
}

async function main() {
  const mode = process.argv[2] ?? "preflight";
  const wallet = await client.createWallet({ signer: admin });
  const decimals = await pub.readContract({ address: STABLE, abi: erc20, functionName: "decimals" });
  const symbol = await pub.readContract({ address: STABLE, abi: erc20, functionName: "symbol" });
  const unit = 10n ** BigInt(decimals);
  log.wallet = wallet.address;
  log.adminEoa = privateKeyToAccount(need("ADMIN_KEY")).address;
  log.recipient = recipient;
  log.stableSymbol = symbol;
  log.stableDecimals = decimals;

  // Weekly cap of 2 tokens; the relay fee cap is added by feeToken (SDK default 1 token/day).
  const WEEK_CAP = 2n * unit;
  const permissions = {
    calls: [{ to: STABLE, signature: "transfer(address,uint256)" }],
    spend: [{ token: STABLE, limit: WEEK_CAP, period: "week" as const }],
  };
  const expiry = Math.floor(Date.now() / 1000) + 2 * 24 * 3600;
  const grantOpts = { wallet, signer: admin, sessionSigner, permissions, expiry, feeToken: STABLE, chainId: CHAIN_ID };
  log.grant = { permissions, expiry, feeToken: STABLE };
  log.attributionTag = TAG ? { code: ATTR_CODE, suffix: TAG } : "off";

  const bal = await balances(wallet.address);
  log.preflight = {
    walletBalances: { celo: formatUnits(bal.celo, 18), [symbol]: formatUnits(bal.stable, decimals) },
  };
  try {
    log.preflight.feeCurrencies = await client.feeCurrencies({ chainId: CHAIN_ID } as any);
  } catch (e) {
    log.preflight.feeCurrenciesError = describeError(e);
  }
  try {
    const q = await client.quoteGrantSession(grantOpts as any);
    log.preflight.grantQuote = q;
  } catch (e) {
    log.preflight.grantQuoteError = describeError(e);
  }
  save();
  console.log(JSON.stringify(log.preflight, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  if (mode !== "run") return;

  // 1. Grant.
  let session: any;
  const g = await step("grantSession (weekly cap, transfer-only allowlist, expiry, feeToken)", "success", async () => {
    session = await client.grantSession(grantOpts as any);
    fs.writeFileSync("session.json", JSON.stringify(serializeSession(session))); // contains no secret
    return session;
  }, wallet.address);
  if (!g.matchedExpectation) return;

  const transfer = (amount: bigint) =>
    ({ to: STABLE, data: tagged(encodeFunctionData({ abi: erc20, functionName: "transfer", args: [recipient, amount] })) });

  // 2. Allowed call: transfer 0.5 token (inside the 2-token weekly cap).
  await step("allowed: session transfer 0.5", "success", () =>
    client.execute({ session, calls: [transfer(unit / 2n)] }), wallet.address);

  // 3a. Refused: selector not on the allowlist (approve).
  await step("refused: approve() not allowlisted", "refused", () =>
    client.execute({ session, calls: [{ to: STABLE, data: tagged(encodeFunctionData({ abi: erc20, functionName: "approve", args: [recipient, 1n] })) }] }),
    wallet.address);

  // 3b. Refused: over the weekly cap (3 tokens > 2 cap, 0.5 already used).
  await step("refused: transfer 3 over weekly cap", "refused", () =>
    client.execute({ session, calls: [transfer(3n * unit)] }), wallet.address);

  // 4. Revoke.
  await step("revokeSession", "success", () =>
    client.revokeSession({ wallet, signer: admin, session } as any), wallet.address);

  // 4b. Keystore view after revoke.
  try {
    const ks = parseAbi(["function isValidKey(address user, bytes32 keyId) view returns (bool)"]);
    log.isValidKeyAfterRevoke = await pub.readContract({ address: CELO_SEPOLIA.keyStore, abi: ks, functionName: "isValidKey", args: [wallet.address, session.keyId] });
  } catch (e) {
    log.isValidKeyAfterRevokeError = describeError(e);
  }

  // 5. Refused: the same allowed call after revoke.
  await step("refused after revoke: session transfer 0.1", "refused", () =>
    client.execute({ session, calls: [transfer(unit / 10n)] }), wallet.address);

  log.finishedAt = new Date().toISOString();
  save();
  console.log("run log:", runFile);
}

main().catch((e) => {
  log.fatal = describeError(e);
  save();
  console.error("fatal:", log.fatal.message);
  process.exit(1);
});
