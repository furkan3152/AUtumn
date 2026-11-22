/**
 * Shared helpers for scripts/proof.mjs and scripts/e2e-mainnet.mjs.
 *
 * No new dependencies: viem and the Altana SDK are loaded from agent/'s
 * node_modules, and @autumn/core from core/dist (build it first:
 * `cd core && npm ci && npm run build`).
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The ESM file `sub` of package `pkg`, as installed for the package at `fromPackageJson` (node_modules lookup upwards). */
function esmEntryOf(fromPackageJson, pkg, sub) {
  for (const base of createRequire(fromPackageJson).resolve.paths(pkg) ?? []) {
    const file = join(base, pkg, sub);
    if (existsSync(file)) return pathToFileURL(file).href;
  }
  throw new Error(`${pkg} is not installed for ${dirname(fromPackageJson)}. Run \`npm ci\` there first.`);
}

async function load() {
  const agentPkg = join(REPO_ROOT, "agent", "package.json");
  const coreDist = join(REPO_ROOT, "core", "dist", "index.js");
  if (!existsSync(coreDist)) throw new Error("core/dist is missing. Build it: cd core && npm ci && npm run build");
  const [viem, chains, accounts, sdk, core] = await Promise.all([
    import(esmEntryOf(agentPkg, "viem", "_esm/index.js")),
    import(esmEntryOf(agentPkg, "viem", "_esm/chains/index.js")),
    import(esmEntryOf(agentPkg, "viem", "_esm/accounts/index.js")),
    import(esmEntryOf(agentPkg, "@altananetwork/sdk", "dist/index.js")),
    import(pathToFileURL(coreDist).href),
  ]);
  return { viem, celo: chains.celo, accounts, sdk, core };
}

export const deps = await load();

/** The live deployment (README, "Deployed on Celo mainnet"). */
export const GOLD_BUYER = "0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0";
export const GOLD_BUYER_DEPLOY_BLOCK = 83395551n;
export const DEFAULT_BASE_URL = "https://autumn-gold.onrender.com";

export const celoscanTx = (h) => `https://celoscan.io/tx/${h}`;
export const celoscanAddress = (a) => `https://celoscan.io/address/${a}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSON with bigints as decimal strings. */
export const toJson = (v, space = 2) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), space);

/** Errors forno answers now and then that go away when asked again. */
export function isTransient(err) {
  if (err?.walk?.((x) => x?.name === "ContractFunctionRevertedError" || x?.name === "ContractFunctionZeroDataError")) return false;
  const t = String(err?.shortMessage ?? "") + " " + String(err?.details ?? "") + " " + String(err?.message ?? err);
  return /block is out of range|header not found|unknown block|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|rate limit|429|502|503|504|Internal error|missing trie node/i.test(t);
}

/**
 * Runs `fn` until it succeeds, retrying errors that look transient, with
 * exponential backoff. Every wait is bounded: `tries` attempts at most.
 */
export async function retry(fn, { tries = 6, baseMs = 800, label = "request", always = false } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!always && !isTransient(e)) throw e;
      if (i < tries - 1) await sleep(Math.min(baseMs * 2 ** i, 10_000));
    }
  }
  const msg = last?.shortMessage ?? last?.message ?? String(last);
  throw Object.assign(new Error(`${label} failed after ${tries} attempts: ${msg}`), { cause: last });
}

/** Formats base units with `decimals`, trimming trailing zeros. */
export function fmtUnits(v, decimals) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = a.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

/**
 * Bought events from GoldBuyer, in windows of at most `range` blocks (forno
 * refuses more than 5000), each window retried on forno's transient errors
 * and split in half if the node says the range is too large.
 */
export async function scanLogs(client, { address, event, args, fromBlock, toBlock, range = 5000n, onProgress }) {
  const out = [];
  let from = fromBlock;
  let step = range;
  while (from <= toBlock) {
    const to = from + step - 1n > toBlock ? toBlock : from + step - 1n;
    try {
      const logs = await retry(() => client.getLogs({ address, event, ...(args ? { args } : {}), fromBlock: from, toBlock: to, strict: true }), {
        label: `getLogs ${from}-${to}`,
      });
      out.push(...logs);
      onProgress?.(to);
      from = to + 1n;
      step = range;
    } catch (e) {
      const t = String(e?.message ?? e);
      if (/range|limit|too many|exceed/i.test(t) && step > 100n) {
        step = step / 2n;
        continue;
      }
      throw e;
    }
  }
  return out;
}

const CALL_TUPLES = [{ type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }];

/**
 * What a purchase transaction's calldata says: how it reached GoldBuyer
 * (direct call, or an Altana Orchestrator intent), our ERC-8021 tag at the end
 * of the outer calldata (what Celo's verifyTx reads) and in the intent's inner
 * calls, the relay fee the intent pays, and the key that signed the intent.
 */
export function analyseCalldata(tx, goldBuyer) {
  const { viem, core } = deps;
  const { getAddress, decodeFunctionData, decodeAbiParameters, size, slice, toFunctionSelector } = viem;
  const suffix = core.ATTRIBUTION_SUFFIX.toLowerCase().slice(2);
  const input = tx.input.toLowerCase();
  const ours = (d) => !!d && d.codes.includes(core.ATTRIBUTION_CODE);
  const r = {
    route: "other",
    outerTagAtEnd: input.endsWith(suffix),
    tagOccurrences: input.split(suffix).length - 1,
    innerCalls: null,
    innerCallsTagged: null,
    intentEoa: null,
    signingKeyHash: null,
    relayFee: null,
  };
  const sel = input.slice(0, 10);
  const to = tx.to ? getAddress(tx.to) : null;
  if (to === getAddress(goldBuyer) && sel === toFunctionSelector("buy(uint256,uint256)")) {
    r.route = "direct call to GoldBuyer";
    return r;
  }
  if (to === getAddress(core.ALTANA_ORCHESTRATOR) && sel === toFunctionSelector("execute(bytes)")) {
    r.route = "Altana Orchestrator intent";
    try {
      const { args } = decodeFunctionData({ abi: core.orchestratorAbi, data: tx.input });
      const [intent] = decodeAbiParameters([core.INTENT_ABI_PARAMETER], args[0]);
      r.intentEoa = getAddress(intent.eoa);
      r.relayFee = { token: getAddress(intent.paymentToken), amount: intent.paymentAmount, maxAmount: intent.paymentMaxAmount, recipient: getAddress(intent.paymentRecipient) };
      // IthacaAccount signature = innerSignature ‖ keyHash (32 bytes) ‖ prehash flag (1 byte).
      if (size(intent.signature) >= 33) r.signingKeyHash = slice(intent.signature, size(intent.signature) - 33, size(intent.signature) - 1);
      const [calls] = decodeAbiParameters(CALL_TUPLES, intent.executionData);
      r.innerCalls = calls.map((c) => ({ to: getAddress(c.to), selector: c.data.slice(0, 10), value: c.value, tagged: ours(core.fromDataSuffix(c.data)) }));
      r.innerCallsTagged = r.innerCalls.filter((c) => c.tagged).length;
    } catch (e) {
      r.decodeError = e.shortMessage ?? e.message;
    }
  }
  return r;
}
