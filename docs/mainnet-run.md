# Funded mainnet run: checklist

This is the first run with real money. It proves what the code and tests
cannot: the passkey ceremony, the grant, a real purchase, the refusals, and
the revoke. Write every answer into a new file `docs/mainnet-run-<date>.md`.
Never paste a private key, the encryption key or a database URL into it.

## What is not verified yet

Until this run is done, none of these has happened on any chain:

1. Creating a passkey wallet in a browser on our domain, and restoring it.
2. `grantSession` from a passkey with a session key that only has a public
   key on the browser side (`sessionSignerFromPublicKey`).
3. The KeyStore registration fee actually charged in CELO, and whether the
   relay's quote matches the 2 × fee × 1.1 the app shows for a first grant.
4. The account storing exactly our cap, period (day or week), allowlist and
   expiry, so `sessionLimitsMismatch` passes. The allowlist must be
   USD₮.approve, GoldBuyer.buy and the Orchestrator any-selector entry that
   the SDK adds (docs/direct-submit.md, "The Orchestrator entry"); this shape
   is taken from four live Celo session keys and the fork, not from our own
   grant.
5. `registerAgentIdentity` for a passkey wallet (ERC-8004).
6. A purchase through `GoldBuyer.buy` sent by the relay with our session key.
7. The relay fee drawn from the session's USD₮ cap, and its size.
8. The relay's refusal of a purchase over the cap, and after a revoke, and
   the error codes the SDK reports for them.
9. `revokeSession` with a bare public key, and `isValidKey` turning false.
10. The "OLD" price-check refusal as the relay reports it (we match the word
    `OLD` in the error text; the real text is unknown).
11. Vercel cron, Neon and the route handlers in a deployment.
12. The relay's fee quote (`quoteExecute`) for a session purchase, which the
    agent compares with the plan's 0.05 USD₮ per-buy allowance before sending.
13. "Send out": an admin (passkey) transfer of USD₮, XAUt0 and CELO, and the
    one-time KeyStore registration it carries if it is the wallet's first
    passkey transaction.

## Before you start

- [ ] GoldBuyer is deployed on Celo mainnet. Note its address and block.
- [ ] Ideally the pool's oracle has more history. Today its observation
      cardinality is 1, so `buy` reverts "OLD" for 30 minutes after any swap
      in the pool. The app shows "Price check not available right now, the
      agent will retry". Without the fix, pick a quiet moment for step 4.
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
  - `canExecutePackedInfos(keyHash)`: exactly USD₮ `approve` and GoldBuyer `buy`;
  - `getKey(keyHash)`: `expiry` equals the end date shown, `keyType` is 2
    (secp256k1) and `isSuperAdmin` is false;
  - KeyStore `isValidKey(wallet, keyId)` is true.
- [ ] The Home screen shows "Agent is running", the daily limit and the
      next purchase time.
- [ ] If anything failed, record the full error text and where it appeared.

## 4. Purchase

- [ ] Trigger a run: `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/tick`.
- [ ] Record the full JSON answer.
- [ ] If the decision is `skipped` with `twap_unavailable`, wait 30 minutes
      without swaps in the pool and run it again. Record each attempt.
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
