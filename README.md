# Autumn

A little gold every week. Never more than you allow.

Autumn buys a little tokenized gold (Tether Gold, XAUt0) for you on Celo every
week or every day, from a wallet that only your passkey controls. Unlike an
exchange's recurring buy, you hold the gold yourself, and the agent's limits
are public and enforced onchain: anyone can read them, and nobody, Autumn
included, can raise them without your passkey.

The agent works from a session key that the chain limits to a weekly or daily
USD₮ cap (fees included), to two calls (`USD₮.approve` and `GoldBuyer.buy`)
plus the Altana Orchestrator entry that Altana adds to every agent key (it
cannot move funds, see below), and to an expiry date. Stopping it is one onchain revoke, approved with your
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
   relay fees in USD₮. Altana's SDK also gives every session key "any
   function" on Altana's Orchestrator contract. Autumn accepts that entry only
   for the Orchestrator pinned in `core/src/constants.ts`, and refuses a key
   with any other extra entry or wildcard. Called from the wallet, the
   Orchestrator cannot take the wallet's tokens, and the key has no CELO
   allowance, so the entry adds no way to move funds beyond the cap
   ([direct-submit.md, "The Orchestrator entry"](docs/direct-submit.md#the-orchestrator-entry)). Everything it spends, fees included, is bounded by the
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
  ([RESULTS section 7](docs/altana-spike/RESULTS.md)). The opt-in direct
  submitter (`AUTUMN_SUBMITTER=direct`, [docs/direct-submit.md](docs/direct-submit.md))
  puts the tag at the end of the outer transaction, where `verifyTx` reads
  it, with two caveats:
  - Whether Celo's dashboard credits a transaction whose outer sender is our
    agent EOA (not the user's wallet) is not confirmed.
  - Anyone who sees a signed intent before it is mined can submit it
    themselves without the tag. The purchase still happens exactly once
    (the intent's nonce is used once); only the tag is lost.
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

### Running as a Node server

`npm run build && npm start` in `web/` serves the same app from any Node host.
The live deployment at https://autumn-gold.onrender.com runs this way. Such a
host needs something to call the purchase tick: set `AUTUMN_SCHEDULER=internal`
to run it in-process once per UTC hour, or call `/api/cron/tick` from a
scheduler with the `CRON_SECRET` header.

### Deploying on Cloudflare

The app runs as one Cloudflare Worker, `autumn`, built with the OpenNext
adapter (`@opennextjs/cloudflare`). The config is in `web/wrangler.jsonc`,
`web/open-next.config.ts` and `web/worker.ts`. Commands run from `web/`.

1. Log in once: `npx wrangler login`.
2. Add the server settings as secrets (each command prompts for the value):

   ```bash
   npx wrangler secret put DATABASE_URL               # Neon's pooled URL, with sslmode=require
   npx wrangler secret put AUTUMN_KEY_ENCRYPTION_KEY
   npx wrangler secret put CRON_SECRET
   npx wrangler secret put AUTUMN_GOLD_BUYER_ADDRESS
   npx wrangler secret put AUTUMN_GOLD_BUYER_DEPLOY_BLOCK
   # optional: AUTUMN_CELO_RPC_URL, AUTUMN_LOGS_BLOCK_RANGE,
   # AUTUMN_SUBMITTER=direct with AUTUMN_DIRECT_SUBMITTER_KEY (docs/direct-submit.md)
   ```

   `AUTUMN_EXECUTION` is a plain variable in `wrangler.jsonc` (`dry-run`).
   Change it to `live` there, and deploy, to send purchases. Secrets need
   the Worker to exist: if `secret put` says it does not, deploy once first
   (step 4), then add them.
3. Create the tables from your machine, out of band: `npm run migrate`
   (it reads `DATABASE_URL` from `web/.env.local`). The Worker never runs
   migrations.
4. Build and deploy with the public values in the environment. Next.js
   inlines every `NEXT_PUBLIC_…` value into the browser code at build time,
   so they must be set when `cf:build` runs (in the shell, or in
   `web/.env.production.local`); setting them on the Worker later changes
   nothing.

   ```bash
   export NEXT_PUBLIC_AUTUMN_GOLD_BUYER_ADDRESS=0x…
   export NEXT_PUBLIC_AUTUMN_GOLD_BUYER_DEPLOY_BLOCK=…
   export NEXT_PUBLIC_AUTUMN_RP_ID=autumn.<your-subdomain>.workers.dev
   export NEXT_PUBLIC_AUTUMN_APP_ORIGIN=https://autumn.<your-subdomain>.workers.dev
   npm run cf:build     # builds core/ and agent/, then the Worker
   npm run cf:deploy
   ```

   On `workers.dev` the passkey rpId is the full hostname,
   `autumn.<your-subdomain>.workers.dev`, not `workers.dev` (a public
   suffix, which browsers refuse). Passkeys made there work only there, so
   choose the final domain before users create passkeys. With a custom
   domain, use that domain for both values and rebuild.
5. Preview the built Worker locally in the Workers runtime with
   `npm run cf:preview` (settings from `web/.dev.vars`, same names as the
   secrets).

**Cron.** `wrangler.jsonc` sets a Cron Trigger at minute 7 of every hour
(UTC). `web/worker.ts` handles it by calling the app's own
`/api/cron/tick` handler inside the Worker, with `CRON_SECRET`, so no
request goes over the internet. You can still run a tick by hand with the
`curl` command above; keep the connection open until it answers, because
Cloudflare stops an HTTP request's work when the client disconnects. Runs and
failures appear under the Worker's Logs (observability is on).

**Limits.** One run handles four plans at a time (a wallet's plans one after
another), reads purchase history once from the oldest point it needs, and
returns within 240 seconds, leaving any plans it did not reach for the next
run. Most of that time is spent waiting on the RPC and the relay, which
does not count as CPU time.

| | Free plan | Paid plan |
|---|---|---|
| CPU per HTTP request | 10 ms | 30 s default, up to 5 min (`limits.cpu_ms`) |
| CPU per Cron Trigger | 10 ms | 15 min for an hourly schedule |
| Wall-clock, HTTP request | no limit while the client stays connected | same |
| Wall-clock, Cron Trigger | 15 min | 15 min |
| Subrequests per invocation | 50 | 10,000 |
| Worker size | 64 MiB uncompressed | 64 MiB uncompressed |

The 240-second budget fits the 15-minute cron limit on both plans. Do not
count on the free plan for the agent: a tick reads logs in 5,000-block pages
and calls the RPC and the relay for every plan, so a few active plans pass
50 subrequests, and its signing, ABI encoding and JSON work is unlikely to
stay within 10 ms of CPU (not measured on Cloudflare; the local runtime does
not report CPU time). The landing page is a static asset and costs no CPU.
Use Workers Paid for a deployment that buys. The built Worker is about
8.3 MiB uncompressed (1.8 MiB gzipped). Cloudflare no longer limits the
compressed size; it was 3 MiB (free) and 10 MiB (paid) until September 2026.

**Postgres.** The Worker uses the same `pg` driver as Node, over Cloudflare's
TCP sockets, with a new connection pool per request (Workers do not allow a
connection opened by one request to be used by another). Two runs at once
cannot buy twice: each purchase is claimed in Postgres first. With the
direct submitter, two runs sharing the agent EOA also take turns sending (a
transaction-level Postgres advisory lock per EOA, held on one connection for
the whole send), so they never reuse its transaction nonce. A
transaction-level lock works through Neon's pooled URL; a session-level lock
would not. Hyperdrive is optional and not configured.

**Build note.** `next build` and `next dev` use Turbopack as before. The
Worker build (`cf:build`) runs `next build --webpack` with `web/` as the
tracing root (set in `open-next.config.ts` and `next.config.ts`), because
Turbopack needs the repository root to reach `../core` and `../agent`, while
OpenNext expects the app's own directory as the root.

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

## Deployed on Celo mainnet

| What | Address |
|---|---|
| `GoldBuyer` (source verified on Sourcify) | [`0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0`](https://celoscan.io/address/0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0), block 83,395,551 |

The USD₮/XAUt0 pool kept one price observation, so its 30-minute average was
often unavailable. Two transactions raised its capacity to 1,800 observations
([`0x3058…b4d7`](https://celoscan.io/tx/0x3058feaf6c9a19b850b868a31f951e748535c91e78e50bec47a504de7d41b4d7),
[`0x657b…934c`](https://celoscan.io/tx/0x657b695b7ad16ab3d11fa5171ffb21b9b2964772fd0708c94cbb9e847b59934c)).
The first purchase through the contract was a team test of 1 USD₮
([`0x015b…d588`](https://celoscan.io/tx/0x015b6ddf1524028a34f0652d9a6fee28c01dfc7bf45a1a2a6927321e2863d588)).

## Licence

MIT
