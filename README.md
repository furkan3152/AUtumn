# Autumn

A little gold every week. Never more than you allow.

Autumn is an agent that buys a small amount of tokenized gold (Tether Gold,
XAUt0) for you on Celo each week or each day. You keep custody: the wallet is yours, opened
with a passkey. The agent works from a session key that the chain limits to a
weekly or daily spend cap, to gold purchases delivered to your own wallet, and to an
expiry date. One transaction stops it.

Built for the Celo "Agents Open for Business" hackathon, Altana Agent Wallets
track. Work started on 21 November 2026 and is in progress.

## How it works

1. You create an [Altana](https://altana.network) wallet with a passkey and
   deposit USD₮ on Celo.
2. You pick a plan: 1, 5 or 10 USD₮ of gold per week or per day, for 12
   weeks. Confirming it grants the agent a session key with those limits,
   recorded in Altana's public Keystore. A week resets Monday 00:00 UTC and a
   day at 00:00 UTC, as the wallet contract counts them.
3. The agent buys gold on schedule through `GoldBuyer`, a small contract with
   no owner that can only swap USD₮ for XAUt0 and send it back to the caller.
   The session key can call nothing else.
4. You can stop the agent at any time. The revoke is one onchain transaction.

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
