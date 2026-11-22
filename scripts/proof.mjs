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
 * - who sent the outer transaction (`txFrom`): Autumn's agent wallet
 *   (AGENT_WALLET), a known Altana relay sender, the buyer itself, or another
 *   address;
 * - team wallets, from the list below. The agent wallet sends purchases and
 *   is never counted as a buyer.
 *
 * Totals (unique non-team buyers, purchases, repeat buyers, volume, senders,
 * purchases credited by verifyTx) are
 * printed and written with every row to docs/proof/purchases.{json,csv},
 * and summarised for people in docs/usage.md (with --out: <dir>/usage.md).
 * Sends nothing and needs no key. Env: PROOF_RPC_URL (default forno),
 * AUTUMN_GOLD_BUYER_ADDRESS / AUTUMN_GOLD_BUYER_DEPLOY_BLOCK to point at
 * another deployment.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_WALLET,
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
  "0xA177651FC7F9BfF0804ad123c4fdb8aa6625683C": "team end-to-end test wallet",
  "0x88DeB13766F676C70cC27770d1fEd5c3Eb2414db": "team end-to-end test wallet 2",
};

/**
 * EOAs that sent Autumn's relay-submitted transactions to the Orchestrator on
 * Celo mainnet (purchases, grants, identity registrations, revokes and
 * "Send out"), read from those transactions on 22 Nov 2026.
 */
const ALTANA_RELAY_SENDERS = [
  "0xDE3136c489B3371de8180D4c94c0238150e2c5b4",
  "0x53187EAb26Dad0e82598D4f7aC9C349665FB2Faa",
  "0x0B479179781640C1C62FE845dCAab1689CB4985C",
];

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
const agentWallet = getAddress(AGENT_WALLET);
// The agent wallet is in this map only so that a purchase it ever made for itself would not count as a user's.
const team = new Map([...Object.entries(TEAM_WALLETS).map(([a, label]) => [getAddress(a), label]), [agentWallet, "Autumn agent wallet"]]);
const relaySenders = new Set(ALTANA_RELAY_SENDERS.map((a) => getAddress(a)));

/** Who sent a purchase's outer transaction, in words; null when it is none of the known senders. */
function senderLabel(from, buyer) {
  if (from === agentWallet) return "Autumn agent wallet";
  if (relaySenders.has(from)) return "Altana relay";
  if (from === buyer) return "the buyer";
  return null;
}
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
    const txFrom = getAddress(tx.from);
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
      txFrom,
      sentBy: senderLabel(txFrom, buyer) ?? txFrom,
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
    purchasesSentByAgentWallet: rows.filter((r) => r.txFrom === agentWallet).length,
    purchasesSentByAltanaRelay: rows.filter((r) => relaySenders.has(r.txFrom)).length,
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
    agentWallet,
    altanaRelaySenders: [...relaySenders],
    totals,
    purchases: rows,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "purchases.json"), toJson(report) + "\n");
  const cols = ["block", "time", "txHash", "buyer", "team", "usdtIn", "xaut0Out", "route", "txFrom", "sentBy", "buyerKind", "autumnSession", "sessionNow", "tagInnerCalls", "tagOuter", "verifyTx", "creditedByVerifyTx"];
  const csvRow = (r) =>
    [
      r.block, r.time, r.txHash, r.buyer, r.team ?? "", r.usdtIn_display, r.xaut0Out_display, r.route, r.txFrom, r.sentBy, r.buyerKind,
      r.signingKey?.autumnAllowlist ?? "", r.signingKey?.statusNow ?? "",
      r.attribution.innerCallsTagged ?? "", r.attribution.outerCalldataEndsWithTag,
      r.attribution.verifyTx === null ? "null" : (r.attribution.verifyTx.codes ?? [r.attribution.verifyTx.error]).join("|"),
      r.attribution.verifyTxCreditsUs,
    ].map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",");
  writeFileSync(join(outDir, "purchases.csv"), [cols.join(","), ...rows.map(csvRow)].join("\n") + "\n");
  // docs/usage.md by default; with --out, next to the other outputs.
  writeFileSync(flag("--out") ? join(outDir, "usage.md") : join(REPO_ROOT, "docs", "usage.md"), usageMarkdown(report));

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
      sentBy: r.sentBy === r.txFrom ? short(r.txFrom) : r.sentBy,
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

/** Thousands separators, deterministic (no locale). */
const groupDigits = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const shortHash = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const utc = (iso) => iso.replace("T", " ").replace(/\.\d+Z$/, "").replace(/Z$/, "");
const addrLink = (a) => `[${shortAddr(a)}](https://celoscan.io/address/${a})`;

/**
 * docs/usage.md: the same facts as purchases.json, for people. Deterministic
 * for a given head block (no wall-clock time; the read time is the head
 * block's time).
 */
function usageMarkdown(report) {
  const { totals, purchases: rows } = report;
  const team = rows.filter((r) => r.team);
  const teamVolume = fmtUnits(team.reduce((a, r) => a + r.usdtIn, 0n), 6);
  const withAutumnKey = rows.filter((r) => r.signingKey?.autumnAllowlist === true).length;
  const lines = [
    "# Onchain usage",
    "",
    `Contract ${addrLink(report.goldBuyer)} (GoldBuyer) on Celo mainnet, blocks ${groupDigits(report.fromBlock)} to ${groupDigits(report.toBlock)}, read at ${utc(report.toBlockTime)} UTC (time of block ${groupDigits(report.toBlock)}). This file is generated by \`node scripts/proof.mjs\` from Celo mainnet and is not edited by hand. The same data, with more fields, is in [proof/purchases.json](proof/purchases.json) and [proof/purchases.csv](proof/purchases.csv).`,
    "",
    "## Totals",
    "",
    "| | Value |",
    "|---|---|",
    `| Independent buyers (unique buyers that are not team wallets) | ${totals.uniqueNonTeamBuyers} |`,
    `| Purchases by independent buyers | ${totals.nonTeamPurchases} |`,
    `| Independent buyers with two or more purchases | ${totals.repeatNonTeamBuyers} |`,
    `| USD₮ spent by independent buyers | ${totals.nonTeamVolumeUsdtIn} |`,
    `| Team test purchases (not counted as users) | ${totals.teamPurchases} (${teamVolume} USD₮) |`,
    `| Purchases whose signing key carried Autumn's allowlist | ${withAutumnKey} of ${totals.purchases} (independent: ${totals.nonTeamPurchasesWithAutumnSession}) |`,
    `| Purchases credited to our attribution tag by Celo's \`verifyTx\` | ${totals.purchasesCreditedByVerifyTx} of ${totals.purchases} |`,
    `| Purchases sent by Autumn's agent wallet | ${totals.purchasesSentByAgentWallet} of ${totals.purchases} |`,
    `| Purchases sent by Altana's relay | ${totals.purchasesSentByAltanaRelay} of ${totals.purchases} |`,
    "",
  ];
  if (totals.uniqueNonTeamBuyers === 0) {
    lines.push(
      rows.length === 0
        ? "There are no purchases through GoldBuyer in this range."
        : "There are no independent buyers yet: every purchase in this range was made by a team wallet.",
      "",
    );
  }
  lines.push("## Team wallets", "", "Purchases from these addresses are team tests.", "");
  for (const [a, label] of Object.entries(report.teamWallets)) lines.push(`- ${addrLink(a)}: ${label}`);
  lines.push(
    "",
    `Autumn's agent wallet, ${addrLink(report.agentWallet)}, sends purchases (the outer transaction) and pays their gas. It is a sender, not a buyer, and is not counted as a user.`,
    "",
    "## Purchases",
    "",
  );
  if (rows.length === 0) {
    lines.push("None.");
  } else {
    lines.push(
      "| Time (UTC) | Buyer | USD₮ in | XAUt0 out | Route | Sent by | Signing session key now | Credited by `verifyTx` | Team | Transaction |",
      "|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const r of rows) {
      const key = r.signingKey
        ? `${r.signingKey.autumnAllowlist === true ? "Autumn allowlist" : r.signingKey.autumnAllowlist === false ? "other allowlist" : "allowlist unknown"}, ${r.signingKey.statusNow}`
        : "none (no session key)";
      const sentBy = r.sentBy === r.txFrom ? addrLink(r.txFrom) : `${r.sentBy} (${addrLink(r.txFrom)})`;
      const credited = r.attribution.verifyTxCreditsUs ? "yes" : r.attribution.verifyTx === null ? "no (null)" : "no";
      lines.push(
        `| ${utc(r.time)} | ${addrLink(r.buyer)} | ${r.usdtIn_display} | ${r.xaut0Out_display} | ${r.route} | ${sentBy} | ${key} | ${credited} | ${r.team ?? "no"} | [${shortHash(r.txHash)}](${r.celoscan}) |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

main().catch((e) => {
  console.error(`proof failed: ${e.message}`);
  process.exit(1);
});
