# Autumn

Autumn buys a small amount of tokenized gold (Tether Gold, XAUt0) with USD₮ on
Celo every day or every week, from an [Altana](https://altana.network) wallet
that only your passkey controls. The agent works from a session key whose
limits are stored onchain: a USD₮ cap per period, a short allowlist of calls
and an expiry. Anyone can read them, and only your passkey can add or revoke a
key. Built for the Celo "Agents Open for Business" hackathon, Altana Agent
Wallets track. Live app: https://autumn-gold.onrender.com

## How it works

1. You create an Altana wallet with a passkey and deposit USD₮, plus CELO for
   Altana's KeyStore registration (about 20 CELO for the first plan, which
   registers two keys, and about half that for each later plan; 10% of what
   is sent is refunded). The app reads the fee from Celo.
2. You choose 1, 5 or 10 USD₮ of gold per day or per week, for 12 weeks.
   Confirming grants the agent a session key limited to:
   - a USD₮ cap per period (UTC day, or week from Monday 00:00 UTC) equal to
     the amount plus a 0.05 USD₮ fee allowance per purchase; relay fees come
     out of the same cap (it is sized for two purchases if you turn on the
     optional dip rule);
   - an allowlist of `USD₮.approve`, `GoldBuyer.buy`, and the entry for
     Altana's Orchestrator that Altana's SDK adds to every session key (it
     adds no way to move funds beyond the cap; see
     [docs/direct-submit.md](docs/direct-submit.md#the-orchestrator-entry));
   - an expiry 12 weeks out.

   A second passkey prompt registers the agent's ERC-8004 identity.
3. The agent buys on schedule through `GoldBuyer`, a 73-line contract with no
   owner that swaps USD₮ for XAUt0 and sends the gold to the caller. It
   refuses a purchase when the relay's fee is above the allowance.
4. You can stop the agent at any time with one revoke transaction, approved
   with your passkey.
5. "Send out" moves USD₮, XAUt0 or CELO to any Celo address, with your
   passkey, whether the agent runs or not.

The schedule rules, the fee allowance, how the server checks what the wallet
granted, and how it holds the session key are in
[docs/architecture.md](docs/architecture.md).

## Hackathon track requirements

All transactions below are on Celo mainnet, from the end-to-end run of
22 Nov 2026 ([docs/mainnet-results.md](docs/mainnet-results.md)).

| Requirement | Evidence |
|---|---|
| Altana wallet on Celo mainnet | Wallet [`0xA177…683C`](https://celoscan.io/address/0xA177651FC7F9BfF0804ad123c4fdb8aa6625683C), upgraded to the Altana account by the grant [`0xfef8…263b`](https://celoscan.io/tx/0xfef8bc0df856fdecdd66788c48a3c702fb6957bfd601060a8fc30f717beb263b). A wallet whose only admin key is a passkey, [`0x1585…5429`](https://celoscan.io/address/0x15855ae2E04Fd00eFA45cB70D2C29E5777925429), granted a session key with its passkey ([`0xd1f9…be75`](https://celoscan.io/tx/0xd1f9795a68fc683499615b3afa1099b1ebecc7aaf95bf0a04a101a9e3d0bbe75)), had the agent buy ([`0x21cc…32ca`](https://celoscan.io/tx/0x21ccf27b7a1a644415ef8f3b8c42348254ea61e73a4867a1a2cca368269e32ca)) and revoked the key ([`0x67fc…1dce`](https://celoscan.io/tx/0x67fc22a957a6cc97ae27d57752c233124f7bc36c3770e91a0eed7b81c11b1dce)) |
| Session key with spend cap, allowlist and expiry | Grant [`0xfef8…263b`](https://celoscan.io/tx/0xfef8bc0df856fdecdd66788c48a3c702fb6957bfd601060a8fc30f717beb263b): cap 1.05 USD₮ per day, allowlist `approve`, `buy` and the Orchestrator entry, expiry 12 weeks. Agent purchase [`0xe6f4…c785`](https://celoscan.io/tx/0xe6f4f902d68a8897be76c11eae1a96e483e749624ff3f103b749399fd75cc785). An over-cap purchase was refused (`spend_limit_exceeded`) and a call outside the allowlist was refused (`call_not_permitted`); neither sent a transaction |
| Revoke stops the agent | Revoke [`0xd447…72f5`](https://celoscan.io/tx/0xd447908bd5e96c246ec46435c462a5f41309794588c15ecc5a6f841629f672f5); the key is gone from the account and the KeyStore, the server stopped the plan, and a purchase attempted afterwards was refused |
| ERC-8004 agent identity | Agent id 10096, [`0xe99e…e2e9`](https://celoscan.io/tx/0xe99e01a60e12f3f18e7d9b1601d7eac618f163b2195fea6ce7478a9866dae2e9), https://8004scan.io/agents/celo/10096. The passkey wallet registered agent id 10097, [`0x446c…aabe`](https://celoscan.io/tx/0x446c0bd4f4bb5cb2ee5b50141e3a1a2a1864b4d55fd70bff736f865c0d15aabe), https://8004scan.io/agents/celo/10097 |

## Onchain usage

Every purchase through GoldBuyer is a public `Bought` event.
[docs/usage.md](docs/usage.md) lists them all with totals, generated from
Celo mainnet; regenerate it with `node scripts/proof.mjs`. Purchases by the
team's own wallets are flagged and not counted as users; at the last read
there were no independent buyers.

## Deployed on Celo mainnet

| What | Address |
|---|---|
| `GoldBuyer` (source verified on Sourcify) | [`0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0`](https://celoscan.io/address/0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0), block 83,395,551 |

The USD₮/XAUt0 pool kept one price observation, so GoldBuyer's 30-minute
average price check was often unavailable. Two transactions raised its
capacity to 1,800 observations
([`0x3058…b4d7`](https://celoscan.io/tx/0x3058feaf6c9a19b850b868a31f951e748535c91e78e50bec47a504de7d41b4d7),
[`0x657b…934c`](https://celoscan.io/tx/0x657b695b7ad16ab3d11fa5171ffb21b9b2964772fd0708c94cbb9e847b59934c)).

## Status and known limits

- **GoldBuyer is unaudited.** It has no owner and is fork-tested against
  Celo mainnet (`contracts/`).
- **Relay dependency.** Purchases, revokes and "Send out" go through Altana's
  relay. If it is down, the agent cannot buy (it retries) and the app cannot
  send; funds stay in the wallet.
- **Attribution.** Our tag `celo_c24c5a65e5a3` is attached to every agent
  call, but Celo's `verifyTx` returns null for relayed transactions, because
  it reads the tag only at the end of the outer calldata. Reported as
  https://github.com/celo-org/attribution-tags/issues/30. A direct submitter
  that puts the tag at the end exists ([docs/direct-submit.md](docs/direct-submit.md)),
  is off by default, and is not used by the live deployment.
- **Fees relative to small buys.** Each buy pays the pool's 0.3% and a relay
  fee (0.0097 USD₮ and 0.0075 USD₮ on the two agent purchases so far), so
  about 1.0 to 1.3% on a 1 USD₮ buy. The first plan's KeyStore registration cost
  18.49 CELO (about 1 USD₮ at the time).
- **Price check.** If the pool's oldest stored observation is younger than
  30 minutes, GoldBuyer reverts; the agent skips and retries later in the
  period.
- **Custody of the session key.** The server holds it encrypted with
  AES-256-GCM under `AUTUMN_KEY_ENCRYPTION_KEY`. Someone with the database
  and that key can spend up to the cap until you revoke.
- **Device-bound passkeys.** On Android the app makes a passkey that lives on
  that phone only. If the phone is reset or the passkey deleted, the wallet
  cannot sign again; see [docs/passkeys.md](docs/passkeys.md).

## Repository layout

| Path | Contents |
|---|---|
| `web/` | The app (Next.js), its API routes and the in-process scheduler |
| `contracts/` | `GoldBuyer` and its mainnet-fork tests (Foundry) |
| `core/` | Chain constants, the grant a plan asks for, calldata, quotes and chain readers |
| `agent/` | The purchase runner, plan service, Postgres storage and CLI |
| `scripts/` | `proof.mjs` (read-only usage report) and `e2e-mainnet.mjs` (funded end-to-end run) |
| `docs/` | Architecture, passkeys, deployment, mainnet runbook and results, research notes |

## Run it yourself

You need Node 22 and a Postgres database. Everything runs against Celo
mainnet; reading needs no funds.

```bash
cd core && npm ci && npm run build && cd ..
cd agent && npm ci && npm run build && cd ..
cd web && npm ci
cp .env.example .env.local   # fill it in; see the comments in the file
npm run migrate              # create the tables
npm run dev                  # http://localhost:3000
```

Put the GoldBuyer address and block from
[Deployed on Celo mainnet](#deployed-on-celo-mainnet) in both the `AUTUMN_…`
and `NEXT_PUBLIC_AUTUMN_…` lines, and use `NEXT_PUBLIC_AUTUMN_RP_ID=localhost`
locally. Leave
`AUTUMN_EXECUTION=dry-run` to see decisions without spending; `live` sends
purchases. `NEXT_PUBLIC_AUTUMN_PREVIEW=1` shows the screens with no wallet or
chain. Run the agent once (what the scheduler does every hour):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick
# or, from agent/: node --env-file=../web/.env.local dist/cli.js tick
```

Tests:

```bash
cd core && npm test && npm run test:integration   # the second reads Celo mainnet
cd ../agent && npm test                            # add TEST_DATABASE_URL for the Postgres tests
cd ../web && npm test && npm run typecheck
```

## Docs

- [docs/architecture.md](docs/architecture.md): schedule, fee allowance, the Orchestrator entry, server trust model, key custody
- [docs/passkeys.md](docs/passkeys.md): device-bound passkeys, the backup code, recovery without our deployment
- [docs/deploy.md](docs/deploy.md): deploying on a Node host, and the Cloudflare Workers alternative
- [docs/mainnet-results.md](docs/mainnet-results.md): the 22 Nov 2026 mainnet runs
- [docs/mainnet-run.md](docs/mainnet-run.md): runbook for the funded end-to-end run and the manual passkey checklist
- [docs/usage.md](docs/usage.md): every purchase through GoldBuyer (generated)
- [docs/direct-submit.md](docs/direct-submit.md): submitting the Altana intent directly, and the Orchestrator entry
- [docs/altana-spike/RESULTS.md](docs/altana-spike/RESULTS.md): research before the build

## Licence

MIT
