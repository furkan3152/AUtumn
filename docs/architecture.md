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

Relay fees are paid in USD₮ from the same cap. Before each purchase the
runner asks the relay for the fee of the exact calls (`quoteExecute`) and
skips the purchase, to retry later in the period, when the fee is above the
allowance (`agent/src/runner.ts`). On mainnet the agent's relay fee was
0.00974 USD₮ and 0.007549 USD₮ for the two agent purchases so far
([mainnet-results.md](mainnet-results.md), [usage.md](usage.md)).

The relay fee is part of the signed intent, and the account pays it to
whoever submits the intent. A leaked session key could therefore send up to
the cap's remaining room as "fees". The cap is the bound, not the allowlist.

## Price protection

`GoldBuyer.buy` (`contracts/src/GoldBuyer.sol`) reads the pool's 30-minute
average tick, swaps, and reverts if the price after the swap is more than
100 ticks (about 1%) below that average. The caller also passes a minimum
output, which the agent computes from its own quote. If the pool cannot
report a 30-minute average, `buy` reverts ("OLD"); the runner reports
"Price check not available right now" and retries on a later run in the
period. The pool's observation capacity was raised from 1 to 1,800 on
22 Nov 2026 ([README, "Deployed on Celo mainnet"](../README.md#deployed-on-celo-mainnet)).

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
