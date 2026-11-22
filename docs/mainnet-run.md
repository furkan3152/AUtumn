# Funded mainnet run: runbook and checklist

This is the runbook for `scripts/e2e-mainnet.mjs` and the manual passkey
checklist. Write the answers of a manual run into a new file
`docs/mainnet-run-<date>.md`. Never paste a private key, the encryption key
or a database URL into it.

## Status after the runs of 22 Nov 2026

The automated run passed every step on Celo mainnet
([mainnet-results.md](mainnet-results.md), full record in
[runs/e2e-report-0xa177651fc7f9bff0804ad123c4fdb8aa6625683c.json](runs/e2e-report-0xa177651fc7f9bff0804ad123c4fdb8aa6625683c.json)).
Its wallet's admin is a private key, so it does not cover the passkey. Item
by item:

| # | Item | Status |
|---|---|---|
| 1 | Creating a passkey wallet in a browser on our domain, and restoring it | **Not proven.** A wallet whose only admin key is a WebAuthn passkey made an agent purchase ([mainnet-results.md, "Passkey wallet"](mainnet-results.md#passkey-wallet)), granted and revoked with it, but the browser ceremony itself is not recorded, and restore (section 9) was not run |
| 2 | `grantSession` with a session key known only by its public key (`sessionSignerFromPublicKey`) | **Proven with a private-key admin** (grant `0xfef8bc0d…263b`). From a passkey: grant `0xd1f9795a…be75` and revoke `0x67fc22a9…1dce` of the passkey wallet ([mainnet-results.md, "Passkey wallet"](mainnet-results.md#passkey-wallet)) |
| 3 | The KeyStore fee charged in CELO, and the relay's quote against 2 × fee × 1.1 | **Proven.** The quote's value, 20.3387 CELO, equals 2 × 9.2449 × 1.1; 18.4898 CELO was kept after the refund |
| 4 | The account storing exactly our cap, period, allowlist (with the Orchestrator entry) and expiry | **Proven.** `sessionLimitsMismatch` none |
| 5 | `registerAgentIdentity` (ERC-8004) | **Proven for the private-key wallet** (agent id 10096). Not proven for a passkey wallet |
| 6 | A purchase through `GoldBuyer.buy` sent by the relay with our session key | **Proven** (`0xe6f4f902…c785`) |
| 7 | The relay fee drawn from the session's USD₮ cap, and its size | **Proven.** 0.00974 USD₮; session spend 1.00974 of 1.05 USD₮ |
| 8 | The relay's refusal over the cap and after a revoke, and the SDK codes | **Proven.** `spend_limit_exceeded`; after the revoke `unknown` ("key hash … is unknown"), which Autumn classifies as `session_ended`. A call outside the allowlist gave `call_not_permitted` |
| 9 | `revokeSession` with a bare public key, and `isValidKey` turning false | **Proven** with a private-key admin (`0xd447908b…72f5`) |
| 10 | The "OLD" price-check refusal as the relay reports it | **Not proven.** The price check was available throughout; the real error text is still unknown |
| 11 | A deployment's scheduler, database and route handlers | **Partly proven.** The Cloudflare Cron Trigger is not in use. The live Render deployment's route handlers (`/api/health`, plans, `/api/cron/tick`, `/api/admin/probe`) and its database worked in the run. Its in-process hourly scheduler (`AUTUMN_SCHEDULER=internal`) was not part of the run: the harness called the tick itself |
| 12 | The relay's fee quote (`quoteExecute`) before a session purchase | **Proven indirectly.** The runner sends only after the quote is within the 0.05 USD₮ allowance, and it sent; the quoted value is not in the report |
| 13 | "Send out" of USD₮, XAUt0 and CELO, and the KeyStore registration on a wallet's first passkey transaction | **Proven with a private-key admin** (three transfers). With a passkey, and the first-transaction registration, not proven |

The app's own screens (what sections 1 to 9 below ask you to record in the
app) were not part of the automated run.

## Automated run with a private-key wallet: `scripts/e2e-mainnet.mjs`

The harness runs steps 2 to 8 of this checklist against the live server's
public API, with an EOA private key as the wallet's admin instead of a
passkey (the SDK's private-key signer: the Altana wallet address is the
EOA's own address, upgraded with EIP-7702 on its first admin transaction).
It grants exactly what the browser grants (`planToSessionGrant` from core,
`agentIdentity: false`, fee in USD₮, then `registerAgentIdentity` with the
browser's record), so it proves everything above except the passkey
ceremony (items 1, 2 and the passkey half of 13) and restore (section 9).

It sends real transactions. Build core first (`cd core && npm ci && npm run
build`; agent needs `npm ci` for the SDK), then:

```bash
# what it will do, and the read-only preflight (no keys needed)
node scripts/e2e-mainnet.mjs --dry-run

# the run; every step not yet passed, in order
E2E_ADMIN_KEY=0x…  E2E_CRON_SECRET=…  E2E_RETURN_TO=0x…  node scripts/e2e-mainnet.mjs
# optional: E2E_BASE_URL (default https://autumn-gold.onrender.com), E2E_AMOUNT=1|5|10 (default 1),
# E2E_PERIOD=day|week (default day), E2E_RPC_URL, E2E_TICK_WAIT_MINS (retry a skipped tick)

# one step
node scripts/e2e-mainnet.mjs --step probes
```

| Step | What it sends | What it checks |
|---|---|---|
| `preflight` | nothing | server health (configured, live), GoldBuyer code, pool price check, KeyStore fee, balances; stops before the grant if CELO or USD₮ is short and prints exactly how much to add |
| `wallet` | nothing onchain | `createWallet` with the relay if the EOA is not upgraded yet; the relay lists the admin key |
| `plan` | grant (admin key) | server's proposed limits = core's grant; `sessionMatchesGrant`; onchain `sessionLimitsMismatch` is none; `KeyRegistered` events; CELO and USD₮ the grant cost; server activates |
| `tick` | cron tick (server buys) | one `Bought` for the wallet; USD₮ moved by amount + relay fee, XAUt0 by `out`; fee in USD₮ equals the intent's `paymentAmount` and is ≤ 0.05; session `spent` = amount + fee; our tag in every inner call; what `verifyTx` returns |
| `tick-again` | cron tick | `already_bought`, no new purchase |
| `probes` | `over-cap`, `outside-allowlist` through `/api/admin/probe` | `refused`, no transaction or purchase, balances unchanged (server's and the harness's own reads); the SDK/relay code and text |
| `identity` | `registerAgentIdentity` (admin key) if the wallet has none | registry `balanceOf`, `ownerOf`, `tokenURI` record, agent id, 8004scan URL |
| `revoke` | revoke (admin key), stop, `after-revoke` probe, cron tick | KeyStore `isValidKey` false, `getKey` reverts, `getKeys()` no longer lists it; server plan stopped; probe refused; the tick does not act on the plan |
| `send-out` | XAUt0, CELO, then USD₮ to `E2E_RETURN_TO` (admin key, fee in USD₮) | each transfer's receipt, the wallet's and the destination's balances at that block |

Funds: about **20.4 CELO** for a new wallet (two KeyStore registrations,
`2 × fee × 1.1`; the 10% is refunded, so about 18.5 CELO is spent at
the 22 Nov 2026 fee of 9.24 CELO per key) and **3.3 USD₮** for a 1 USD₮ daily plan
(1 USD₮ of gold, which comes back in `send-out` as XAUt0, about 0.06 USD₮ of
relay fees, and 2.05 USD₮ that the over-cap probe needs to see in the wallet
so that only the cap can refuse it; it is not spent). The preflight reads
the live figures. Use 4 USD₮ for margin.

Everything is written to `docs/runs/e2e-state-<wallet>.json` (progress) and
`docs/runs/e2e-report-<wallet>.json` (every fact, transaction and Celoscan
link per step). Neither holds a key or a secret; the harness never prints
`E2E_ADMIN_KEY` or `E2E_CRON_SECRET` and redacts them from any error text.
A step that passed is never run again. A step that sends records its
transaction before it waits, so a rerun after a crash continues from the
chain (an active key is not granted twice, a revoked key is not revoked
again, a sent transfer is verified, not repeated). Every wait is bounded
(receipts 120 s, session changes 90 s, a tick 300 s, the identity 60 s).
The first tick refuses to start in the last 15 minutes of a period, so the
second tick sees the same period. The cron tick runs every active plan on
the server, as the hourly schedule does; plans not due do nothing.

### The admin probe route

`POST /api/admin/probe` with `Authorization: Bearer $CRON_SECRET` and
`{ "planId": "<uuid>", "kind": "over-cap" | "outside-allowlist" | "after-revoke" | "status" }`.
The secret is checked exactly as for `/api/cron/tick` (constant time, at
least 16 characters, 401 otherwise) before the body is read; any other body
shape is a 400 before the database is touched. It answers with the session
and balances before and after, the calls it built, the SDK/relay error
(`failure.kind`, `failure.code`, `sdkError.message`), any transaction and its
receipt, and any purchase by the wallet during the probe.

Why it cannot buy beyond the plan or move funds anywhere but through
`GoldBuyer.buy` into the owner's wallet (`agent/src/probe.ts`):

1. The request names only a plan and a kind. Targets, calldata and amounts
   are built on the server: a purchase is exactly `USD₮.approve(GoldBuyer)`
   + `GoldBuyer.buy` with the configured GoldBuyer (which sends XAUt0 only to
   its caller); the allowlist probe is `USD₮.transfer(<the wallet itself>, 0)`.
2. A probe is sent only when a fresh chain read makes the refusal certain:
   `over-cap` needs an active session with exactly the plan's limits and
   uses the whole period cap plus one purchase (2.05 USD₮ on a 1.05 cap), so
   neither another spend nor a reset at midnight can make it fit;
   `outside-allowlist` needs the onchain allowlist to be exactly the plan's
   (no `transfer`); `after-revoke` needs the key to be inactive and still
   uses an amount above the cap. `status` sends nothing. A dry-run server
   (`AUTUMN_EXECUTION` not `live`) sends nothing.
3. The chain is the last guard: the session key can only call
   `USD₮.approve` and `GoldBuyer.buy` (and the Orchestrator entry, which
   cannot move funds) within its USD₮ cap. A refused intent pays no relay
   fee; an intent that landed and reverted would pay one, within the cap.

Each probe adds a run-log entry starting with `probe:`, so the owner's app
shows it. `agent/dist/cli.js try-buy` (sections 5 and 7) uses the same code,
and now also refuses an amount that is not above the whole period cap.

### Who bought through GoldBuyer: `scripts/proof.mjs`

Read-only. `node scripts/proof.mjs` lists every `Bought` event since the
deploy block (5,000-block windows, retried on forno's "block is out of
range"), the route (direct call or Orchestrator intent), whether the signing
key had Autumn's allowlist and is active or revoked now, our tag in the
inner calls and `verifyTx`'s answer, flags team wallets, and writes
`docs/proof/purchases.json` and `purchases.csv`.

## Before you start

- [ ] GoldBuyer is deployed on Celo mainnet. Note its address and block.
- [ ] The pool's 30-minute price check is available (the harness preflight
      reports it). Since 22 Nov 2026 the pool stores up to 1,800
      observations; `buy` reverts "OLD" only while its oldest stored
      observation is younger than 30 minutes. The app then shows "Price
      check not available right now, the agent will retry".
- [ ] The app is deployed (or running locally) with the settings from
      `web/.env.example`, `AUTUMN_EXECUTION=live`, and the migration applied.
- [ ] `NEXT_PUBLIC_AUTUMN_RP_ID` is the domain you open the app on.
- [ ] `curl https://<app>/api/health` answers `{"configured":true,"live":true}`.

Funds for one run:

| Asset | Amount | Why |
|---|---|---|
| CELO | about 21 | Two KeyStore registrations on the first grant (wallet key and agent key), each about 9.25 CELO today plus 10% headroom that is refunded. Read the exact figure on the Add money screen. |
| USD₮ | 12 | Two $1 buys, a $1 daily plan's cap, relay fees for the grant, revoke and identity, and room for the over-cap probe. |

Use the smallest plan: **$1, daily, no dip rule**. Its cap is 1.05 USD₮ per
UTC day.

## 1. Wallet

- [ ] Open the app. Tap "Create wallet with passkey". Approve the passkey.
- [ ] Record: wallet address, browser and OS, any error text.
- [ ] Reload the page. The wallet should still be there.

## 2. Funding

- [ ] Send the CELO and the USD₮ above to the wallet, on Celo.
- [ ] Record: both transaction hashes, and the balances the Add money screen
      shows. Compare them with Celoscan.
- [ ] Record the registration fee the screen shows.

## 3. Grant

- [ ] Choose Daily, $1, dip rule off. Record the limits shown: cap, reset
      time, end date.
- [ ] Confirm. Approve the passkey. A second passkey prompt follows for the
      agent identity (ERC-8004).
- [ ] Record:
  - the grant transaction hash and its block;
  - the CELO the wallet spent (balance before and after) against the fee
    shown, and the USD₮ relay fee;
  - `KeyRegistered` events in the grant transaction (one root, one session);
  - the identity registration outcome and its transaction, if any.
- [ ] Check onchain, read-only:
  - `spendInfos(keyHash)` on the wallet: one entry, USD₮, period 2 (day),
    limit 1050000;
  - `canExecutePackedInfos(keyHash)`: exactly USD₮ `approve`, GoldBuyer `buy`
    and the Orchestrator any-function entry (`0x32323232`);
  - `getKey(keyHash)`: `expiry` equals the end date shown, `keyType` is 2
    (secp256k1) and `isSuperAdmin` is false;
  - KeyStore `isValidKey(wallet, keyId)` is true.
- [ ] The Home screen shows "Agent is running", the daily limit and the
      next purchase time.
- [ ] If anything failed, record the full error text and where it appeared.

## 4. Purchase

- [ ] Trigger a run: `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/tick`.
- [ ] Record the full JSON answer.
- [ ] If the decision is `skipped` with `twap_unavailable`, wait and run it
      again. Record each attempt and the error text.
- [ ] When it says `bought`, record:
  - the transaction hash, block, and the `Bought(buyer, amountIn, out)` event;
  - XAUt0 received, and the price against the pool's mid price;
  - the session's `spent` for the day from `spendInfos` (amount + relay fee);
  - the relay fee in USD₮;
  - whether our attribution tag `celo_c24c5a65e5a3` appears in the calldata,
    and what `verifyTx` from `@celo/attribution-tags` returns (expected: null,
    see docs/altana-spike/RESULTS.md section 7).
- [ ] Run the tick again. It must answer `already_bought` and send nothing.
- [ ] The app shows the purchase, the gold balance and the day's limit used.

## 5. Over-cap refusal

The runner never sends a purchase it knows is over the cap, so this uses the
probe command. It refuses to send anything that could buy.

```bash
cd agent
node --env-file=../web/.env.local dist/cli.js try-buy <planId> 2000000 --i-understand-this-sends
```

Against a deployment whose database you cannot reach, use the admin route instead:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H "content-type: application/json" \
  -d '{"planId":"<planId>","kind":"over-cap"}' https://<app>/api/admin/probe
```

- [ ] Expected: `"outcome": "refused"` with failure kind `cap_exceeded`.
- [ ] Record the full output, including the SDK error code and text.
- [ ] Check that no `Bought` event appeared and that USD₮ did not move.
- [ ] The app shows "Purchase refused: Limit reached".

## 6. Revoke

- [ ] In the app, tap "Stop the agent", then "Yes, stop now". Approve the
      passkey.
- [ ] The screen must say "Stopping…" until the chain shows the revoke, and
      only then "Agent stopped".
- [ ] Record: the revoke transaction hash, the USD₮ fee, and the time between
      the tap and "Agent stopped".
- [ ] Check onchain, read-only, on both registries:
  - KeyStore `isValidKey(wallet, keyId)` is false;
  - the wallet's own account: `getKey(keyHash)` reverts with
    `KeyDoesNotExist()`, and `getKeys()` no longer lists `keyHash`. The
    account is what the relay checks a session against, so a key still on
    the account is still live, whatever the KeyStore says.

## 7. Refusal after revoke

```bash
node --env-file=../web/.env.local dist/cli.js try-buy <planId> 1000000 --i-understand-this-sends
```

Or `{"planId":"<planId>","kind":"after-revoke"}` to `/api/admin/probe` as in section 5.

- [ ] Expected: `"outcome": "refused"`; record the failure kind and text.
- [ ] Run the tick. The plan must not appear among active plans.
- [ ] The app still shows "Agent stopped".

## 8. Send out

- [ ] In the app, tap "Send out" in the Wallet panel. Send 1 USD₮ to a Celo
      address you control. Record the fee shown, the passkey prompt, the
      transaction hash and the time until "Sent" appears.
- [ ] Check on Celoscan that the USD₮ arrived and that the balances the app
      shows after "Sent" match the chain.
- [ ] Repeat with "Max" for XAUt0, and record what is left for the fee.

## 9. Restore

- [ ] On a second browser or device with the same synced passkey, open the
      app and tap "I already have an Autumn passkey".
- [ ] Record whether the wallet, the purchase and the stopped plan appear.

## What to record, in one table

| Item | Value |
|---|---|
| Date, app URL, app commit | |
| Wallet address | |
| Funding transactions | |
| Registration fee shown / charged (CELO) | |
| Grant transaction | |
| Identity registration transaction or outcome | |
| First purchase transaction, amount in, XAUt0 out | |
| Relay fee per purchase (USD₮) | |
| Over-cap probe: outcome, error code, text | |
| Revoke transaction | |
| Post-revoke probe: outcome, error code, text | |
| Attribution: tag present, `verifyTx` result | |
| Every error seen, with where it appeared | |
