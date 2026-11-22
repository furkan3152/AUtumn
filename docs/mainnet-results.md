# Mainnet results, 22 Nov 2026

Two runs on Celo mainnet against the live deployment
(https://autumn-gold.onrender.com, `AUTUMN_EXECUTION=live`, relay
submission), with GoldBuyer
[`0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0`](https://celoscan.io/address/0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0).

## End-to-end run with `scripts/e2e-mainnet.mjs`

Wallet [`0xA177651FC7F9BfF0804ad123c4fdb8aa6625683C`](https://celoscan.io/address/0xA177651FC7F9BfF0804ad123c4fdb8aa6625683C),
whose admin is a private key (secp256k1), not a passkey; see
[mainnet-run.md](mainnet-run.md) for what that does and does not cover.
Plan: 1 USD₮ per day, cap 1.05 USD₮ per day. The full record, every fact
and transaction per step, is
[runs/e2e-report-0xa177651fc7f9bff0804ad123c4fdb8aa6625683c.json](runs/e2e-report-0xa177651fc7f9bff0804ad123c4fdb8aa6625683c.json).

| Step | Result | Transaction | What was checked |
|---|---|---|---|
| `preflight` | passed | none | Server healthy and live; GoldBuyer code present; 30-minute price check available; KeyStore fee 9.2449 CELO per key |
| `wallet` | passed | none | The relay registered the wallet with its admin key; the EIP-7702 upgrade lands with the grant |
| `plan` (grant) | passed | [`0xfef8bc0d…263b`](https://celoscan.io/tx/0xfef8bc0df856fdecdd66788c48a3c702fb6957bfd601060a8fc30f717beb263b) | The account stores exactly the plan's limits: USD₮ cap 1,050,000 base units per day; allowlist `USD₮.approve` (`0x095ea7b3`), `GoldBuyer.buy` (`0xd6febde8`) and the Orchestrator any-function entry (`0x32323232`); expiry 12 weeks out; not super-admin. KeyStore valid; two `KeyRegistered` events (root and session); `sessionLimitsMismatch` none; the server activated the plan |
| `tick` (purchase) | passed | [`0xe6f4f902…c785`](https://celoscan.io/tx/0xe6f4f902d68a8897be76c11eae1a96e483e749624ff3f103b749399fd75cc785) | One `Bought` event: 1 USD₮ in, 0.000281 XAUt0 out to the wallet; sent through the relay as an Orchestrator intent; session spend this period 1.00974 of 1.05 USD₮ (amount plus relay fee); our tag in 2 of 2 inner calls; `verifyTx` null |
| `tick-again` | passed | none | Decision `already_bought`; no new purchase |
| `probes` | passed (second attempt) | none | Over-cap purchase (2.05 USD₮) refused by the relay; call outside the allowlist (`USD₮.transfer`) refused by the relay; no transaction, balances unchanged |
| `identity` | passed | [`0xe99e01a6…e2e9`](https://celoscan.io/tx/0xe99e01a60e12f3f18e7d9b1601d7eac618f163b2195fea6ce7478a9866dae2e9) | ERC-8004 agent id 10096 in registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, owned by the wallet, record name "Autumn"; https://8004scan.io/agents/celo/10096 |
| `revoke` | passed | [`0xd447908b…72f5`](https://celoscan.io/tx/0xd447908bd5e96c246ec46435c462a5f41309794588c15ecc5a6f841629f672f5) | KeyStore `isValidKey` false; `getKey` reverts `KeyDoesNotExist`; `getKeys()` no longer lists the key; the server stopped the plan; a purchase attempted afterwards was refused; the next tick did not act on the plan |
| `send-out` | passed | XAUt0 [`0x888d6c53…ff95`](https://celoscan.io/tx/0x888d6c538cb5cda59bf24b9db08b50fdfbc2b8b9af2ac9a8194b781cbd0aff95), CELO [`0xe6a4f46e…b0e0`](https://celoscan.io/tx/0xe6a4f46eee47aba9c562cf759d11e5abd8c274e014d68f59315417437468b0e0), USD₮ [`0x43b66a08…7f3c`](https://celoscan.io/tx/0x43b66a086227ceb86d9d7c8592d58da110892e957e3c0e35e2fff40730117f3c) | Each transfer's receipt and the destination's balance change: 0.000281 XAUt0, 5.50023306905909459 CELO, 3.119321 USD₮ |

The run was done in two passes (12:25 and 12:31 UTC). In the first pass the
`probes` step was marked failed although the over-cap probe was refused and
balances were unchanged: the server's probe looked back sixty seconds and
counted the plan's own purchase from the `tick` step as the probe's. The
probe now counts only purchases made after it began (`agent/src/probe.ts`),
and the second pass ran `probes` and the remaining steps.

### Refusals

| Attempt | Relay error | Autumn's classification |
|---|---|---|
| Over the cap (2.05 USD₮ on a 1.05 USD₮ cap) | `spend_limit_exceeded`; relay message `ExceededSpendLimit` for USD₮ | `cap_exceeded`, nothing bought, plan keeps running |
| Outside the allowlist (`USD₮.transfer` to the wallet itself, amount 0) | `call_not_permitted`; relay message `UnauthorizedCall` | `call_not_permitted`, nothing bought |
| Purchase after the revoke | `unknown`; relay message "key hash … is unknown" | `session_ended`, nothing bought, plan stopped |

### Fees observed

| What | Paid |
|---|---|
| KeyStore registration, first grant (two keys) | 18.48976693094090541 CELO, after the 10% refund of the 20.3387 CELO sent (about 1.00 USD₮ at 0.054184 USD₮ per CELO) |
| Relay fee, grant | 0.031157 USD₮ (quoted 0.067103) |
| Relay fee, purchase | 0.00974 USD₮ (the intent's maximum was 0.019648) |
| Relay fee, revoke | 0.004883 USD₮ |
| Relay fee, send-out transfers | 0.004194 USD₮ (XAUt0), 0.003714 USD₮ (CELO), 0.003717 USD₮ (USD₮) |

The identity registration's cost is not in the report.

## Passkey wallet

A wallet whose admin is a passkey,
[`0x15855ae2E04Fd00eFA45cB70D2C29E5777925429`](https://celoscan.io/address/0x15855ae2E04Fd00eFA45cB70D2C29E5777925429),
made an agent purchase through the relay:
[`0x21ccf27b…32ca`](https://celoscan.io/tx/0x21ccf27b7a1a644415ef8f3b8c42348254ea61e73a4867a1a2cca368269e32ca),
1 USD₮ in, 0.000281 XAUt0 out, relay fee 0.007549 USD₮, signed by a session
key with Autumn's allowlist and a 1.05 USD₮ daily cap
([proof/purchases.json](proof/purchases.json)). That session key has since
been revoked. The wallet's only key on the account is a super-admin
WebAuthn P-256 key (`getKeys()`, read 22 Nov 2026). Its grant is
[`0xd1f9795a…be75`](https://celoscan.io/tx/0xd1f9795a68fc683499615b3afa1099b1ebecc7aaf95bf0a04a101a9e3d0bbe75)
(block 83,444,500) and its revoke is
[`0x67fc22a9…1dce`](https://celoscan.io/tx/0x67fc22a957a6cc97ae27d57752c233124f7bc36c3770e91a0eed7b81c11b1dce)
(block 83,444,858); both were approved with the passkey and emitted events
from the wallet itself.
