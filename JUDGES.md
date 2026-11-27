# For judges: what to check, in order

Autumn buys a little tokenized gold (Tether Gold, XAUt0) with USD₮ on Celo,
every day or every week, into an Altana wallet that only the owner's passkey
controls. The agent can only do what its session key allows: a USD₮ cap per
period, two allowed calls and an expiry, all stored onchain.

Everything below is on Celo mainnet (chain 42220) and can be checked on the
linked explorers. Numbers that change every day (purchases, buyers, volume)
are not repeated here: they live in [docs/usage.md](docs/usage.md), which
`node scripts/proof.mjs` regenerates from the chain.

## 1. Use it (5 minutes)

1. Open https://autumngold.app and create a wallet with a passkey. There is
   no seed phrase.
2. Deposit USD₮ and some CELO (the app shows how much CELO Altana's KeyStore
   registration needs), pick a plan, and approve it with the passkey.
3. Open "Onchain proof": the agent key, the calls it may make, its cap and
   expiry, and the agent's ERC-8004 identity, all read from Celo.
4. Wait for the agent's purchase in Activity, then try "Stop the agent" and
   "Send out".

## 2. Check it onchain

| What | Where |
|---|---|
| Agent wallet (registered with the entry; sends every purchase) | [`0x0b5B7ec235F2291396c63F4afc96599B4F70a9Dd`](https://celoscan.io/address/0x0b5B7ec235F2291396c63F4afc96599B4F70a9Dd) |
| Agent identity (ERC-8004, registered from the agent wallet) | [Agent #10098](https://8004scan.io/agents/celo/10098), registration [`0x66a0…182b`](https://celoscan.io/tx/0x66a0295db77343c5f0b05f50609f5014df5501802e71640f8230f3d127c2182b) |
| `GoldBuyer`, the only contract the agent may buy through (source verified on Sourcify) | [`0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0`](https://celoscan.io/address/0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0) |
| Every purchase, with buyer, sender and whether `verifyTx` credits it | [docs/usage.md](docs/usage.md) and [docs/proof/purchases.json](docs/proof/purchases.json) |
| Grant, purchase, refusals and revoke from the recorded runs | [docs/mainnet-results.md](docs/mainnet-results.md) |

Every agent purchase is one Altana intent, signed by the session key and
sent by the agent wallet to Altana's Orchestrator with our ERC-8021 tag
(`celo_c24c5a65e5a3`) as the last bytes of the calldata, so Celo's
`verifyTx` credits it to the buyer's wallet.

## 3. Altana Agent Wallets track requirements

| Requirement | How Autumn meets it | Evidence |
|---|---|---|
| An Altana wallet on Celo mainnet | Each owner gets an Altana wallet whose only admin key is their passkey | Passkey wallet [`0x1585…5429`](https://celoscan.io/address/0x15855ae2E04Fd00eFA45cB70D2C29E5777925429) and the buyers in [docs/usage.md](docs/usage.md) |
| A session key a person grants | The plan the owner picks becomes the grant: cap per UTC day or week (amount plus a 0.05 USD₮ fee allowance), allowlist `USD₮.approve` and `GoldBuyer.buy` (plus the Orchestrator entry Altana adds), expiry 12 weeks | Grant [`0xfef8…263b`](https://celoscan.io/tx/0xfef8bc0df856fdecdd66788c48a3c702fb6957bfd601060a8fc30f717beb263b) |
| Limits enforced onchain | Over-cap and outside-allowlist attempts are refused before anything is sent | [docs/mainnet-results.md](docs/mainnet-results.md), refusals |
| The person can revoke | "Stop the agent" sends one revoke, approved with the passkey; later purchases are refused | Revoke [`0xd447…72f5`](https://celoscan.io/tx/0xd447908bd5e96c246ec46435c462a5f41309794588c15ecc5a6f841629f672f5) |
| Real use | Wallets outside the team run their own plans on mainnet | [docs/usage.md](docs/usage.md) (team wallets are flagged and not counted) |
| ERC-8004 identity | Registered from the agent wallet | [Agent #10098](https://8004scan.io/agents/celo/10098) |

## 4. Where to look in the code

| Claim | Where |
|---|---|
| The plan becomes the session grant (cap, allowlist, expiry) | `core/src/grant.ts` (`planToSessionGrant`, `expectedOnchainAllowlist`) |
| The server checks what the wallet actually granted before acting | `core/src/verify.ts` (`sessionLimitsMismatch`), `core/src/grant.ts` (`sessionMatchesGrant`) |
| Scheduling, fee allowance, refusals and retries | `agent/src/runner.ts` |
| Altana prepares the intent, the agent wallet sends it with the tag last | `agent/src/directPrepared.ts`, `agent/src/production.ts` (`submitterFromEnv`) |
| The ERC-8021 tag | `core/src/attribution.ts` |
| Price floor that does not trust the caller (30-minute average) | `contracts/src/GoldBuyer.sol` |
| Revoke and "Send out" with the passkey | `web/src/lib/autumn.live.ts` |
| The usage report | `scripts/proof.mjs` |

## 5. Run the tests

More than 350 tests across the packages; none needs secrets.

```bash
cd core && npm test
cd ../agent && npm test
cd ../web && npm test && npm run typecheck
cd ../contracts && forge test   # fork tests need a Celo RPC; offline they are skipped and the unit tests still run
```

## 6. Limits

Said plainly in the README: [Status and known limits](README.md#status-and-known-limits).
