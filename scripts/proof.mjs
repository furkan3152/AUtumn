#!/usr/bin/env node
/**
 * Read-only proof of every purchase made through GoldBuyer on Celo mainnet.
 *
 *   node scripts/proof.mjs [--rpc <url>] [--from <block>] [--out <dir>] [--quiet]
 *
 * For each GoldBuyer `Bought` event since the deploy block it prints the
 * block, time, transaction, buyer, USD₮ in and XAUt0 out, and records:
 * - how the purchase reached GoldBuyer: a direct call from the buyer, or an
 *   Altana Orchestrator intent (relayed, or submitted by our direct submitter);
 * - whether our ERC-8021 tag (celo_c24c5a65e5a3) is in the outer calldata
 *   (what Celo's `verifyTx` reads) and in the intent's inner calls, and what
 *   `verifyTx` returns;
 * - whether the buyer is an Altana wallet, which key signed the intent, and
 *   whether that key's allowlist was exactly Autumn's (USD₮.approve,
 *   GoldBuyer.buy, the Orchestrator entry) and is still on the account
 *   (active), expired or gone (revoked);
 * - team wallets, from the list below.
 *
 * Totals (unique non-team buyers, purchases, repeat buyers, volume) are
 * printed and written with every row to docs/proof/purchases.{json,csv}.
 * Sends nothing and needs no key. Env: PROOF_RPC_URL (default forno),
 * AUTUMN_GOLD_BUYER_ADDRESS / AUTUMN_GOLD_BUYER_DEPLOY_BLOCK to point at
 * another deployment.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GOLD_BUYER,
  analyseCalldata,
  GOLD_BUYER_DEPLOY_BLOCK,
  REPO_ROOT,
  celoscanTx,
  deps,
  fmtUnits,
  retry,
  scanLogs,
  toJson,
} from "./lib/common.mjs";

const { viem, core } = deps;
const { getAddress } = viem;

/** Team wallets: purchases from these are tests, not users. */
export const TEAM_WALLETS = {
  "0x53180bbC54Bc9561c08805ca4832be85345fF535": "team deployer/test",
  "0x15855ae2E04Fd00eFA45cB70D2C29E5777925429": "team owner test",
};

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const rpcUrl = flag("--rpc") ?? process.env.PROOF_RPC_URL ?? core.DEFAULT_CELO_RPC_URL;
const goldBuyer = getAddress(process.env.AUTUMN_GOLD_BUYER_ADDRESS ?? GOLD_BUYER);
const deployBlock = BigInt(flag("--from") ?? process.env.AUTUMN_GOLD_BUYER_DEPLOY_BLOCK ?? GOLD_BUYER_DEPLOY_BLOCK);
const outDir = flag("--out") ?? join(REPO_ROOT, "docs", "proof");
const quiet = args.includes("--quiet");

const client = core.createCeloPublicClient(rpcUrl);
const team = new Map(Object.entries(TEAM_WALLETS).map(([a, label]) => [getAddress(a), label]));
const TAG = core.ATTRIBUTION_CODE;
const ALTANA_DELEGATION = `0xef0100${core.ALTANA_ACCOUNT_PROXY.slice(2)}`.toLowerCase();

const log = (...a) => {
  if (!quiet) console.error(...a);
};

function ourCode(decoded) {
  return !!decoded && Array.isArray(decoded.codes) && decoded.codes.includes(TAG);
}

const allowlistKey = (list) =>
  list
    .map((c) => `${c.target.toLowerCase()}:${c.selector.toLowerCase()}`)
    .sort()
    .join(",");
const OUR_ALLOWLIST = allowlistKey(core.expectedOnchainAllowlist(goldBuyer));

function isRevert(e) {
  return !!e?.walk?.((x) => x?.name === "ContractFunctionRevertedError" || x?.name === "ContractFunctionZeroDataError");
}

/** The account's record of a key at a block: null when the key is not on the account then. */
async function keyAt(wallet, keyHash, blockNumber) {
  const read = (functionName) =>
    retry(() => client.readContract({ address: wallet, abi: core.altanaAccountAbi, functionName, args: [keyHash], ...(blockNumber ? { blockNumber } : {}) }), {
      label: `${functionName} ${wallet}`,
    });
  let key;
  try {
    key = await read("getKey");
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
  const [packed, spend] = await Promise.all([read("canExecutePackedInfos"), read("spendInfos")]);
  return {
    expiry: Number(key.expiry),
    keyType: Number(key.keyType),
    isSuperAdmin: key.isSuperAdmin,
    allowlist: packed.map(core.unpackCanExecute),
    spend: spend.map((s) => ({ token: getAddress(s.token), period: Number(s.period), limit: s.limit })),
  };
}

const buyerCache = new Map();
async function buyerFacts(wallet, head) {
  if (buyerCache.has(wallet)) return buyerCache.get(wallet);
  const code = ((await retry(() => client.getCode({ address: wallet, blockNumber: head }), { label: `getCode ${wallet}` })) ?? "0x").toLowerCase();
  const kind = code === "0x" ? "EOA" : code === ALTANA_DELEGATION ? "Altana wallet" : code.startsWith("0xef0100") ? "EIP-7702 (other delegate)" : "contract";
  let activeAutumnSessions = null;
  if (kind === "Altana wallet") {
    activeAutumnSessions = 0;
    const [keys, hashes] = await retry(() => client.readContract({ address: wallet, abi: core.altanaAccountAbi, functionName: "getKeys", blockNumber: head }), {
      label: `getKeys ${wallet}`,
    });
    const now = Number((await retry(() => client.getBlock({ blockNumber: head }))).timestamp);
    for (let i = 0; i < hashes.length; i++) {
      if (keys[i].isSuperAdmin) continue;
      const k = await keyAt(wallet, hashes[i], head);
      if (k && allowlistKey(k.allowlist) === OUR_ALLOWLIST && (k.expiry === 0 || k.expiry > now)) activeAutumnSessions++;
    }
  }
  const f = { kind, activeAutumnSessions };
  buyerCache.set(wallet, f);
  return f;
}

/** The signing key of a relayed purchase: was it an Autumn session key then, and what is it now? */
async function sessionFacts(wallet, keyHash, purchaseBlock, head, nowTs) {
  if (!keyHash) return null;
  let then = null;
  let thenSource = "purchase block";
  try {
    then = await keyAt(wallet, keyHash, purchaseBlock);
  } catch {
    thenSource = "unreadable at the purchase block";
  }
  const now = await keyAt(wallet, keyHash, head);
  if (!then && now) {
    then = now;
    thenSource = "current state (historical read unavailable)";
  }
  const autumnAllowlist = then ? allowlistKey(then.allowlist) === OUR_ALLOWLIST : null;
  const status = !now ? "revoked (not on the account)" : now.expiry !== 0 && now.expiry <= nowTs ? "expired" : "active";
  return {
    keyHash,
    superAdmin: then?.isSuperAdmin ?? null,
    autumnAllowlist,
    allowlistReadFrom: then ? thenSource : "unknown",
    spend: then?.spend ?? null,
    statusNow: status,
  };
}

async function main() {
  const head = await retry(() => core.pinnedBlock(client), { label: "head" });
  const headBlock = await retry(() => client.getBlock({ blockNumber: head }));
  const nowTs = Number(headBlock.timestamp);
  log(`GoldBuyer ${goldBuyer}: scanning blocks ${deployBlock}..${head} (${head - deployBlock + 1n} blocks) on ${rpcUrl}`);
  const event = core.goldBuyerAbi.find((x) => x.type === "event" && x.name === "Bought");
  let lastPct = -1;
  const logs = await scanLogs(client, {
    address: goldBuyer,
    event,
    fromBlock: deployBlock,
    toBlock: head,
    onProgress: (to) => {
      const pct = Number(((to - deployBlock) * 100n) / (head - deployBlock + 1n));
      if (pct >= lastPct + 20) log(`  … ${pct}%`), (lastPct = pct);
    },
  });
  log(`${logs.length} Bought event(s). Reading transactions…`);

  const rows = [];
  for (const l of logs) {
    const [tx, block] = await Promise.all([
      retry(() => client.getTransaction({ hash: l.transactionHash }), { label: `tx ${l.transactionHash}` }),
      retry(() => client.getBlock({ blockNumber: l.blockNumber }), { label: `block ${l.blockNumber}` }),
    ]);
    const buyer = getAddress(l.args.buyer);
    const cd = analyseCalldata(tx, goldBuyer);
    let verify;
    try {
      verify = await retry(() => core.verifyTx({ client, hash: l.transactionHash }), { label: "verifyTx" });
    } catch (e) {
      verify = { error: e.message };
    }
    const bf = await buyerFacts(buyer, head);
    const sf = cd.intentEoa === buyer ? await sessionFacts(buyer, cd.signingKeyHash, l.blockNumber, head, nowTs) : null;
    rows.push({
      block: l.blockNumber,
      time: new Date(Number(block.timestamp) * 1000).toISOString(),
      txHash: l.transactionHash,
      celoscan: celoscanTx(l.transactionHash),
      buyer,
      team: team.get(buyer) ?? null,
      usdtIn: l.args.amountIn,
      xaut0Out: l.args.out,
      usdtIn_display: fmtUnits(l.args.amountIn, 6),
      xaut0Out_display: fmtUnits(l.args.out, 6),
      txFrom: getAddress(tx.from),
      txTo: tx.to ? getAddress(tx.to) : null,
      route: cd.route,
      buyerKind: bf.kind,
      buyerActiveAutumnSessions: bf.activeAutumnSessions,
      signingKey: sf,
      relayFee: cd.relayFee,
      attribution: {
        tag: TAG,
        outerCalldataEndsWithTag: cd.outerTagAtEnd,
        tagOccurrencesInCalldata: cd.tagOccurrences,
        innerCalls: cd.innerCalls?.length ?? null,
        innerCallsTagged: cd.innerCallsTagged,
        verifyTx: verify === null ? null : verify,
        verifyTxCreditsUs: ourCode(verify),
      },
      ...(cd.decodeError ? { decodeError: cd.decodeError } : {}),
    });
  }

  const nonTeam = rows.filter((r) => !r.team);
  const count = (list) => {
    const m = new Map();
    for (const r of list) m.set(r.buyer, (m.get(r.buyer) ?? 0) + 1);
    return m;
  };
  const sum = (list, k) => list.reduce((a, r) => a + r[k], 0n);
  const byBuyer = count(nonTeam);
  const totals = {
    purchases: rows.length,
    teamPurchases: rows.length - nonTeam.length,
    nonTeamPurchases: nonTeam.length,
    uniqueBuyers: count(rows).size,
    uniqueNonTeamBuyers: byBuyer.size,
    repeatNonTeamBuyers: [...byBuyer.values()].filter((n) => n >= 2).length,
    nonTeamAltanaBuyers: [...byBuyer.keys()].filter((b) => buyerCache.get(b)?.kind === "Altana wallet").length,
    nonTeamPurchasesWithAutumnSession: nonTeam.filter((r) => r.signingKey?.autumnAllowlist === true).length,
    volumeUsdtIn: fmtUnits(sum(rows, "usdtIn"), 6),
    volumeXaut0Out: fmtUnits(sum(rows, "xaut0Out"), 6),
    nonTeamVolumeUsdtIn: fmtUnits(sum(nonTeam, "usdtIn"), 6),
    nonTeamVolumeXaut0Out: fmtUnits(sum(nonTeam, "xaut0Out"), 6),
    purchasesCreditedByVerifyTx: rows.filter((r) => r.attribution.verifyTxCreditsUs).length,
    purchasesWithTagInInnerCalls: rows.filter((r) => (r.attribution.innerCallsTagged ?? 0) > 0).length,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    chainId: 42220,
    rpc: rpcUrl,
    goldBuyer,
    fromBlock: deployBlock,
    toBlock: head,
    toBlockTime: new Date(nowTs * 1000).toISOString(),
    teamWallets: TEAM_WALLETS,
    totals,
    purchases: rows,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "purchases.json"), toJson(report) + "\n");
  const cols = ["block", "time", "txHash", "buyer", "team", "usdtIn", "xaut0Out", "route", "buyerKind", "autumnSession", "sessionNow", "tagInnerCalls", "tagOuter", "verifyTx"];
  const csvRow = (r) =>
    [
      r.block, r.time, r.txHash, r.buyer, r.team ?? "", r.usdtIn_display, r.xaut0Out_display, r.route, r.buyerKind,
      r.signingKey?.autumnAllowlist ?? "", r.signingKey?.statusNow ?? "",
      r.attribution.innerCallsTagged ?? "", r.attribution.outerCalldataEndsWithTag,
      r.attribution.verifyTx === null ? "null" : (r.attribution.verifyTx.codes ?? [r.attribution.verifyTx.error]).join("|"),
    ].map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",");
  writeFileSync(join(outDir, "purchases.csv"), [cols.join(","), ...rows.map(csvRow)].join("\n") + "\n");

  const short = (h) => `${h.slice(0, 10)}…${h.slice(-4)}`;
  console.log(`\nGoldBuyer ${goldBuyer} purchases, blocks ${deployBlock}..${head} (${report.toBlockTime})\n`);
  console.table(
    rows.map((r) => ({
      block: r.block.toString(),
      time: r.time.replace(".000Z", "Z"),
      tx: short(r.txHash),
      buyer: short(r.buyer),
      team: r.team ?? "",
      "USD₮ in": r.usdtIn_display,
      "XAUt0 out": r.xaut0Out_display,
      route: r.route,
      buyerKind: r.buyerKind,
      autumnKey: r.signingKey ? `${r.signingKey.autumnAllowlist ?? "?"} (${r.signingKey.statusNow})` : "",
      tagInner: r.attribution.innerCallsTagged ?? "-",
      verifyTx: r.attribution.verifyTx === null ? "null" : (r.attribution.verifyTx.codes ?? ["error"]).join("|"),
    })),
  );
  console.log("Totals");
  console.table(totals);
  console.log(`\nWritten: ${join(outDir, "purchases.json")} and purchases.csv`);
}

main().catch((e) => {
  console.error(`proof failed: ${e.message}`);
  process.exit(1);
});
