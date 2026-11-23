#!/usr/bin/env node
/**
 * The funded mainnet run (docs/mainnet-run.md), end to end, with a
 * private-key admin wallet instead of a passkey, against the live server's
 * public API. SENDS REAL TRANSACTIONS ON CELO MAINNET unless --dry-run.
 *
 *   node scripts/e2e-mainnet.mjs --dry-run         plan and read-only preflight; sends nothing
 *   node scripts/e2e-mainnet.mjs                   every step not yet passed, in order
 *   node scripts/e2e-mainnet.mjs --step <name>     one step (its earlier steps must have passed)
 *
 * Env (never printed):
 *   E2E_ADMIN_KEY     0x… private key of a funded EOA. It becomes the Altana wallet's admin key (EIP-7702:
 *                     the wallet address is the EOA's address).
 *   E2E_CRON_SECRET   the server's CRON_SECRET (for /api/cron/tick and /api/admin/probe)
 *   E2E_RETURN_TO     where "send-out" returns the remaining USD₮, XAUt0 and CELO
 *   E2E_BASE_URL      default https://autumn-gold.onrender.com
 *   E2E_AMOUNT        USD₮ per purchase, 1 to 100 with at most 2 decimals, e.g. 4.5 (default 1)
 *   E2E_PERIOD        day or week (default day)
 *   E2E_RPC_URL       Celo RPC for reads (default forno)
 *   E2E_TICK_WAIT_MINS  if the first tick is skipped (pool price check unavailable, fee too high),
 *                     keep retrying every 5 minutes for up to this many minutes (default 0: fail at once)
 *
 * Resumable: progress is kept in docs/runs/e2e-state-<wallet>.json and a
 * report in docs/runs/e2e-report-<wallet>.json (no keys, no secrets). A step
 * that passed is never run again, and a step that sent a transaction records
 * it before waiting, so a rerun continues from the chain instead of sending
 * again. Every wait is bounded.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_BASE_URL,
  GOLD_BUYER,
  GOLD_BUYER_DEPLOY_BLOCK,
  REPO_ROOT,
  analyseCalldata,
  celoscanAddress,
  celoscanTx,
  deps,
  fmtUnits,
  retry,
  sleep,
  toJson,
} from "./lib/common.mjs";

const { viem, core, sdk, accounts } = deps;
const { getAddress, parseAbi, parseEventLogs } = viem;

export const STEPS = [
  ["preflight", "balances, registration fee, server health; stops if funds are short (read-only)"],
  ["wallet", "make the admin key an Altana wallet with the relay if it is not upgraded yet (no transaction)"],
  ["plan", "create a plan on the server, grant its session key with the admin key (core's grant), verify onchain, activate"],
  ["tick", "run the cron tick; verify the purchase on Celo: Bought event, balances, relay fee, attribution, verifyTx"],
  ["tick-again", "run the tick again: already_bought, no new transaction"],
  ["probes", "admin probes over-cap and outside-allowlist: refused, balances unchanged"],
  ["identity", "register (or find) the wallet's ERC-8004 identity; read it from the registry"],
  ["revoke", "revoke with the admin key, verify onchain, tell the server, probe after-revoke, tick: plan not acted on"],
  ["send-out", "send the remaining XAUt0, CELO and USD₮ to E2E_RETURN_TO, verifying each transfer"],
];
const STEP_NAMES = STEPS.map(([n]) => n);

// ------------------------------------------------------------------ settings

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 32).join("\n").replace(/^ \*\/?/gm, ""));
  process.exit(0);
}
const DRY = argv.includes("--dry-run");
const stepArg = argv.includes("--step") ? argv[argv.indexOf("--step") + 1] : undefined;
if (stepArg !== undefined && !STEP_NAMES.includes(stepArg)) {
  console.error(`--step must be one of: ${STEP_NAMES.join(", ")}`);
  process.exit(2);
}
const env = process.env;
const ADMIN_KEY = env.E2E_ADMIN_KEY?.trim() || undefined;
const CRON_SECRET = env.E2E_CRON_SECRET?.trim() || undefined;
const BASE_URL = (env.E2E_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
/** The plan amount in USD₮ base units, parsed as a decimal string (never a float times 1e6). */
const AMOUNT_PARSE = core.parsePlanAmountText(env.E2E_AMOUNT ?? "1");
const PERIOD = env.E2E_PERIOD ?? "day";
const RETURN_TO = env.E2E_RETURN_TO?.trim() || undefined;
const RPC_URL = env.E2E_RPC_URL?.trim() || core.DEFAULT_CELO_RPC_URL;
const TICK_WAIT_MINS = Number(env.E2E_TICK_WAIT_MINS ?? "0");

/** Never let a secret reach the terminal or a file. */
const SECRETS = [ADMIN_KEY, ADMIN_KEY?.replace(/^0x/i, ""), CRON_SECRET].filter((s) => s && s.length >= 8);
const redact = (s) => SECRETS.reduce((t, k) => t.split(k).join("[redacted]").split(k.toLowerCase()).join("[redacted]"), String(s));
const say = (...a) => console.log(redact(a.join(" ")));
const warn = (...a) => console.error(redact(a.join(" ")));

const problems = [];
if (!AMOUNT_PARSE.ok) problems.push(`E2E_AMOUNT must be 1 to 100 USD₮ with at most 2 decimals: ${AMOUNT_PARSE.problem}`);
if (!core.isPlanPeriod(PERIOD)) problems.push('E2E_PERIOD must be "day" or "week"');
if (ADMIN_KEY && !/^0x[0-9a-fA-F]{64}$/.test(ADMIN_KEY)) problems.push("E2E_ADMIN_KEY must be 0x followed by 64 hex characters");
if (problems.length) {
  for (const p of problems) warn(p);
  process.exit(2);
}

const USDT = getAddress(core.USDT);
const XAUT0 = getAddress(core.XAUT0);
const NATIVE = sdk.NATIVE_TOKEN;
const CHAIN_ID = 42220;
const goldBuyer = getAddress(GOLD_BUYER);
const AMOUNT = AMOUNT_PARSE.value;
/** The JSON number POST /api/plans takes for AMOUNT (4.5 for 4.50 USD₮); the server converts it back exactly. */
const AMOUNT_USDT = core.planAmountToUsdt(AMOUNT);
/** USD₮ kept for relay fees across the run: grant, identity, revoke, three transfers (observed 0.004–0.018 each). */
const FEE_MARGIN_USDT = 250_000n;
/** CELO kept beyond the KeyStore registration (the SDK already adds 10% headroom, refunded). */
const CELO_MARGIN = 50_000_000_000_000_000n; // 0.05 CELO
/** CELO left behind by send-out. Fees are paid in USD₮; this only covers a relay that picks CELO. */
const CELO_DUST = 10_000_000_000_000_000n; // 0.01 CELO
const IDENTITY = {
  name: "Autumn",
  description: "Buys a little Tether Gold (XAUt0) on a schedule, within limits written onchain.",
  endpoint: BASE_URL,
};

const pub = core.createCeloPublicClient(RPC_URL);
const network = { ...sdk.CELO, publicRpcUrl: RPC_URL };
const admin = ADMIN_KEY ? { signer: sdk.signerFromPrivateKey(ADMIN_KEY), address: accounts.privateKeyToAccount(ADMIN_KEY).address } : null;
const wallet = admin ? { address: getAddress(admin.address) } : null;
let sdkClient = null;
const client = () => (sdkClient ??= sdk.createClient({ chains: [network], agentIdentity: IDENTITY }));

// ------------------------------------------------------------------ state and report

const RUNS = join(REPO_ROOT, "docs", "runs");
const tag = wallet ? wallet.address.toLowerCase() : "no-wallet";
const STATE_FILE = join(RUNS, `e2e-state-${tag}.json`);
const REPORT_FILE = join(RUNS, `e2e-report-${tag}.json`);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { version: 1, wallet: wallet?.address ?? null, steps: {} };
const report = existsSync(REPORT_FILE) ? JSON.parse(readFileSync(REPORT_FILE, "utf8")) : { wallet: wallet?.address ?? null, runs: [] };
const run = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  rpc: RPC_URL,
  amountUsdt: AMOUNT_USDT,
  period: PERIOD,
  goldBuyer,
  dryRun: DRY,
  only: stepArg ?? null,
  results: [],
};

function save() {
  if (DRY || !wallet) return;
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(STATE_FILE, redact(toJson(state)) + "\n");
  writeFileSync(REPORT_FILE, redact(toJson({ ...report, runs: [...report.runs, run] })) + "\n");
}
const stepState = (name) => (state.steps[name] ??= {});
const passed = (name) => state.steps[name]?.status === "passed";

class StepFail extends Error {}
const fail = (msg) => {
  throw new StepFail(msg);
};
const check = (cond, msg) => {
  if (!cond) fail(msg);
};

/** One line per fact, kept in the step's report. */
let current = null;
function note(label, value, extra = {}) {
  const v = typeof value === "bigint" ? value.toString() : value;
  say(`    ${label}: ${typeof v === "object" ? toJson(v, 0) : v}`);
  current?.facts.push({ label, value: v, ...extra });
}
function noteTx(label, hash) {
  say(`    ${label}: ${hash}  ${celoscanTx(hash)}`);
  current?.txs.push({ label, hash, url: celoscanTx(hash) });
}

// ------------------------------------------------------------------ helpers

const fmtUsdt = (v) => `${fmtUnits(v, 6)} USD₮`;
const fmtXaut = (v) => `${fmtUnits(v, 6)} XAUt0`;
const fmtCelo = (v) => `${fmtUnits(v, 18)} CELO`;

async function api(method, path, { body, auth = false, timeoutMs = 60_000 } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) {
    if (!CRON_SECRET) fail("E2E_CRON_SECRET is not set");
    headers.authorization = `Bearer ${CRON_SECRET}`;
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: toJson(body, 0) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    fail(`${method} ${path} did not answer within ${timeoutMs / 1000}s or failed: ${e.message}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { status: res.status, data };
}

async function apiOk(method, path, opts) {
  const r = await api(method, path, opts);
  if (r.status < 200 || r.status >= 300) fail(`${method} ${path} answered ${r.status}: ${r.data?.error ?? toJson(r.data, 0)}`);
  return r.data;
}

const head = () => retry(() => core.pinnedBlock(pub), { label: "block number" });
const blockTime = async (n) => Number((await retry(() => pub.getBlock({ blockNumber: n }), { label: `block ${n}` })).timestamp);
const balances = (blockNumber) => retry(() => core.readBalances(pub, wallet.address, blockNumber), { label: "balances" });
const session = (publicKey) => retry(() => core.readSessionState(pub, { wallet: wallet.address, publicKey }), { label: "session state" });

async function receipt(hash, timeoutMs = 120_000) {
  try {
    return await pub.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 2_000 });
  } catch (e) {
    fail(`no receipt for ${hash} within ${timeoutMs / 1000}s: ${e.shortMessage ?? e.message}`);
  }
}

/** Balances just before and just after a transaction's block (forno may lag a block or two: retried). */
async function balanceDelta(blockNumber) {
  const [b, a] = await Promise.all([
    retry(() => core.readBalances(pub, wallet.address, blockNumber - 1n), { label: "balances before", always: true }),
    retry(() => core.readBalances(pub, wallet.address, blockNumber), { label: "balances after", always: true }),
  ]);
  return { before: b, after: a, usdt: a.usdt - b.usdt, xaut0: a.xaut0 - b.xaut0, celo: a.celo - b.celo };
}

async function waitFor(what, fn, done, timeoutMs, everyMs = 3_000) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (done(last)) return last;
    } catch {
      /* retried until the deadline */
    }
    if (Date.now() > until) return last;
    await sleep(everyMs);
  }
}

const purchasesOf = async (fromBlock) =>
  (await retry(() => core.readPurchases(pub, { goldBuyer, buyer: wallet.address, fromBlock, toBlock: undefined }), { label: "purchases", always: true })).filter(
    (p) => p.buyer === wallet.address,
  );

function grantFor(plan) {
  return core.planToSessionGrant({ amountPerBuy: BigInt(plan.amountPerBuy), period: plan.period, dipBuy: false, expiresAt: plan.expiresAt }, goldBuyer, plan.createdAt);
}

async function tick(timeoutMs = 300_000) {
  const r = await apiOk("POST", "/api/cron/tick", { auth: true, timeoutMs });
  if (r.live !== true) fail("the server answered the tick in dry-run mode (live: false); set AUTUMN_EXECUTION=live on the server");
  return r.report;
}

async function probe(kind) {
  return apiOk("POST", "/api/admin/probe", { auth: true, body: { planId: state.plan.planId, kind }, timeoutMs: 300_000 });
}

const sameBalances = (a, b) => a.usdt === b.usdt && a.xaut0 === b.xaut0 && a.celo === b.celo;

// ------------------------------------------------------------------ steps

async function preflight() {
  const health = await api("GET", "/api/health", { timeoutMs: 90_000 });
  note("server", `${BASE_URL} → ${health.status} ${toJson(health.data, 0)}`);
  const n = await head();
  note("Celo block", n);
  const code = await retry(() => pub.getCode({ address: goldBuyer }));
  check(code && code !== "0x", `no GoldBuyer code at ${goldBuyer}`);
  note("GoldBuyer", `${goldBuyer} (code present)`);
  const pool = await retry(() => core.readPoolState(pub), { label: "pool" });
  note("gold price (pool mid)", `${fmtUnits(pool.midUsdtPerXaut, 6)} USD₮ per XAUt0; 30-min price check ${pool.twapAvailable ? "available" : "NOT available now (GoldBuyer would revert OLD)"}`);
  const rate = await retry(() => core.readCeloUsdtRate(pub), { label: "CELO rate" });
  const usdtPerCelo = core.celoToUsdt(10n ** 18n, rate);
  const reg = await retry(() => core.readRegistration(pub, wallet?.address ?? "0x0000000000000000000000000000000000000001"), { label: "registration" });
  note("KeyStore fee per key", `${fmtCelo(reg.feePerKey)} (≈ ${fmtUsdt(core.celoToUsdt(reg.feePerKey, rate))})`);
  note(
    "first grant sends",
    `${fmtCelo(reg.nextGrantValue)} for ${reg.walletRegistered ? "1 key" : "2 keys (wallet + agent)"}, 10% of it refunded (≈ ${fmtUsdt(core.celoToUsdt(reg.nextGrantValue, rate))})`,
  );
  note("1 CELO", fmtUsdt(usdtPerCelo));

  const cap = core.planToSessionGrant({ amountPerBuy: AMOUNT, period: PERIOD, expiresAt: Math.floor(Date.now() / 1000) + 86_400 }, goldBuyer, Math.floor(Date.now() / 1000)).periodCap;
  const overCap = cap + AMOUNT;
  const needCelo = (passed("plan") ? 0n : reg.nextGrantValue) + CELO_MARGIN;
  const needUsdt = (passed("tick") ? 0n : AMOUNT) + (passed("probes") ? 0n : overCap) + FEE_MARGIN_USDT;
  note("plan", `${fmtUsdt(AMOUNT)} per ${PERIOD}, cap ${fmtUsdt(cap)} per ${PERIOD}; over-cap probe ${fmtUsdt(overCap)} (must be held, is not spent)`);
  note("needs", `${fmtCelo(needCelo)} and ${fmtUsdt(needUsdt)} in the wallet now`);
  note(
    "expected cost",
    `≈ ${fmtCelo((reg.nextGrantValue * 100n) / 110n)} KeyStore registration (not refundable) + ${fmtUsdt(AMOUNT)} of gold (kept, sent back) + ≈ 0.06 USD₮ relay fees + 0.3% pool fee`,
  );

  if (!wallet) {
    say("    (no E2E_ADMIN_KEY: wallet balances not read)");
    return { needCelo, needUsdt };
  }
  const b = await balances();
  const walletCode = (await retry(() => pub.getCode({ address: wallet.address }))) ?? "0x";
  note("wallet", `${wallet.address}  ${celoscanAddress(wallet.address)}`);
  note("wallet code", walletCode === "0x" ? "none (plain EOA, not upgraded yet)" : walletCode);
  note("balances", `${fmtUsdt(b.usdt)}, ${fmtXaut(b.xaut0)}, ${fmtCelo(b.celo)}`);
  if (walletCode !== "0x" && walletCode.toLowerCase() !== `0xef0100${core.ALTANA_ACCOUNT_PROXY.slice(2)}`.toLowerCase()) {
    fail(`the admin EOA is delegated to something other than Altana's account (${walletCode}); use another key`);
  }
  const view = await api("GET", `/api/wallets/${wallet.address}`);
  if (view.status === 200) {
    const active = view.data.plans.filter((p) => p.status === "active" && p.id !== state.plan?.planId);
    note("server plans for this wallet", `${view.data.plans.length} (${active.length} other active)`);
    if (active.length && !passed("plan")) fail(`the wallet already has an active plan on the server (${active.map((p) => p.id).join(", ")}); revoke it first`);
  }
  if (!DRY) {
    // The server is needed up to the revoke; send-out needs only the relay and the chain.
    if (!passed("revoke")) {
      check(health.status === 200 && health.data?.configured === true && health.data?.live === true, "the server is not configured and live (/api/health must say configured and live)");
    }
    check(CRON_SECRET, "E2E_CRON_SECRET is not set");
    check(RETURN_TO, "E2E_RETURN_TO is not set: the run must know where to send the funds back");
    const dest = core.checkDestination(RETURN_TO, { wallet: wallet.address, contracts: [goldBuyer] });
    check(dest.ok, `E2E_RETURN_TO: ${dest.problem}`);
  }
  const shortCelo = needCelo > b.celo ? needCelo - b.celo : 0n;
  const shortUsdt = needUsdt > b.usdt ? needUsdt - b.usdt : 0n;
  if (shortCelo || shortUsdt) {
    const msg = [
      shortCelo ? `${fmtCelo(shortCelo)} more (needs ${fmtCelo(needCelo)}, has ${fmtCelo(b.celo)})` : null,
      shortUsdt ? `${fmtUsdt(shortUsdt)} more (needs ${fmtUsdt(needUsdt)}, has ${fmtUsdt(b.usdt)})` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    // Enforced before the grant commits CELO; later steps check what they need themselves.
    if (DRY || passed("plan")) note("SHORT", `send ${msg} to ${wallet.address} on Celo before running`);
    else fail(`the wallet is short: send ${msg} to ${wallet.address} on Celo, then run again`);
  }
  return { needCelo, needUsdt };
}

async function stepWallet() {
  const code = (await retry(() => pub.getCode({ address: wallet.address }))) ?? "0x";
  const altana = `0xef0100${core.ALTANA_ACCOUNT_PROXY.slice(2)}`.toLowerCase();
  if (code.toLowerCase() === altana) {
    note("wallet", `already an Altana wallet onchain (code ${code})`);
  } else {
    try {
      const w = await client().createWallet({ signer: admin.signer });
      check(getAddress(w.address) === wallet.address, `the SDK made wallet ${w.address}, not the admin EOA ${wallet.address}`);
      note("wallet", `${wallet.address} registered with the Altana relay (counterfactual: the EIP-7702 upgrade and the KeyStore registration land with the first admin transaction, the grant)`);
    } catch (e) {
      if (e instanceof StepFail) throw e;
      note("createWallet", `refused (${e.message.split("\n")[0]}); checking whether the relay already knows the wallet`);
    }
  }
  const res = await fetch(network.relayUrl ?? sdk.RELAY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wallet_getKeys", params: [{ address: wallet.address, chainIds: ["0xa4ec"] }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => null);
  const keys = data?.result?.["0xa4ec"] ?? [];
  note("relay keys for the wallet", keys.map((k) => `${k.type}/${k.role}`).join(", ") || toJson(data?.error ?? data, 0));
  check(keys.some((k) => k.role === "admin"), "the relay does not list an admin key for the wallet");
}

async function stepPlan() {
  const s = stepState("plan");
  // Resume: a plan granted earlier is found from the chain, never granted twice.
  if (state.plan?.sessionPublicKey) {
    const st = await session(state.plan.sessionPublicKey);
    if (st.status === "active") note("resume", `plan ${state.plan.planId}: its key is already granted onchain`);
    else if (state.plan.grantTxHash) {
      const st2 = await waitFor("grant", () => session(state.plan.sessionPublicKey), (x) => x.status === "active", 90_000);
      check(st2?.status === "active", `the recorded grant ${state.plan.grantTxHash} is not active onchain; check it on Celoscan before running again`);
    } else {
      note("resume", `plan ${state.plan.planId} was created but never granted; making a new plan`);
      state.plan = undefined;
    }
  }

  if (!state.plan) {
    const now = await blockTime(await head());
    const expiresAt = now + core.PLAN_DURATION_SECS;
    const created = await apiOk("POST", "/api/plans", { body: { wallet: wallet.address, amountUsdt: AMOUNT_USDT, period: PERIOD, dipBuy: false, expiresAt } });
    state.plan = { planId: created.planId, sessionPublicKey: created.sessionPublicKey, amountPerBuy: AMOUNT.toString(), period: PERIOD, expiresAt, createdAt: now };
    save();
    note("plan created", `${created.planId} (server key ${created.sessionPublicKey.slice(0, 18)}…)`);
    const grant = grantFor(state.plan);
    const expected = core.expectedSerializedSession(grant, wallet.address, created.sessionPublicKey);
    check(core.sessionMatchesGrant(created.expected, expected), "the server proposed limits that differ from core's grant; nothing was signed");
    note("grant (from core)", { calls: grant.permissions.calls, spend: grant.permissions.spend, expiry: grant.expiry, feeToken: USDT });

    const grantArgs = {
      wallet,
      signer: admin.signer,
      sessionSigner: core.sessionSignerFromPublicKey(created.sessionPublicKey),
      permissions: grant.permissions,
      expiry: grant.expiry,
      feeToken: USDT,
      chainId: CHAIN_ID,
      agentIdentity: false,
    };
    try {
      const q = await client().quoteGrantSession(grantArgs);
      for (const line of q.lines) note("grant quote", sdk.formatQuoteLine(line, network));
      s.grantQuote = q.lines.map((l) => ({ kind: l.kind, fee: l.fee, feeToken: l.feeToken, value: l.value }));
    } catch (e) {
      note("grant quote", `could not be read: ${e.message}`);
    }
    const before = await balances();
    s.balancesBeforeGrant = before;
    const result = await client().grantSession(grantArgs);
    check(result.transactionHash, "the grant returned no transaction hash");
    state.plan.grantTxHash = result.transactionHash;
    s.grantStatus = result.status;
    save();
    noteTx("grant transaction", result.transactionHash);
    note("grant legs", result.legs.map((l) => `${l.kind}:${l.status}${l.reason ? ` (${l.reason})` : ""}`).join(", "));
    check(core.sessionMatchesGrant(sdk.serializeSession(result), expected), "the SDK granted different permissions than core's grant");
    const reg = await Promise.race([result.registration, sleep(120_000).then(() => null)]);
    if (reg) note("registry legs", reg.map((l) => `${l.status}${l.transactionHash ? ` ${l.transactionHash}` : ""}`).join(", "));
  }

  const grant = grantFor(state.plan);
  const st = await waitFor("session", () => session(state.plan.sessionPublicKey), (x) => x.status === "active" && x.spend.length > 0, 90_000);
  check(st?.status === "active", "the session is not active onchain 90 s after the grant");
  const mismatch = core.sessionLimitsMismatch(st, grant, goldBuyer);
  if (mismatch) {
    note("MISMATCH", `${mismatch}; revoking the key`);
    await client().revokeSession({ wallet, signer: admin.signer, session: state.plan.sessionPublicKey, feeToken: [USDT, NATIVE], chainId: CHAIN_ID }).catch(() => undefined);
    fail(`onchain limits differ from the plan: ${mismatch}`);
  }
  note("onchain session", {
    keyHash: st.keyHash,
    keyId: st.keyId,
    keyStoreValid: st.keyStoreValid,
    keyType: st.keyType,
    isSuperAdmin: st.isSuperAdmin,
    accountExpiry: st.accountExpiry,
    spend: st.spend.map((x) => ({ token: x.token, period: x.period, limit: x.limit })),
    allowlist: st.allowedCalls,
  });
  note("sessionLimitsMismatch", "none (exactly the plan's cap, period, allowlist and expiry)");

  if (state.plan.grantTxHash && !s.grantFacts) {
    const r = await receipt(state.plan.grantTxHash);
    const facts = await retry(() => core.readTxFacts(pub, state.plan.grantTxHash, wallet.address), { always: true });
    const d = await balanceDelta(r.blockNumber);
    s.grantFacts = { block: r.blockNumber, keysRegistered: facts.keysRegistered, celoSpent: -d.celo, usdtSpent: -d.usdt };
    note("grant block", r.blockNumber);
    note("KeyRegistered events", facts.keysRegistered.map((k) => `${k.isRoot ? "root" : "session"} ${k.keyId}`).join(", ") || "none");
    note("grant cost", `${fmtCelo(-d.celo)} (KeyStore registration, after refund) and ${fmtUsdt(-d.usdt)} relay fee`);
    const tx = await retry(() => pub.getTransaction({ hash: state.plan.grantTxHash }));
    note("grant outer tx", `from ${tx.from} to ${tx.to}`);
    save();
  }

  // The server checks the chain itself before it activates.
  let activated = null;
  for (let i = 0; i < 8 && !activated; i++) {
    const r = await api("POST", `/api/plans/${state.plan.planId}/activate`, {
      body: { session: core.expectedSerializedSession(grant, wallet.address, state.plan.sessionPublicKey), ...(state.plan.grantTxHash ? { grantTxHash: state.plan.grantTxHash } : {}) },
    });
    if (r.status === 200) activated = r.data;
    else if (r.status === 409 && /not visible|not active/.test(r.data?.error ?? "")) await sleep(5_000);
    else fail(`activate answered ${r.status}: ${r.data?.error ?? toJson(r.data, 0)}`);
  }
  check(activated?.status === "active", "the server did not activate the plan within 40 s");
  note("server plan", `${activated.id} ${activated.status}, cap ${activated.periodCap}, due ${activated.period === "day" ? `daily at ${activated.hourUtc}:00 UTC` : `weekday ${activated.dayOfWeek} ${activated.hourUtc}:00 UTC`}`);
  state.plan.createdBlock = activated.createdBlock;
}

/** Everything the chain says about one purchase transaction. */
async function verifyPurchase(txHash, expectAmount) {
  const r = await receipt(txHash);
  check(r.status === "success", `the purchase transaction reverted (${txHash})`);
  const bought = parseEventLogs({ abi: core.goldBuyerAbi, logs: r.logs, eventName: "Bought" }).filter((l) => getAddress(l.args.buyer) === wallet.address);
  check(bought.length === 1, `expected one Bought event for the wallet in ${txHash}, found ${bought.length}`);
  const ev = bought[0].args;
  note("Bought event", `buyer ${ev.buyer}, ${fmtUsdt(ev.amountIn)} in, ${fmtXaut(ev.out)} out (block ${r.blockNumber}, log ${bought[0].logIndex})`);
  check(ev.amountIn === expectAmount, `amountIn ${ev.amountIn} differs from the plan's ${expectAmount}`);
  const tx = await retry(() => pub.getTransaction({ hash: txHash }));
  const cd = analyseCalldata(tx, goldBuyer);
  note("route", `${cd.route}; outer tx from ${tx.from} to ${tx.to}`);
  const d = await balanceDelta(r.blockNumber);
  note("balance change", `${fmtUsdt(d.usdt)}, ${fmtXaut(d.xaut0)}, ${fmtCelo(d.celo)}`);
  check(d.xaut0 === ev.out, `XAUt0 moved by ${d.xaut0}, the event says ${ev.out}`);
  let fee = 0n;
  if (cd.relayFee) {
    const transfers = parseEventLogs({ abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]), logs: r.logs, eventName: "Transfer" }).filter(
      (l) => getAddress(l.address) === cd.relayFee.token && getAddress(l.args.from) === wallet.address && getAddress(l.args.to) === cd.relayFee.recipient,
    );
    fee = transfers.reduce((a, l) => a + l.args.value, 0n);
    note("relay fee", `${cd.relayFee.token === USDT ? fmtUsdt(fee) : `${fee} of ${cd.relayFee.token}`} paid to ${cd.relayFee.recipient} (intent paymentAmount ${cd.relayFee.amount}, max ${cd.relayFee.maxAmount})`);
    check(cd.relayFee.token === USDT, "the relay fee was not paid in USD₮");
    check(fee === cd.relayFee.amount, `the fee transfer (${fee}) differs from the intent's paymentAmount (${cd.relayFee.amount})`);
    check(fee <= 50_000n, `the relay fee ${fmtUsdt(fee)} is above the plan's 0.05 USD₮ allowance`);
  }
  check(-d.usdt === ev.amountIn + fee, `USD₮ moved by ${-d.usdt}, expected amount ${ev.amountIn} + fee ${fee}`);
  note("attribution", {
    tag: core.ATTRIBUTION_CODE,
    innerCallsTagged: `${cd.innerCallsTagged ?? 0} of ${cd.innerCalls?.length ?? 0}`,
    outerCalldataEndsWithTag: cd.outerTagAtEnd,
    occurrencesInCalldata: cd.tagOccurrences,
  });
  check(cd.route !== "Altana Orchestrator intent" || cd.innerCallsTagged === cd.innerCalls?.length, "not every inner call carries the attribution suffix");
  const v = await retry(() => core.verifyTx({ client: pub, hash: txHash }));
  note("verifyTx (@celo/attribution-tags)", v === null ? "null (no ERC-8021 suffix at the end of the outer calldata)" : v);
  return { block: r.blockNumber, amountIn: ev.amountIn, out: ev.out, fee, route: cd.route, verifyTx: v, innerCallsTagged: cd.innerCallsTagged, blockTime: await blockTime(r.blockNumber) };
}

async function stepTick() {
  const s = stepState("tick");
  const plan = state.plan;
  const from = BigInt(plan.createdBlock ?? GOLD_BUYER_DEPLOY_BLOCK);
  const pStart = core.periodStart(await blockTime(await head()), PERIOD);
  let mine = (await purchasesOf(from)).filter((p) => p.timestamp >= pStart);
  let txHash = s.txHash ?? mine[0]?.txHash;
  if (txHash && !s.txHash) note("found", `a purchase for this ${PERIOD} is already onchain (${txHash}); the server's own schedule made it. Verifying it.`);
  const until = Date.now() + TICK_WAIT_MINS * 60_000;
  if (!txHash) {
    const now = await blockTime(await head());
    const left = core.nextPeriodStart(now, PERIOD) - now;
    check(left > 15 * 60, `only ${Math.floor(left / 60)} minutes are left in this ${PERIOD}: tick-again must run in the same ${PERIOD}, so start this step after ${new Date(core.nextPeriodStart(now, PERIOD) * 1000).toISOString()}`);
  }
  while (!txHash) {
    const rep = await tick();
    const mineRep = rep.plans.find((p) => p.planId === plan.planId);
    s.lastReport = mineRep ?? null;
    note("tick", `block ${rep.block}, ${rep.plans.length} active plan(s); ours: ${toJson(mineRep ?? "not listed", 0)}`);
    check(mineRep, "the tick did not list our plan among active plans");
    if (mineRep.decision === "bought") txHash = mineRep.txHash;
    else if (mineRep.decision === "ambiguous") {
      note("ambiguous", "waiting up to 120 s for the purchase to appear onchain");
      const found = await waitFor("purchase", () => purchasesOf(from), (ps) => ps.some((p) => p.timestamp >= pStart), 120_000, 10_000);
      txHash = found?.find((p) => p.timestamp >= pStart)?.txHash;
      check(txHash, `the tick was ambiguous and no purchase appeared: ${mineRep.reason}`);
    } else if (["skipped", "failed", "not_due", "waiting_on_earlier_attempt", "deferred"].includes(mineRep.decision) && Date.now() + 300_000 < until) {
      note("retry", `decision ${mineRep.decision} (${mineRep.kind ?? ""}: ${mineRep.reason ?? ""}); trying again in 5 minutes (until ${new Date(until).toISOString()})`);
      await sleep(300_000);
    } else {
      fail(`the tick did not buy: ${mineRep.decision}${mineRep.kind ? ` (${mineRep.kind})` : ""}: ${mineRep.reason ?? ""}. Run --step tick again later (or set E2E_TICK_WAIT_MINS).`);
    }
  }
  s.txHash = txHash;
  save();
  noteTx("purchase transaction", txHash);
  const v = await verifyPurchase(txHash, AMOUNT);
  s.purchase = v;
  const st = await session(plan.sessionPublicKey);
  note("session spend this period", `${fmtUsdt(st.usdtCap.spent)} of ${fmtUsdt(st.usdtCap.limit)} (amount + relay fee = ${fmtUsdt(v.amountIn + v.fee)})`);
  if (core.periodStart(v.blockTime, PERIOD) === core.periodStart(st.blockTimestamp, PERIOD)) {
    check(st.usdtCap.spent === v.amountIn + v.fee, "the session's spend for the period is not exactly amount + relay fee");
  }
  const view = await apiOk("GET", `/api/wallets/${wallet.address}`);
  const logEntry = view.runLog.find((e) => e.txHash?.toLowerCase() === txHash.toLowerCase());
  note("server run log", logEntry ? `${logEntry.outcome}: ${logEntry.reason}` : "no entry with this transaction yet");
}

async function stepTickAgain() {
  const p = state.steps.tick.purchase;
  const now = await blockTime(await head());
  const left = core.nextPeriodStart(now, PERIOD) - now;
  check(core.periodStart(now, PERIOD) === core.periodStart(p.blockTime, PERIOD), `the ${PERIOD} of the purchase has ended, so a tick now would rightly buy again; this check needs the same ${PERIOD}`);
  check(left > 120, `less than 2 minutes of this ${PERIOD} are left; a tick after the reset would rightly buy again, so this check cannot run for this purchase`);
  const before = await purchasesOf(BigInt(p.block));
  const rep = await tick();
  const mine = rep.plans.find((x) => x.planId === state.plan.planId);
  note("tick", toJson(mine ?? "not listed", 0));
  check(mine?.decision === "already_bought", `expected already_bought, got ${mine?.decision ?? "nothing"}`);
  check(mine.txHash?.toLowerCase() === state.steps.tick.txHash.toLowerCase(), "already_bought points at another transaction");
  await sleep(8_000);
  const after = await purchasesOf(BigInt(p.block));
  check(after.length === before.length, `a new purchase appeared: ${after.at(-1)?.txHash}`);
  note("purchases by the wallet since the first", `${after.length} (unchanged)`);
}

async function stepProbes() {
  const s = stepState("probes");
  const st = await session(state.plan.sessionPublicKey);
  const cap = st.usdtCap?.limit ?? 0n;
  check(cap > 0n, "the session has no USD₮ cap onchain");
  const need = cap + AMOUNT + 50_000n; // the over-cap amount plus fee headroom, so only the cap can refuse it
  const b = await balances();
  check(b.usdt >= need, `the over-cap probe needs ${fmtUsdt(need)} in the wallet so that only the cap can refuse it (has ${fmtUsdt(b.usdt)}); send ${fmtUsdt(need - b.usdt)} more`);
  const expected = { "over-cap": "cap_exceeded", "outside-allowlist": "call_not_permitted" };
  for (const kind of ["over-cap", "outside-allowlist"]) {
    if (s[kind]?.status === "passed") {
      note(kind, "passed earlier");
      continue;
    }
    say(`  · probe ${kind}`);
    const mineBefore = await balances();
    const r = await probe(kind);
    s[kind] = { status: "sent", result: r };
    save();
    await sleep(5_000);
    const mineAfter = await balances();
    note(`${kind} request`, r.request);
    note(`${kind} outcome`, `${r.outcome}; failure ${toJson(r.failure, 0)}`);
    note(`${kind} SDK/relay error`, r.sdkError ?? "none (non-throwing result)");
    if (r.onchain.txHash) noteTx(`${kind} transaction (${r.onchain.receipt})`, r.onchain.txHash);
    else note(`${kind} onchain`, "nothing sent onchain (no transaction)");
    note(`${kind} balances`, `server: unchanged=${r.balancesUnchanged}; harness: before ${fmtUsdt(mineBefore.usdt)}/${fmtXaut(mineBefore.xaut0)}, after ${fmtUsdt(mineAfter.usdt)}/${fmtXaut(mineAfter.xaut0)}`);
    check(r.attempted === true, `${kind}: the server did not attempt the probe`);
    check(r.outcome === "refused", `${kind}: expected refused, got ${r.outcome}`);
    check(r.onchain.purchasesInTx.length === 0 && r.onchain.purchasesDuringProbe.length === 0, `${kind}: a purchase appeared`);
    check(r.balancesUnchanged === true && sameBalances(mineBefore, mineAfter), `${kind}: balances changed`);
    if (r.failure?.kind !== expected[kind]) note(`${kind} NOTE`, `refused as ${r.failure?.kind}, not ${expected[kind]}: record the error text above`);
    s[kind] = { status: "passed", result: r };
    save();
  }
}

async function stepIdentity() {
  const s = stepState("identity");
  let count = await retry(() => core.readAgentIdentityCount(pub, wallet.address));
  note("ERC-8004 identities owned (registry balanceOf)", count);
  const start = BigInt(state.plan?.createdBlock ?? GOLD_BUYER_DEPLOY_BLOCK);
  if (count === 0n) {
    const outcome = await client().registerAgentIdentity({ wallet, signer: admin.signer, identity: IDENTITY, feeToken: [USDT, NATIVE], chainId: CHAIN_ID });
    s.outcome = outcome;
    save();
    note("registerAgentIdentity outcome", outcome);
    if (outcome.transactionHash) noteTx("identity transaction", outcome.transactionHash);
    check(outcome.status === "registered", `registration did not happen: ${outcome.status} ${outcome.reason ?? ""}`);
    s.agentId = outcome.agentId;
    count = await waitFor("identity", () => core.readAgentIdentityCount(pub, wallet.address), (c) => c > 0n, 60_000);
    check(count > 0n, "the registry still shows no identity for the wallet");
  }
  if (!s.agentId) {
    const to = await head();
    const id = await retry(() => core.readAgentIdMinted(pub, wallet.address, start, to), { always: true, label: "ERC-8004 mint scan" });
    check(id !== null, `the wallet owns an identity but no mint to it was found after block ${start}`);
    s.agentId = id.toString();
  }
  const abi = parseAbi(["function ownerOf(uint256) view returns (address)", "function tokenURI(uint256) view returns (string)"]);
  const owner = await retry(() => pub.readContract({ address: core.ERC8004_IDENTITY_REGISTRY, abi, functionName: "ownerOf", args: [BigInt(s.agentId)] }));
  const uri = await retry(() => pub.readContract({ address: core.ERC8004_IDENTITY_REGISTRY, abi, functionName: "tokenURI", args: [BigInt(s.agentId)] }));
  check(getAddress(owner) === wallet.address, `agent ${s.agentId} is owned by ${owner}, not the wallet`);
  let record = null;
  try {
    record = sdk.decodeErc8004AgentUri(uri);
  } catch {
    record = { uri: uri.slice(0, 200) };
  }
  note("agent id", s.agentId);
  note("owner", owner);
  note("record", { name: record.name, description: record.description, services: record.services, registrations: record.registrations });
  note("8004scan", sdk.agentPageUrl(CHAIN_ID, s.agentId) ?? "(no 8004scan page known for Celo)");
}

async function stepRevoke() {
  const s = stepState("revoke");
  const pk = state.plan.sessionPublicKey;
  let st = await session(pk);
  if (st.status === "active") {
    let txHash;
    try {
      const r = await client().revokeSession({ wallet, signer: admin.signer, session: pk, feeToken: [USDT, NATIVE], chainId: CHAIN_ID });
      txHash = r.transactionHash;
      note("revoke legs", (r.legs ?? []).map((l) => `${l.kind}:${l.status}`).join(", "));
    } catch (e) {
      if (e?.name === "SessionRevokeError") txHash = e.result?.transactionHash;
      note("revoke error", e.message);
    }
    if (txHash) {
      s.txHash = txHash;
      save();
      noteTx("revoke transaction", txHash);
    }
    st = await waitFor("revoke", () => session(pk), (x) => x.status !== "active", 90_000);
  } else note("revoke", `the session is already ${st.status} onchain${s.txHash ? ` (revoked by ${s.txHash})` : ""}`);
  check(st && st.status !== "active", "the session is still active onchain 90 s after the revoke");
  const keys = await retry(() => pub.readContract({ address: wallet.address, abi: core.altanaAccountAbi, functionName: "getKeys" }));
  note("KeyStore isValidKey", st.keyStoreValid);
  note("on the account (getKey)", st.onAccount ? "yes" : "no (KeyDoesNotExist)");
  note("getKeys() lists the key", keys[1].map((h) => h.toLowerCase()).includes(st.keyHash.toLowerCase()));
  check(!st.keyStoreValid && !st.onAccount, "the key is still valid in the KeyStore or still on the account");
  if (s.txHash && !s.fee) {
    const r = await receipt(s.txHash);
    const d = await balanceDelta(r.blockNumber);
    s.fee = { usdt: -d.usdt, celo: -d.celo };
    note("revoke cost", `${fmtUsdt(-d.usdt)}, ${fmtCelo(-d.celo)}`);
  }

  if (!s.serverStopped) {
    let view = null;
    for (let i = 0; i < 6 && !view; i++) {
      const r = await api("POST", `/api/plans/${state.plan.planId}/stop`, { body: s.txHash ? { revokeTxHash: s.txHash } : {} });
      if (r.status === 200) view = r.data;
      else if (r.status === 409 && /still active/.test(r.data?.error ?? "")) await sleep(5_000);
      else fail(`stop answered ${r.status}: ${r.data?.error}`);
    }
    check(view?.status === "stopped", "the server did not stop the plan");
    note("server plan", `${view.status}: ${view.stoppedReason}${view.stopTxHash ? `, ${view.stopTxHash}` : ""}`);
    s.serverStopped = true;
    save();
  }

  if (!s.probe) {
    const b0 = await balances();
    const r = await probe("after-revoke");
    s.probe = r;
    save();
    await sleep(5_000);
    const b1 = await balances();
    note("after-revoke request", r.request);
    note("after-revoke outcome", `${r.outcome}; failure ${toJson(r.failure, 0)}`);
    note("after-revoke SDK/relay error", r.sdkError ?? "none");
    if (r.onchain.txHash) noteTx(`after-revoke transaction (${r.onchain.receipt})`, r.onchain.txHash);
    else note("after-revoke onchain", "nothing sent onchain");
    check(r.outcome === "refused", `after-revoke: expected refused, got ${r.outcome}`);
    check(r.balancesUnchanged === true && sameBalances(b0, b1), "after-revoke: balances changed");
  }

  const before = await purchasesOf(BigInt(state.steps.tick.purchase.block));
  const rep = await tick();
  const mine = rep.plans.find((x) => x.planId === state.plan.planId);
  note("tick after revoke", mine ? toJson(mine, 0) : `our plan is not among the ${rep.plans.length} active plan(s)`);
  check(!mine || mine.decision === "stopped", `the tick acted on the revoked plan: ${mine?.decision}`);
  await sleep(5_000);
  const after = await purchasesOf(BigInt(state.steps.tick.purchase.block));
  check(after.length === before.length, "a purchase appeared after the revoke");
}

async function stepSendOut() {
  const s = stepState("send-out");
  check(RETURN_TO, "E2E_RETURN_TO is not set");
  const dest = core.checkDestination(RETURN_TO, { wallet: wallet.address, contracts: [goldBuyer] });
  check(dest.ok, `E2E_RETURN_TO: ${dest.problem}`);
  note("destination", `${dest.address}  ${celoscanAddress(dest.address)}`);
  const destBalance = async (asset, blockNumber) =>
    asset === "CELO"
      ? retry(() => pub.getBalance({ address: dest.address, blockNumber }), { always: true })
      : retry(() => pub.readContract({ address: asset === "USDT" ? USDT : XAUT0, abi: core.erc20Abi, functionName: "balanceOf", args: [dest.address], blockNumber }), { always: true });
  // Fees in USD₮ first (as the app's "Send out" does for tokens), CELO if the relay will not take USD₮.
  const feeTokens = () => [USDT, NATIVE];
  for (const asset of ["XAUT0", "CELO", "USDT"]) {
    const sub = (s[asset] ??= {});
    if (sub.status === "passed") {
      note(asset, `sent earlier (${sub.txHash ?? "nothing to send"})`);
      continue;
    }
    if (sub.txHash) {
      note(asset, `a transfer was sent earlier (${sub.txHash}); verifying it instead of sending again`);
    } else {
      const b = await balances();
      const bal = asset === "USDT" ? b.usdt : asset === "XAUT0" ? b.xaut0 : b.celo;
      if (bal === 0n) {
        note(asset, "balance is 0, nothing to send");
        sub.status = "passed";
        save();
        continue;
      }
      const probeCall = core.buildSendCall(asset, dest.address, 1n);
      const q = await client().quoteExecute({ wallet, signer: admin.signer, calls: [probeCall], feeToken: feeTokens(asset), chainId: CHAIN_ID, agentIdentity: false });
      const extra = q.value > probeCall.value ? q.value - probeCall.value : 0n;
      let amount = core.maxSendable(asset, bal, { fee: q.fee, feeToken: q.feeToken, extraNative: extra });
      if (asset === "CELO") amount = amount > CELO_DUST ? amount - CELO_DUST : 0n;
      note(`${asset} quote`, `fee ${q.fee} in ${q.feeToken === NATIVE ? "CELO" : q.feeToken === USDT ? "USD₮" : q.feeToken}; sending ${asset === "CELO" ? fmtCelo(amount) : asset === "USDT" ? fmtUsdt(amount) : fmtXaut(amount)} of ${asset === "CELO" ? fmtCelo(bal) : asset === "USDT" ? fmtUsdt(bal) : fmtXaut(bal)}`);
      if (amount === 0n) {
        note(asset, "only dust left after the fee; nothing sent");
        sub.status = "passed";
        save();
        continue;
      }
      const r = await client().execute({ wallet, signer: admin.signer, calls: [core.buildSendCall(asset, dest.address, amount)], feeToken: feeTokens(asset), chainId: CHAIN_ID, agentIdentity: false });
      check(r.transactionHash, `${asset}: the relay returned no transaction (status ${r.status})`);
      sub.txHash = r.transactionHash;
      sub.amount = amount;
      save();
      check(r.status === "CONFIRMED", `${asset}: the relay reported ${r.status} (${r.statusCode ?? ""}) for ${r.transactionHash}`);
    }
    noteTx(`${asset} transfer`, sub.txHash);
    const rc = await receipt(sub.txHash);
    check(rc.status === "success", `${asset}: the transfer reverted`);
    const d = await balanceDelta(rc.blockNumber);
    const [db, da] = await Promise.all([destBalance(asset, rc.blockNumber - 1n), destBalance(asset, rc.blockNumber)]);
    const amount = BigInt(sub.amount ?? da - db);
    note(`${asset} onchain`, `destination +${da - db}, wallet ${fmtUsdt(d.usdt)} / ${fmtXaut(d.xaut0)} / ${fmtCelo(d.celo)}`);
    check(da - db === amount, `${asset}: the destination received ${da - db}, expected ${amount}`);
    sub.status = "passed";
    save();
  }
  const b = await balances();
  note("left in the wallet", `${fmtUsdt(b.usdt)}, ${fmtXaut(b.xaut0)}, ${fmtCelo(b.celo)}`);
}

const RUNNERS = {
  preflight,
  wallet: stepWallet,
  plan: stepPlan,
  tick: stepTick,
  "tick-again": stepTickAgain,
  probes: stepProbes,
  identity: stepIdentity,
  revoke: stepRevoke,
  "send-out": stepSendOut,
};

// ------------------------------------------------------------------ main

async function runStep(name) {
  current = { step: name, status: "running", startedAt: new Date().toISOString(), facts: [], txs: [] };
  run.results.push(current);
  say(`\n▶ ${name}: ${STEPS.find(([n]) => n === name)[1]}`);
  const st = stepState(name);
  try {
    await RUNNERS[name]();
    current.status = "passed";
    if (name !== "preflight") {
      st.status = "passed";
      st.passedAt = new Date().toISOString();
    }
    say(`PASS ${name}`);
    return true;
  } catch (e) {
    current.status = "failed";
    current.error = redact(e.message);
    if (name !== "preflight") st.status = "failed";
    st.lastError = redact(e.message);
    say(`FAIL ${name}: ${e instanceof StepFail ? e.message : `${e.name}: ${e.shortMessage ?? e.message}`}`);
    return false;
  } finally {
    current.endedAt = new Date().toISOString();
    save();
  }
}

async function main() {
  say(`Autumn mainnet e2e — ${DRY ? "DRY RUN (sends nothing)" : "LIVE: sends real transactions on Celo mainnet"}`);
  say(`server ${BASE_URL}, RPC ${RPC_URL}, plan ${fmtUsdt(AMOUNT)} per ${PERIOD}, GoldBuyer ${goldBuyer}`);
  say(
    `env: E2E_ADMIN_KEY ${ADMIN_KEY ? "set" : "MISSING"}, E2E_CRON_SECRET ${CRON_SECRET ? "set" : "MISSING"}, E2E_RETURN_TO ${RETURN_TO ?? "MISSING"}`,
  );
  if (wallet) say(`wallet ${wallet.address}; state ${STATE_FILE}`);
  say("\nSteps:");
  for (const [n, d] of STEPS) say(`  ${passed(n) ? "✓" : " "} ${n.padEnd(11)} ${d}`);

  if (DRY) {
    say("\nPreflight (read-only):");
    await runStep("preflight");
    say("\nDry run: nothing was sent.");
    if (!ADMIN_KEY || !CRON_SECRET || !RETURN_TO) {
      say("To run for real set E2E_ADMIN_KEY (a funded EOA private key), E2E_CRON_SECRET (the server's CRON_SECRET) and E2E_RETURN_TO (where the funds go back).");
    }
    return 0;
  }
  if (!ADMIN_KEY || !CRON_SECRET || !RETURN_TO) {
    warn("\nE2E_ADMIN_KEY, E2E_CRON_SECRET and E2E_RETURN_TO are required (see --dry-run for what the run needs).");
    return 2;
  }
  if (state.wallet && getAddress(state.wallet) !== wallet.address) {
    warn(`the state file belongs to ${state.wallet}`);
    return 2;
  }

  const order = stepArg ? [stepArg] : STEP_NAMES.filter((n) => n !== "preflight");
  if (!(await runStep("preflight"))) return 1;
  for (const name of order) {
    if (name === "preflight") continue;
    if (passed(name)) {
      say(`\n✓ ${name}: passed at ${state.steps[name].passedAt}; not run again`);
      continue;
    }
    const missing = STEP_NAMES.slice(1, STEP_NAMES.indexOf(name)).filter((n) => !passed(n));
    if (missing.length) {
      say(`\nFAIL ${name}: needs ${missing.join(", ")} to pass first`);
      return 1;
    }
    if (!(await runStep(name))) {
      say(`\nStopped. Fix the cause and run again: passed steps are skipped (state ${STATE_FILE}).`);
      return 1;
    }
  }
  say("\nSummary");
  for (const n of STEP_NAMES.slice(1)) say(`  ${passed(n) ? "PASS" : "    "} ${n}`);
  say(`Report: ${REPORT_FILE}`);
  return 0;
}

process.on("unhandledRejection", (e) => {
  warn(`unexpected: ${e?.message ?? e}`);
  process.exit(1);
});
main().then(
  (code) => process.exit(code),
  (e) => {
    warn(`e2e failed: ${e?.message ?? e}`);
    process.exit(1);
  },
);
