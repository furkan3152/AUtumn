# Autumn

A little gold every week. Never more than you allow.

Autumn buys a little tokenized gold (Tether Gold, XAUt0) for you on Celo every
week or every day, from a wallet that only your passkey controls. Unlike an
exchange's recurring buy, you hold the gold yourself, and the agent's limits
are public and enforced onchain: anyone can read them, and nobody, Autumn
included, can raise them without your passkey.

The agent works from a session key that the chain limits to a weekly or daily
USD₮ cap (fees included), to two calls (`USD₮.approve` and `GoldBuyer.buy`),
and to an expiry date. Stopping it is one onchain revoke, approved with your
passkey, for a small network fee. You can send your USD₮, gold and CELO out at
any time.

Autumn's server holds the agent's session key, encrypted. The chain limits
what that key can do; your passkey is the only admin.

Built for the Celo "Agents Open for Business" hackathon, Altana Agent Wallets
track.

## How it works

1. You create an [Altana](https://altana.network) wallet with a passkey and
   deposit USD₮ on Celo, plus CELO for Altana's key registration: about 20
   CELO for the first plan (two keys) and about half that for each new plan.
   The app reads the fee and its dollar value from Celo.
2. You pick a plan: 1, 5 or 10 USD₮ of gold per week or per day, for 12
   weeks. Confirming it grants the agent a session key with those limits,
   recorded in Altana's public Keystore. A week resets Monday 00:00 UTC and a
   day at 00:00 UTC, as the wallet contract counts them. A second passkey
   prompt registers the agent's ERC-8004 identity. Optionally, the dip rule
   adds one extra buy if the price is at least 2% below this period's
   purchase price.
3. The agent buys gold on schedule through `GoldBuyer`, a small contract with
   no owner that can only swap USD₮ for XAUt0 and send it back to the caller.
   The session key can only call `USD₮.approve` and `GoldBuyer.buy`, and pays
   relay fees in USD₮. Everything it spends, fees included, is bounded by the
   cap. (The relay fee is part of the signed intent, and the account pays it
   to whoever submits the intent: a leaked key could send up to the cap's
   remaining room as "fees". The cap is the bound, not the allowlist.) Before
   each purchase the agent asks the relay for its fee and refuses to buy when
   it is above the plan's 0.05 USD₮ per-buy allowance.
4. You can stop the agent at any time: one revoke transaction, approved with
   your passkey, for a small fee.
5. "Send out" in the Wallet panel moves USD₮, XAUt0 or CELO to any Celo
   address you control, approved with your passkey, whether the agent runs or
   not.

## Status and known limits

- **GoldBuyer is unaudited** and not deployed yet. It is about 70 lines, has
  no owner, and is fork-tested against Celo mainnet (`contracts/`). Until it
  is deployed the app shows prices and balances but cannot start a plan.
- **The funded mainnet run has not happened yet.** What it must prove is
  listed in [docs/mainnet-run.md](docs/mainnet-run.md).
- **Relay dependency.** Purchases, revokes and "Send out" go through Altana's
  relay. If it is down, the agent cannot buy (it retries) and the app cannot
  send; your funds stay in your wallet.
- **Attribution.** Our ERC-8021 tag is attached to every agent call, but
  Celo's checker does not credit tags inside a relayed transaction today
  ([RESULTS section 7](docs/altana-spike/RESULTS.md)).
- **Pool price history.** The USD₮/XAUt0 pool keeps one price observation, so
  GoldBuyer's 30-minute average check reverts for 30 minutes after any swap
  in the pool. The agent then says "Price check not available right now" and
  retries later in the period.
- **Fees relative to small buys.** Each buy pays the pool's 0.3% plus a relay
  fee (Altana reports about $0.005 on Celo). On a $1 buy that is about 0.8%;
  on $5 about 0.4%. The plan screen shows the estimate. The one-time key
  registration (about $1 in CELO today) is large next to a $1 plan.
- **Custody of the agent key.** The server holds the session key, encrypted
  with AES-256-GCM under `AUTUMN_KEY_ENCRYPTION_KEY`. Someone with the
  database and that key can spend up to the cap until you revoke.

## If our deployment is down

Your wallet does not depend on our server. Balances are onchain, and "Send
out" needs only your passkey, the Altana relay and a Celo RPC; the app keeps
working (without plans and the agent's log) when the Autumn server cannot be
reached.

The honest constraint is the passkey's **relying-party id (rpId)**. A passkey
works only on pages served from that domain (or a subdomain of it). A copy of
Autumn on another domain, or on `localhost`, cannot use a passkey created on
ours. To use the same passkey without our deployment:

1. Build the app from this repository with `NEXT_PUBLIC_AUTUMN_PREVIEW` unset,
   `NEXT_PUBLIC_AUTUMN_RP_ID` set to our domain, the GoldBuyer address and
   block from our deployment, and no server settings (the app then shows the
   server as unreachable, which is fine for sending out).
2. Serve it on that domain from your own machine: point the domain at
   `127.0.0.1` in your hosts file and serve it over HTTPS with a certificate
   your browser trusts (for example one made with `mkcert`). Browsers allow
   passkeys only in a secure context.
3. Open it, tap "I already have an Autumn passkey", then "Send funds out".
   (Finding the wallet from the passkey works once the wallet has made at
   least one transaction, which every wallet with a plan has.)

If the domain itself is lost (for example it expires and someone else takes
it), the passkey cannot be used by a website any more. That is a property of
passkeys, not something Autumn can work around. Move funds out while you can.

## Layout

| Path | Contents |
|---|---|
| `web/` | The app (Next.js) |
| `contracts/` | `GoldBuyer` and its mainnet-fork tests |
| `core/` | Chain constants, the grant a plan asks for, calldata, quotes and chain readers |
| `agent/` | The purchase runner, plan service, Postgres storage and CLI |
| `docs/altana-spike/` | Findings and scripts from testing the Altana flow on Celo |

## Run it yourself

You need Node 22, a Postgres database (for example Neon) and, for the
passkey, a browser that supports passkeys. Everything below runs against Celo
mainnet. Reading needs no funds. A plan needs a funded wallet; see
[docs/mainnet-run.md](docs/mainnet-run.md).

1. Build the two libraries the app uses.

   ```bash
   cd core && npm ci && npm run build && cd ..
   cd agent && npm ci && npm run build && cd ..
   cd web && npm ci
   ```

2. Copy `web/.env.example` to `web/.env.local` and fill it in.
   - `DATABASE_URL`: your Postgres connection string.
   - `AUTUMN_KEY_ENCRYPTION_KEY`: 32 random bytes in hex. Make one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - `AUTUMN_GOLD_BUYER_ADDRESS` and `AUTUMN_GOLD_BUYER_DEPLOY_BLOCK`: the
     deployed GoldBuyer and its block. Put the same two values in the
     `NEXT_PUBLIC_AUTUMN_…` lines. GoldBuyer is not deployed yet: until it is,
     the app shows the gold price and balances but says plans cannot start.
   - `NEXT_PUBLIC_AUTUMN_RP_ID=localhost` for local use. On a real domain, use
     that domain. Passkeys made for one rpId do not work on another.
   - `CRON_SECRET`: any random string of 16 characters or more.
   - `AUTUMN_EXECUTION`: leave `dry-run` to see decisions without spending.
     Set `live` to send real purchases.

3. Create the tables.

   ```bash
   cd web && npm run migrate
   ```

4. Start the app and open http://localhost:3000.

   ```bash
   npm run dev
   ```

   To see the screens without a wallet or a chain, set
   `NEXT_PUBLIC_AUTUMN_PREVIEW=1` instead. Nothing in preview is real.

5. Run the agent once. This is what the cron does every hour.

   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick
   ```

   The answer lists each active plan and what the agent decided. The same
   command works against a deployed app. From `agent/` you can also run
   `node --env-file=../web/.env.local dist/cli.js tick`.

6. Run the tests.

   ```bash
   cd core && npm test && npm run test:integration   # the second reads Celo mainnet
   cd ../agent && npm test                            # add TEST_DATABASE_URL for the Postgres tests
   cd ../web && npm test && npm run typecheck
   ```

### Deploying on Vercel

- Set the project root to `web/` and turn on "Include files outside the root
  directory". The `vercel-build` script builds `core/` and `agent/` first.
- Add every variable from `web/.env.example` to the project.
- `web/vercel.json` runs the agent every hour. Hourly cron needs a paid
  Vercel plan; on the free plan, call `/api/cron/tick` from any scheduler with
  the same header. The agent retries skipped purchases on each run, so a
  daily-only schedule can miss a retry window.
- One run handles four plans at a time (a wallet's plans one after another),
  reads purchase history once from the oldest point it needs, and returns
  within 240 seconds, leaving any plans it did not reach for the next run.
  Two runs at once cannot buy twice: each purchase is claimed in Postgres
  first.

### How the server knows a request comes from the wallet owner

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

## Licence

MIT
