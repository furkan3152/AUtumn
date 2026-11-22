# Mainnet results, 22 Nov 2026

Runs on Celo mainnet against the live deployment
(https://autumn-gold.onrender.com, `AUTUMN_EXECUTION=live`), with GoldBuyer
[`0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0`](https://celoscan.io/address/0xB279c4380557b319C42ef3B023Ac8C8b2d64B6A0).
The first end-to-end run and the passkey wallet's purchase used relay
submission (`AUTUMN_SUBMITTER=relay`). The second end-to-end run used
`AUTUMN_SUBMITTER=direct-prepared`, which the live deployment now runs: the
relay prepares each purchase and Autumn's agent wallet
[`0x0b5B7ec235F2291396c63F4afc96599B4F70a9Dd`](https://celoscan.io/address/0x0b5B7ec235F2291396c63F4afc96599B4F70a9Dd)
sends it ([direct-submit.md, section 5](direct-submit.md)).

## End-to-end run with `scripts/e2e-mainnet.mjs` (relay submission)

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

## Second end-to-end run (`direct-prepared`)

Wallet [`0x88DeB13766F676C70cC27770d1fEd5c3Eb2414db`](https://celoscan.io/address/0x88DeB13766F676C70cC27770d1fEd5c3Eb2414db),
a new team test wallet whose admin is a private key (secp256k1). Plan: 1 USD₮
per day, cap 1.05 USD₮ per day. Run between 15:08 and 15:16 UTC in five
passes, every step passing at its first attempt. The full record is
[runs/e2e-report-0x88deb13766f676c70cc27770d1fed5c3eb2414db.json](runs/e2e-report-0x88deb13766f676c70cc27770d1fed5c3eb2414db.json).

| Step | Result | Transaction | What was checked |
|---|---|---|---|
| `preflight` | passed | none | Server healthy and live; GoldBuyer code present; 30-minute price check available; KeyStore fee 9.2479 CELO per key |
| `wallet` | passed | none | The relay registered the wallet with its admin key; the EIP-7702 upgrade lands with the grant |
| `plan` (grant) | passed | [`0x4ad6e1bc…603e`](https://celoscan.io/tx/0x4ad6e1bc7edd078da19bed54d9b315f9e6341165decbc166a7bb0c677af8603e) | The account stores exactly the plan's limits: USD₮ cap 1,050,000 base units per day; allowlist `USD₮.approve`, `GoldBuyer.buy` and the Orchestrator any-function entry; expiry 12 weeks out; not super-admin. KeyStore valid; two `KeyRegistered` events; `sessionLimitsMismatch` none; the server activated the plan. Sent by the relay |
| `tick` (purchase) | passed | [`0x34972329…53a9`](https://celoscan.io/tx/0x34972329dfa9f0011cacf8e56ace9d7b45de40ffa174f158ccc4f798bd3953a9) | One `Bought` event: 1 USD₮ in, 0.00028 XAUt0 out to the wallet. Outer transaction from the agent wallet `0x0b5B…a9Dd` to the Orchestrator. Altana's fee 0.016328 USD₮ paid to `0xaF08…C4bC` (intent `paymentAmount` 16,328, maximum 16,328); session spend this period 1.016328 of 1.05 USD₮. Our tag at the end of the outer calldata and in 2 of 2 inner calls; `verifyTx` returns `{"codes":["celo_c24c5a65e5a3"]}` |
| `tick-again` | passed | none | Decision `already_bought`; no new purchase |
| `probes` | passed | none | Over-cap purchase (2.05 USD₮) and a call outside the allowlist (`USD₮.transfer`) both refused when the relay was asked to prepare them; no transaction, balances unchanged |
| `identity` | passed | [`0xf1d11270…015a`](https://celoscan.io/tx/0xf1d1127007f054064c1bdf12d218a4ef741eb74eed9fb13ec1bccc907be9015a) | ERC-8004 agent id 10099, owned by the wallet, record name "Autumn"; https://8004scan.io/agents/celo/10099 |
| `revoke` | passed | [`0x7f30def9…f692`](https://celoscan.io/tx/0x7f30def994b3bdcd789a8768a484d145a30268191362adb0625f41491391f692) | KeyStore `isValidKey` false; `getKey` reverts `KeyDoesNotExist`; `getKeys()` no longer lists the key; the server stopped the plan; a purchase attempted afterwards was refused; the next tick did not act on the plan |
| `send-out` | passed | XAUt0 [`0x762e5649…eb8e`](https://celoscan.io/tx/0x762e56496c238a2f38a01a16ed47a4db074fe71eee7124df975b4102dabbeb8e), CELO [`0x7c25ca3b…aeb6`](https://celoscan.io/tx/0x7c25ca3b1e9b7252098fc12d82736282ef89759c819984460afffe67a169aeb6), USD₮ [`0x5f9745d8…9a1b`](https://celoscan.io/tx/0x5f9745d82983ef7703c38e2056de3a015df20a96ab593002e19938c6bbc89a1b) | Each transfer's receipt and the destination's balance change: 0.00028 XAUt0, 2.96840826922393049 CELO, 2.363443 USD₮ |

The purchase's receipt, read from forno, also shows `IntentExecuted` for the
wallet with the nonce on the SDK's `0xa17a…` lane and error 0, 339,272 gas
used at 202.5 gwei (0.06870258 CELO, paid by the agent wallet), and a USD₮
`Transfer` of 16,328 from the wallet to `0xaF08…C4bC`. The grant, identity,
revoke and send-out transactions were sent by the relay; `verifyTx` returns
null for each of them.

### Refusals

| Attempt | Error | Autumn's classification |
|---|---|---|
| Over the cap (2.05 USD₮ on a 1.05 USD₮ cap) | the relay could not prepare it: `ExceededSpendLimit` for USD₮ | `cap_exceeded`, nothing bought, plan keeps running |
| Outside the allowlist (`USD₮.transfer` to the wallet itself, amount 0) | the relay could not prepare it: `UnauthorizedCall` | `call_not_permitted`, nothing bought |
| Purchase after the revoke | Autumn's own check before preparing: the key is no longer on the wallet | `session_ended`, nothing bought, plan stopped |

### Fees observed

| What | Paid |
|---|---|
| KeyStore registration, first grant (two keys) | 18.52159173077606951 CELO, after the refund |
| Relay fee, grant | 0.03074 USD₮ (quoted 0.066602) |
| Altana's fee, purchase | 0.016328 USD₮, the prepared maximum |
| Gas, purchase (paid by the agent wallet) | 0.06870258 CELO (339,272 gas) |
| Relay fee, revoke | 0.004852 USD₮ |
| Relay fee, send-out transfers | 0.004125 USD₮ (XAUt0), 0.003676 USD₮ (CELO), 0.003693 USD₮ (USD₮) |

The identity registration's cost is not in the report.

## Agent wallet

Autumn's agent wallet,
[`0x0b5B7ec235F2291396c63F4afc96599B4F70a9Dd`](https://celoscan.io/address/0x0b5B7ec235F2291396c63F4afc96599B4F70a9Dd),
is the address registered with the hackathon entry and the sender of
purchases under `direct-prepared`. It registered its own ERC-8004 identity,
agent id 10098, in
[`0x66a0295d…182b`](https://celoscan.io/tx/0x66a0295db77343c5f0b05f50609f5014df5501802e71640f8230f3d127c2182b)
(block 83,459,280), https://8004scan.io/agents/celo/10098. The registry
(`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) reports it as the owner of
10098, and `tokenURI(10098)` holds the record name "Autumn", the description
"Buys a little Tether Gold (XAUt0) on a schedule for the owners of Altana
wallets, within the limits each owner wrote onchain." and the service
`https://autumn-gold.onrender.com` (read 22 Nov 2026).

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
from the wallet itself. The wallet registered its ERC-8004
identity with the passkey: agent id 10097,
[`0x446c0bd4…aabe`](https://celoscan.io/tx/0x446c0bd4f4bb5cb2ee5b50141e3a1a2a1864b4d55fd70bff736f865c0d15aabe)
(block 83,455,994), https://8004scan.io/agents/celo/10097.

## Passkey wallets through the app, 22 Nov 2026

Two wallets were created in the live app itself, in a browser, with a
WebAuthn passkey as their only admin key, and taken through the whole user
journey with purchases sent by the agent wallet. The passkey was held by the
browser's virtual authenticator (Chrome DevTools WebAuthn), not by a phone,
so these runs prove the app's screens and the passkey-signed transactions,
not a device's fingerprint prompt.

| Wallet | Plan | Purchase | What else was done |
|---|---|---|---|
| [`0xF4d28071177d6104aE8781034d23dc7A5Fd80b39`](https://celoscan.io/address/0xF4d28071177d6104aE8781034d23dc7A5Fd80b39) | 1 USD₮ per day | [`0x03529d95…0945`](https://celoscan.io/tx/0x03529d95e0f2aac7f74a8b8a104352fc46b9e333a6f2cd8d13abf0f603d00945) | ERC-8004 identity 10100 registered at the second passkey prompt; agent stopped from the app (revoke); XAUt0, CELO and USD₮ sent out with "Send out" |
| [`0x91aC42021e9F8cd5d4e397825f31fD961e7DF947`](https://celoscan.io/address/0x91aC42021e9F8cd5d4e397825f31fD961e7DF947) | 1 USD₮ per day | [`0xf21ead96…2a38`](https://celoscan.io/tx/0xf21ead966fc6c16e3d21e0cdcbc18309b9289ffad90473f1b24dcbae438a2a38) | Over-cap probe refused (`cap_exceeded`, nothing sent); agent stopped from the app (revoke); probe after the revoke refused; XAUt0, CELO and USD₮ sent out. This run is the one recorded for the demo video |

Both are team test wallets and are listed as such in
[usage.md](usage.md).
