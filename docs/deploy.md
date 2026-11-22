# Deploying Autumn

## Node server on any host (what the live deployment runs)

The live deployment at https://autumn-gold.onrender.com runs the Next.js app
as one long-lived Node server on Render, with the purchase tick run
in-process. Any host that runs Node 22 works the same way.

Build command (from the repository root):

```bash
cd web && npm ci --include=dev && npm run build:deps && npm run build
```

`build:deps` installs and builds `core/` and `agent/`, which the app imports.

Start command:

```bash
cd web && npx next start -p $PORT
```

Environment variables (names as in `web/.env.example`, which explains each):

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_AUTUMN_GOLD_BUYER_ADDRESS`, `NEXT_PUBLIC_AUTUMN_GOLD_BUYER_DEPLOY_BLOCK` | GoldBuyer and its deploy block ([README, "Deployed on Celo mainnet"](../README.md#deployed-on-celo-mainnet)) |
| `NEXT_PUBLIC_AUTUMN_RP_ID` | The passkey rpId: the domain the app is served on. Passkeys made for one rpId do not work on another, so choose it before users create passkeys |
| `NEXT_PUBLIC_AUTUMN_APP_ORIGIN` | Optional: the exact origin passkeys may be used from |
| `NEXT_PUBLIC_AUTUMN_CELO_RPC_URL`, `NEXT_PUBLIC_AUTUMN_LOGS_BLOCK_RANGE` | Optional browser RPC and `eth_getLogs` block limit |
| `DATABASE_URL` | Postgres connection string |
| `AUTUMN_KEY_ENCRYPTION_KEY` | 32 random bytes in hex; encrypts session keys at rest |
| `AUTUMN_GOLD_BUYER_ADDRESS`, `AUTUMN_GOLD_BUYER_DEPLOY_BLOCK` | Same values as the public ones |
| `AUTUMN_CELO_RPC_URL`, `AUTUMN_LOGS_BLOCK_RANGE` | Optional server RPC and block limit |
| `AUTUMN_EXECUTION` | `live` sends purchases; anything else is a dry run |
| `AUTUMN_SUBMITTER` | Who sends purchases: `relay` (the default) hands the signed intent to Altana's relay; `direct-prepared` lets the relay prepare and price it, then sends it from the agent wallet with the attribution tag last; `direct` builds a fee-free intent itself ([direct-submit.md](direct-submit.md)). The live deployment runs `direct-prepared` |
| `AUTUMN_DIRECT_SUBMITTER_KEY` | With `direct-prepared` or `direct`: the agent wallet's private key (0x + 64 hex). That wallet pays every purchase's gas in CELO (339,272 gas, 0.0687 CELO on mainnet purchase `0x3497…53a9`), so keep it funded; with too little CELO the agent does not send. The live deployment's agent wallet is [`0x0b5B…a9Dd`](https://celoscan.io/address/0x0b5B7ec235F2291396c63F4afc96599B4F70a9Dd), the address registered with the hackathon entry |
| `CRON_SECRET` | At least 16 characters; protects `/api/cron/tick` and `/api/admin/probe` |
| `AUTUMN_SCHEDULER=internal` | Runs the purchase tick in-process once per UTC hour (from minute 5) |
| `AUTUMN_KEEP_AWAKE_URL` | Optional, with the line above: a URL requested every ten minutes, so a host that suspends idle services keeps this one running (for example the app's own `/api/health`) |

Every `NEXT_PUBLIC_…` value is inlined into the browser code at build time,
so it must be set when `npm run build` runs.

Create the tables once, out of band, from a machine that can reach the
database: `cd web && npm run migrate` (it reads `DATABASE_URL` from
`web/.env.local`). The server never runs migrations.

Check the deployment with `curl https://<app>/api/health`; a configured live
server answers `{"configured":true,"live":true}`. Without
`AUTUMN_SCHEDULER=internal`, call the tick from any scheduler:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/tick
```

## Alternative: Cloudflare Workers (not what the live deployment runs)

The configuration below is in the repository, but the live deployment does
not use it.

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
   # AUTUMN_SUBMITTER=direct or direct-prepared with AUTUMN_DIRECT_SUBMITTER_KEY (docs/direct-submit.md)
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
