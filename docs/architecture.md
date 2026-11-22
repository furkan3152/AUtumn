# Architecture

How a plan becomes a session key, when the agent buys, and what the server
is trusted with.

## Plans and the schedule

- A plan buys 1, 5 or 10 USD₮ of gold per day or per week, for 12 weeks
  (`agent/src/service.ts`, `core/src/period.ts`). The session key expires at
  the end of the plan.
- Periods are counted as the Altana account counts them: a day resets at
  00:00 UTC, a week on Monday 00:00 UTC (`core/src/week.ts`).
- The first purchase is due when the plan is created, so it happens at the
  agent's next run. Later purchases are due on the plan's weekday (weekly) or
  hour (daily), UTC, and never earlier than 3 days (weekly) or 12 hours
  (daily) after the previous one (`MIN_PURCHASE_SPACING_SECS`). The spacing
  is shorter than the period, so it can only move a purchase later within a
  period, never skip one.
- Optional dip rule: one extra purchase in a period when the price is at
  least 2% below the plan's last purchase in that period. The cap is sized
  for two purchases only when this is on.
- The agent runs once per hour: in the live deployment from the in-process
  scheduler (`web/src/server/scheduler.ts`, `AUTUMN_SCHEDULER=internal`), or
  from anything that calls `/api/cron/tick` with `CRON_SECRET`. A purchase is
  claimed in Postgres before it is sent, so two runs at once cannot buy
  twice.

## The cap and the fee allowance

The session key has one USD₮ spend limit per period:
`(amount + fee allowance) × purchases per period`, where the fee allowance is
0.05 USD₮ per purchase (`DEFAULT_FEE_ALLOWANCE_PER_BUY`, `core/src/grant.ts`).
A 1 USD₮ daily plan therefore has a cap of 1.05 USD₮ per day.

Altana's fee is paid in USD₮ from the same cap. Before each purchase the
runner asks the relay for the fee of the exact calls and skips the purchase,
to retry later in the period, when the fee is above the allowance
(`agent/src/runner.ts`). With `AUTUMN_SUBMITTER=relay` that is the relay's
quote (`quoteExecute`); with `direct-prepared`, what the live deployment
runs, it is the `paymentMaxAmount` of the intent the relay prepares, which is
what the wallet then pays. On mainnet the fee was 0.00974 USD₮ and
0.007549 USD₮ on the two relay-sent purchases (the relay lowers it when it
sends) and 0.016328 USD₮ on the first self-submitted one
([mainnet-results.md](mainnet-results.md), [usage.md](usage.md)).

The fee's maximum is part of the signed intent; its amount and recipient are
not signed, so whoever submits the intent chooses them, up to that maximum.
A leaked session key could therefore send up to the cap's remaining room as
"fees". The cap is the bound, not the allowlist.

## Who signs, who sends, who pays

| Transaction | Signed by | Sent by | Gas paid by | Fee |
|---|---|---|---|---|
| Purchase (`direct-prepared`, the live deployment) | the session key, over the intent Altana's relay prepared | Autumn's agent wallet [`0x0b5B…a9Dd`](https://celoscan.io/address/0x0b5B7ec235F2291396c63F4afc96599B4F70a9Dd), with our ERC-8021 tag as the last bytes of the calldata | the agent wallet, in CELO (Autumn sponsors it) | the owner's wallet pays Altana's fee in USD₮, inside the cap, to Altana's fee recipient `0xaF08…C4bC` |
| Purchase (`relay`, the default in code) | the session key | Altana's relay | Altana's relay | the owner's wallet pays the relay's fee in USD₮, inside the cap |
| Grant, revoke, identity registration, "Send out", "Convert" | the owner's passkey | Altana's relay | Altana's relay | the owner's wallet pays the relay's fee, in USD₮ or CELO; the first grant also pays the KeyStore registration in CELO |

The agent wallet is also the address registered with the hackathon entry
and holds ERC-8004 agent id 10098. Submitting needs no authority over the
owner's wallet: the Orchestrator accepts a signed intent from any sender
([direct-submit.md, section 1](direct-submit.md)).

## Price protection

`GoldBuyer.buy` (`contracts/src/GoldBuyer.sol`) reads the pool's 30-minute
average tick, swaps, and reverts if the price after the swap is more than
100 ticks (about 1%) below that average. The caller also passes a minimum
output, which the agent computes from its own quote. If the pool cannot
report a 30-minute average, `buy` reverts ("OLD"); the runner reports
"Price check not available right now" and retries on a later run in the
period. The pool's observation capacity was raised from 1 to 1,800 on
22 Nov 2026 ([README, "Deployed on Celo mainnet"](../README.md#deployed-on-celo-mainnet)).

## Converting between CELO, USD₮ and gold

The owner can swap between the wallet's three assets in any direction
(`core/src/swap.ts`, `web/src/components/screens/Convert.tsx`). It is one
passkey-signed batch sent by Altana's relay: `approve(SwapRouter02, amount)`
on the asset sold, then `exactInputSingle` on Uniswap v3's CELO/USD₮ 0.01%
pool or USD₮/XAUt0 0.3% pool, or `exactInput` through both (via USD₮) for
CELO ↔ gold, paying the wallet itself. The app takes QuoterV2's quote and
refuses when it is more than 3% below the reference value: CELO legs at the
rate in Celo's FeeCurrencyDirectory (the rate used to show CELO in dollars),
gold legs at the gold pool's 30-minute average tick (the observations
GoldBuyer's floor reads), combined hop by hop; pool fees count toward the 3%.
Without a 30-minute average, gold conversions are unavailable. A refusal says
whether the amount moves the pool's price (the pools' current prices are
within 3%) or the pool is off its reference. The minimum output is 1% below
the quote, and the app quotes again before signing. Afterwards it checks the
pools' transfers in the receipt and that the router's allowance is back to
zero. Selling CELO, Max keeps the next plan's KeyStore registration, 10%
spare, and this transaction's own CELO fee and registration; selling USD₮, it
leaves the relay fee when that is paid in USD₮. This is not an agent action:
the session key cannot do it, it does not count toward the agent's cap, and
it is not listed as a purchase (purchases come from GoldBuyer's `Bought`
events; gold bought here shows in the balance).

## The session key's allowlist

The grant asks for exactly two calls: `USD₮.approve` and `GoldBuyer.buy`.
Altana's SDK (through Porto) also adds "any function" on Altana's
Orchestrator to every session key. Autumn accepts that entry only for the
Orchestrator pinned in `core/src/constants.ts`, and refuses a key with any
other extra entry, a wildcard target, or the any-function entry on another
address (`expectedOnchainAllowlist`, checked in the browser, at server
activation and in the runner).

Called from the wallet, the Orchestrator has no path that moves the wallet's
tokens, and the key has no CELO limit, so any call value reverts. The entry
adds no way to move funds beyond the cap. The full reasoning, with source
line references and fork probes, is in
[direct-submit.md, "The Orchestrator entry"](direct-submit.md#the-orchestrator-entry).

The allowlist the account stored on mainnet for the end-to-end run was
exactly these three entries ([mainnet-results.md](mainnet-results.md)).

## How the server knows a request comes from the wallet owner

The server never asks for a signature. It trusts the chain instead.

- Creating a plan only makes a session key on the server. That key can do
  nothing until the wallet grants it onchain.
- The server activates a plan only when the chain shows that this wallet's
  account holds exactly that key, with the plan's cap, period, allowlist and
  expiry. Only the wallet's passkey can add a key to the account.
- The server stops a plan only when the chain shows the key revoked.

The SDK has no way to sign a message with the passkey, and a new wallet
cannot verify signatures onchain before its first transaction, so a signed
challenge would not work for a first plan anyway.

## Custody of the session key

The server generates the session key and stores its private key encrypted
with AES-256-GCM (a fresh 96-bit IV per key) under
`AUTUMN_KEY_ENCRYPTION_KEY` (`agent/src/crypto.ts`). The browser receives only
the public key and grants it. Someone with both the database and the
encryption key can use the session key within its limits (the cap, the
allowlist and the expiry) until the owner revokes it. Losing the encryption
key strands every active plan (`web/.env.example`). "Send out" does not
depend on it: it needs only the passkey, the Altana relay and a Celo RPC.

The agent wallet's private key is a server setting,
`AUTUMN_DIRECT_SUBMITTER_KEY`. It cannot sign intents; with it, someone can
spend the agent wallet's own CELO, and send intents the session key has
already signed.
