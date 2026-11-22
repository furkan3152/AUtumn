# Direct submission of the Altana intent

Status: implemented and proven on a local fork of Celo mainnet; off by
default (`AUTUMN_SUBMITTER=relay`); not used by the live deployment. Two
variants: `direct` builds the intent locally with no fee (sections 1–4);
`direct-prepared` lets Altana's relay prepare and price the intent as today
and only submits it from our EOA (section 5).

Date: 2026-11-21. Status: **works on a local fork of Celo mainnet.** The direct
submitter has sent no mainnet transaction and used no real funds. Every
transaction hash below exists only on a local anvil fork.

## Why

Celo's checker (`@celo/attribution-tags` 0.5.0, `verifyTx`, `sdk/src/index.ts`
lines 224–246) reads a tag only from the end of the outer `tx.input`. The only
wrapper it decodes is ERC-4337 `handleOps`. Altana relay transactions call
`Orchestrator.execute(bytes)` (`0x09c5eabe`), so a tag inside a call's data
ends up in the middle of the calldata, and `verifyTx` returns null
(docs/altana-spike/RESULTS.md section 7).

Direct submission: the agent's own EOA sends `execute(abi.encode(intent))` and appends
`toDataSuffix("celo_c24c5a65e5a3")` as the last 35 bytes. The session key
signs the intent exactly as it does on the relay path.

## 1. Can a third party submit a session-key-signed intent? Yes

Sources: the verified Orchestrator `0xAF140d04…f09751` ("Orchestrator" 0.5.5)
and IthacaAccount `0x4B5d20CD…c9fA79` (0.5.10), both from Sourcify chain
42220. The relay's `wallet_getCapabilities` for `0xa4ec` lists the same two
addresses, plus the account proxy `0xc0F16888…f26fA3`. Live wallets have code
`0xef0100 ‖ proxy`. Line numbers below refer to those files.

**Nothing in the execution path needs the relay.**

- `execute(bytes)` has no caller check (Orchestrator.sol 197–205).
- `checkAndIncrementNonce` and `pay` require `msg.sender == ORCHESTRATOR`, not
  a particular filler (IthacaAccount.sol 600–605 and 631–638).
- There is no filler allowlist, no relay signature and no quote check.
  - The relay's `quoteSigner` (`0xc4f4…1b7f`, from its `health` method) signs
    off-chain quotes only. Neither contract refers to it.
- `funder`/`funderSignature` and the settler are used only for multichain
  intents (`_fund` returns early, 630–632).
- No pre-call is needed for a session intent.
- The **KeyStore is not consulted during execution.** Neither verified source
  mentions it. Key validity is the account's own storage:
  - `unwrapAndValidateSignature` → `getKey(keyHash)` reverts `KeyDoesNotExist`
    once the key is revoked (IthacaAccount.sol 388–399 and 496–523);
  - the expiry check is at line 523;
  - the allowlist and caps are in GuardedExecutor.sol 226–359.

**What the intent contains** (ICommon.sol 11–83):

- Signed fields (EIP-712, lines 13–54): `eoa`, `executionData`
  (`abi.encode(Call[])`), `nonce`, `payer`, `paymentToken`,
  `paymentMaxAmount`, `combinedGas`, `encodedPreCalls`,
  `encodedFundTransfers`, `settler`, `expiry`.
- Unsigned fields (lines 55–82): `isMultichain`, `funder`, `funderSignature`,
  `settlerContext`, `paymentAmount`, `paymentRecipient`, `signature`,
  `paymentSignature`, `supportedAccountImplementation`.

**What the session key signs:**

- The digest is `_computeDigest(Intent)` (Orchestrator.sol 764–784), using
  `INTENT_TYPEHASH` (line 113):
  `Intent(bool multichain,address eoa,Call[] calls,uint256 nonce,address payer,address paymentToken,uint256 paymentMaxAmount,uint256 combinedGas,bytes[] encodedPreCalls,bytes[] encodedFundTransfers,address settler,uint256 expiry)Call(address to,uint256 value,bytes data)`.
- The EIP-712 domain is ("Orchestrator", "0.5.5", 42220, the Orchestrator).
  Read on-chain with `eip712Domain()`.
- The signature is `innerSig(65) ‖ keyHash(32) ‖ prehash(1)`
  (IthacaAccount.sol 496–518). A bare 65-byte signature would be checked
  against the EOA root key.
- `core/test/integration/intent.test.ts` checks all of this against a real
  relay session intent, read-only:
  - it decodes tx `0x37c107db…13db`;
  - re-encodes it byte for byte;
  - recomputes the digest;
  - recovers the address whose key hash the signature carries.

**Nonces, expiry and gas:**

- **Nonce:** 2D. The upper 192 bits are the sequence key; the lower 64 bits
  are the counter (`getNonce(uint192)`, IthacaAccount.sol 368).
  - The prefix `0xc1d0` makes the digest chain-agnostic (line 765). We never
    use it.
  - The SDK signs on lane `0xa17a‖keccak(keyHash)` (sdk `internal/appNonceLane.js` 48–58).
  - We sign on our own lane `0xd1ec‖keccak(keyHash‖"autumn/direct-submit/v1")`,
    so the two paths never race for a nonce. Order matters only within a lane.
- **Expiry:** 0 means it never expires (Orchestrator.sol 437). The real relay
  intents we decoded have `expiry = 0`. We sign `now + 600 s`, below the
  runner's 1,800 s ambiguity hold.
- **combinedGas:** signed. It is the self-call's gas limit (line 379). The
  outer transaction must leave `gasleft·63/64 ≥ combinedGas + 100k`, or it
  reverts `InsufficientGas` (line 331).
  - We measure gas with `simulateExecute`, which reverts
    `SimulationPassed(gUsed)`; it skips the signature check but runs everything
    else (lines 235–261 and 486).
  - We sign `1.5 × gUsed + 50k`.

**Payment:**

- `paymentAmount` and `paymentRecipient` are not signed: "The filler can
  replace this with their own address" (ICommon.sol 67–72). Only
  `paymentAmount ≤ paymentMaxAmount` is enforced (Orchestrator.sol 319).
- We **sign `paymentMaxAmount = 0`** and set `paymentAmount = 0`, so `_pay` is
  skipped (line 499). The wallet pays nobody, and the agent EOA pays the gas.
- A relay-prepared intent signs `paymentMaxAmount > 0`. Paying ourselves out
  of it would be possible (recipient unsigned), but we do not do that.

**Trailing calldata is ignored:**

- `execute(bytes calldata)` reads the argument by offset and length.
- The self-call copies only `encodedIntent` (lines 368 and 379). `_pay`'s
  `calldatasize()` (line 681) therefore runs in the self-call, where the suffix
  does not exist.
- Proven on the fork: the buy below carries 35 trailing bytes and succeeded.

**Failure modes** (all but the last two were observed on the fork):

| Case | What happens | Nonce | Wallet |
|---|---|---|---|
| Signature or key invalid (revoked, expired, wrong key) | The self-call reverts `VerificationError` (lines 483–490). The outer tx succeeds. `IntentExecuted(incremented=false)` | not used | nothing |
| Calls revert after verification (over cap, TWAP `OLD`, price floor) | The self-call returns the revert selector. The account's batch is atomic (lines 510–519) | **used** | nothing (a nonzero payment would still be paid; ours is 0) |
| `combinedGas` too low | Self-call out of gas → `VerifiedCallError` (lines 382–391) | not used | nothing |
| Outer gas too low | Outer revert `InsufficientGas` | not used | nothing |
| Expired intent, or nonce already used | `IntentExpired` / `InvalidNonce` inside the self-call | not used | nothing |
| Someone copies our signed intent and submits it first | It is permissionless: their tx buys, ours gets `InvalidNonce` and only costs gas | used once | one purchase, **untagged** |
| The account is upgraded | `supportedAccountImplementation` (unsigned, set by us) → `UnsupportedAccountImplementation` | not used | nothing |

In every case the outer receipt says `success`, so its status means nothing.
The executor decides from `IntentExecuted(eoa, nonce)` and from GoldBuyer's
`Bought(wallet)`.

**Terms, Keystore and XP: facts only.**

- Terms (altana.network/terms, read 2026-11-21) say: "The protocol is
  permissionless: anyone may interact with the deployed smart contracts
  directly, without using our Services".
  - Direct interaction is "entirely outside any relationship with us".
  - The same section prohibits circumventing "usage limits … of the Services".
- XP (xp.altana.network/rules): "XP is derived only from events emitted by"
  the KeyStore contracts (`KeyRegistered`; the page lists BNB and Ethereum).
  Who submits executions does not enter the computation.
- The docs say relaying is permissionless for KeyStore cache proofs. They say
  nothing about Orchestrator fillers.

## 2. Route and implementation

**Route: build and sign the intent locally**, with viem and the verified
layouts. This variant does not reuse the relay's `wallet_prepareCalls`
output (section 5 is the variant that does). The prepared intent is not
bound to the relay on-chain, but:

1. the relay cannot prepare against fork state, so that route could not be
   proven;
2. its intents sign a nonzero `paymentMaxAmount` to the relay's funder
   `0xaF08…C4bC` and carry `expiry = 0`, so a stored signed copy stays
   submittable forever;
3. the SDK's intent builder is internal (package `exports` is `.` only).

We do reuse:

- the SDK's own signer (`signerFromPrivateKey(...).signDigest`);
- core's `buildBuyCalls`;
- the SDK's key-hash convention.

Files:

- `core/src/intent.ts`: Intent ABI, `encodeIntent`, `intentDigest`,
  `wrapKeySignature`, the direct lane, `executeCalldata` (suffix last), and the
  error-selector names.
- `core/src/errors.ts`: adds `DirectSubmitError`. It carries its own kind and
  `bought`, so the runner never guesses. Relay errors are unaffected.
- `core/src/attribution.ts`: re-exports `verifyTx` and `fromDataSuffix`.
- `agent/src/direct.ts`: `createDirectExecutor`. It implements the same
  `SessionExecutor` port, so the runner's checks, attempt lock, rechecks and
  hold are unchanged. Steps:
  1. key and implementation checks;
  2. `simulateExecute` for gas, with real errors bubbled;
  3. sign;
  4. preflight `eth_call` of the exact transaction (`err` must be 0);
  5. estimate gas and check the agent's CELO;
  6. send, holding the agent EOA's send lock: read its pending nonce, send
     with that nonce, wait (up to 15 s) until the RPC counts it. In
     production the lock is a Postgres advisory lock per EOA
     (`agent/src/sendLock.ts`), so overlapping ticks in different processes
     take turns; without a pool it is an in-process queue;
  7. read the receipt: `CONFIRMED` only when `Bought(wallet)` is in it.

  `quote()` runs the simulation and returns fee 0. Refusals before sending
  report `bought: "no"`. A send error reports `"unknown"`, and a receipt
  timeout reports `PENDING`; the runner then re-reads the chain.
- `agent/src/production.ts`: adds `AUTUMN_SUBMITTER`. Default `relay`;
  `direct` is opt-in. Also used by `cli try-buy`.

Config: `AUTUMN_EXECUTION=live`, `AUTUMN_SUBMITTER=direct`,
`AUTUMN_DIRECT_SUBMITTER_KEY` (the agent EOA's key; it pays gas in CELO), and
optionally `AUTUMN_DIRECT_INTENT_TTL_SECS` (60–1799, default 600).

## 3. Proof on a local fork

Run of 2026-11-21:

- anvil 1.5.1, `--hardfork prague`, fork of forno at block 83,391,933;
- GoldBuyer deployed at `0x1020654DCaA2eB9662E7e27409C4c8f9eD9BF994`;
- wallet `0xF3b5329a5955d4bcBb7646878912E24060120805`, code
  `0xef0100c0f16888f4198f53892c53af859f673e23f26fa3`;
- grant tx `0xeb0d1051…4c7e7c`: 895,957 gas, KeyStore fee 9.208 CELO per key,
  18.416 CELO for two keys.

Session state on the account after the grant:

- active, and KeyStore valid;
- allowlist: USD₮ `approve`, GoldBuyer `buy`, and Orchestrator `0x32323232`
  (the shape of every live Celo session key; see "The Orchestrator entry");
- one USD₮ cap of 1.05 per week, the plan's 1 USD₮ plus its fee allowance.

Run of 2026-11-21 20:48 UTC (fork block 83,393,351), after the verification
fix: core's `sessionLimitsMismatch` accepts this allowlist, and signed
session intents that try to use the Orchestrator entry fail in the
preflight `eth_call` (nothing sent):

| Probe (session key, batch) | `execute` result |
|---|---|
| 1 CELO to the Orchestrator, empty calldata (`receive`) | `NoSpendPermissions` (no CELO limit on the key) |
| 1 CELO with `withdrawTokens(0, attacker, 0)` | `CallError` (not payable; batch reverts) |
| `USD₮.approve(attacker, 2 USD₮)` + `withdrawTokens(USD₮, attacker, 0)` | `ExceededSpendLimit` (the approval counts against the 1.05 cap) |
| `withdrawTokens(USD₮, attacker, 0)` alone | success: the entry works, and moves only the Orchestrator's own balance (zero) |

| Scenario | Fork tx | Gas | Result |
|---|---|---|---|
| 1. Buy 1 USD₮ | `0x323a17e6b8f8b9f19a8f31dd829600582c0da5aa136bef5ff80dbf4e95acb6e3` | 314,126 | from the agent EOA to the Orchestrator; `IntentExecuted(incremented=true, err=0)`; `Bought(1,000,000 → 280)`; wallet −1.000000 USD₮, no fee; cap spent 1,000,000 |
| 2a. Over cap (1 more USD₮) | none | – | refused before sending: `ExceededSpendLimit(USD₮)` in simulation; `cap_exceeded`, `bought: no` |
| 2b. Same, forced on chain (test-only flag) | `0x2e8f9979e6f47164e2483c03249c6a3a00fc88eb096dcf034466b37afd9acab5` | 334,030 | `err=ExceededSpendLimit (0x9054c912)`, nonce **used**, no `Bought`, USD₮ unchanged |
| 3a. After revoke (tx `0x891c0c88…01fa7`, account revoke + KeyStore `revokeKey`) | none | – | refused before sending: `KeyDoesNotExist` → `session_ended`; KeyStore `isValidKey` false |
| 3b. Same, forced | `0x9685ef08246a12a19edfb4b58b5ec16d984adb87a7ec14c9a6d276d559926978` | 61,623 | `err=VerificationError (0xfbcb0b34)`, `incremented=false`, USD₮ unchanged |
| 4. Runner + direct executor (second wallet) | `0x9d1a272c09729f5c02de1774bbc13ef345514601e9bb830984a5ba22e8968acd` | 314,118 | tick 1: `bought`, attempt `bought`; tick 2: `already_bought` with the same hash |
| 4 (20:48 run). Same, on a real-shaped grant (Orchestrator entry included) | `0x70490fe320d84009b3060ffebba47b974062acc317c4a4c6fb5f95c1b503e067` | – | tick 1: `bought`; tick 2: `already_bought`. Control wallet with any-function on GoldBuyer as well: `skipped` / `limits_mismatch` ("lets it call any function of GoldBuyer"), nothing sent |

Attribution on the scenario 1 transaction (input 1,767 bytes; last 35 bytes
`0x63656c6f…8021`):

- `verifyTx({client: fork, hash})` → `{"codes":["celo_c24c5a65e5a3"],"schemaId":0}`
- `fromDataSuffix(tx.input)` → the same.

The scenario 4 transaction gives the same result.

The agent EOA paid 0.01559 CELO for scenarios 1, 2b and 3b together, at the
fork's gas price (about 22 gwei). That is about 0.0069 CELO per buy.

Reproduce. It needs `contracts/out` (`forge build`), anvil, and network access
to forno:

```bash
cd core && npm run build && cd ../agent
DIRECT_FORK_OUT=/tmp/direct-fork.json npx vitest run test/direct-fork.test.ts
# options: ANVIL_BIN, FORK_URL, FORK_BLOCK; the test is skipped when anvil or contracts/out is missing
cd ../core && npx vitest run test/integration/intent.test.ts   # read-only mainnet check of the encoding
```

Hashes and addresses change on each run (fresh keys). The JSON record holds
every value above.

### How the fork differs from a real wallet

- **The admin key is secp256k1, not a WebAuthn passkey.** We also hold the
  EOA's key; the real flow discards it.
  - The admin key was authorised by the EOA's own type-4 transaction. The
    relay does this with an upgrade pre-call.
- **The grant is our own admin intent through the real Orchestrator, not
  `grantSession`.** We wrote its calls to reproduce the state seen on four live
  mainnet session keys, including the Orchestrator any-selector entry:
  - KeyStoreController `initialRegisterKey` (admin) and `registerKey`
    (session), paying the real fee plus 10%;
  - `authorize`, 3× `setCanExecute` (`grant.onchainCalls`) and `setSpendLimit`.

  The relay's exact call order and encoding are not reproduced.
- **USD₮ came from a storage write** (balance mapping slot 51). The wallet got
  100 CELO.
- **Time:** one jump of 31 minutes before GoldBuyer was deployed, then
  1-second blocks. At the fork block the pool kept a single oracle
  observation, so GoldBuyer reverted `OLD` for 30 minutes after any swap.
  Mainnet behaved the same way until 22 Nov 2026, when the pool's capacity
  was raised to 1,800 observations ([README, "Deployed on Celo mainnet"](../README.md#deployed-on-celo-mainnet)).
- **Not exercised:** GoldBuyer on mainnet, the passkey, the relay, ERC-8004,
  and the real gas market.

## 4. Findings, risks and unknowns for a mainnet run

1. **Fixed: the real grant made the runner refuse.** Porto adds
   `{to: Orchestrator, selector: 0x32323232}` to every session key, and
   `sessionLimitsMismatch` required exactly {approve, buy}. Verification now
   expects exactly {USD₮.approve, GoldBuyer.buy, pinned Orchestrator
   any-selector} (`expectedOnchainAllowlist`, core/src/grant.ts) in the
   browser, at server activation and in the runner. See "The Orchestrator
   entry" below for why that entry is safe.
2. **Who gets credited: the tag and the sender.**
   - `from` is the agent EOA and `to` is the Orchestrator.
   - `verifyTx` returns codes only, with no sender, for tail tags.
   - Celo counts a transaction when the tag ends the outer calldata and the
     sender is the project's registered agent wallet. Other teams are
     credited for exactly this shape with a sender other than the intent's
     wallet (section 5, `0xaaab…9bfc`, `0x6272…30c5`). The agent EOA must
     therefore be the address registered with Celo.
3. **Someone else can submit our signed intent without the tag.** The intent
   is permissionless: anyone who sees it (in the mempool, or from an RPC
   provider) can submit it first. The purchase still happens exactly once,
   because the intent's nonce can be used once; our own transaction then gets
   `InvalidNonce` and costs only gas. Only the tag is lost. Whether Celo's
   mempool is public was not checked.
4. **Fixed: one EOA, several processes.** Sends from the agent EOA now hold
   a Postgres advisory lock per EOA (`pg_advisory_xact_lock`, transaction
   level so it works through Neon's pooled URL) around nonce read, send and
   a short wait for the RPC to count the transaction. A lock that cannot be
   taken within 60 s refuses the purchase before sending (`bought: "no"`).
   Tested against a real Postgres with two pools
   (`agent/test/sendLock.test.ts`). If the RPC never shows the transaction
   within 15 s the lock is released anyway; the worst case is then the old
   one (a nonce clash, which the runner reports as `ambiguous` and settles
   from the chain).
5. **Costs:** the agent EOA needs CELO (about 314k gas per buy). The wallet's
   cap no longer pays a relay fee.
6. **Not tried here:** IthacaAccount also accepts a direct ERC-7821
   `execute(mode, abi.encode(calls, nonce ‖ wrappedSig))` from any sender,
   signed over `computeDigest(calls, nonce)` (IthacaAccount.sol 706–720, the
   "Execute" typehash at line 187). With it, the outer `to` would be the
   user's wallet itself, also with the tag at the end.

## 5. Relay-prepared, self-submitted (`direct-prepared`)

Date: 2026-11-22. Status: **implemented, unit-tested, and proven on a local
fork with only the relay faked.** No mainnet transaction has been sent with
it. Off by default; opt in with `AUTUMN_SUBMITTER=direct-prepared`.

Altana's relay prepares and prices the intent exactly as it does for the SDK.
The session key signs it as the SDK would. The wallet still pays Altana's fee
inside the session cap. The only change: our agent EOA sends
`Orchestrator.execute(bytes)` with the tag as the last 35 bytes, instead of
handing the signature to the relay. `wallet_sendPreparedCalls` is never
called.

### Evidence from mainnet (read-only, 2026-11-22)

Decoded with `INTENT_ABI_PARAMETER` (core/src/intent.ts). The intents are in
`core/test/fixtures/relay-prepared-intents.json`.

| Field | Ours, relay-sent `0xe6f4…c785` | Credited, wallet sends `0xd540…7754` | Credited, wallet sends `0xa390…f96a` | Credited, other EOA sends `0xaaab…9bfc` | Credited, other EOA sends `0x6272…30c5` |
|---|---|---|---|---|---|
| tx.from | relay `0x5318…2faa` | `0xB244…4431` (= eoa) | `0xB244…4431` (= eoa) | `0x1bce…8ce8` | `0x9fb5…dc79` |
| eoa | `0xA177…683C` | `0xB244…4431` | `0xB244…4431` | `0x0Eca…D4B1` | `0x0Eca…D4B1` |
| nonce | `0xa17a…` lane, counter 0 | `0xa17a…`, 1 | `0xa17a…`, 3 | `0xa17a…`, 0 | `0xa17a…`, 0 |
| payer | 0 (the wallet) | 0 | 0 | 0 | 0 |
| paymentToken | USD₮ | USD₮ | USD₮ | 0 (CELO) | 0 (CELO) |
| paymentAmount / paymentMaxAmount | 9,740 / 19,648 | 19,557 / 19,557 | 8,225 / 8,225 | 0.6672 / 0.6672 CELO | 0.3176 / 0.3176 CELO |
| paymentRecipient | `0xaF08…C4bC` | `0xaF08…C4bC` | `0xaF08…C4bC` | `0xaF08…C4bC` | `0xaF08…C4bC` |
| expiry | 0 | 0 | 0 | 0 | 0 |
| combinedGas | 452,201 | 498,639 | 128,598 | 1,084,972 | 429,573 |
| supportedAccountImplementation | `0x4B5d…fA79` | same | same | same | same |
| funder / funderSignature, settler / settlerContext, encodedPreCalls, encodedFundTransfers, isMultichain, paymentSignature | all empty or zero | same | same | same | same |
| signature | 98 bytes: inner ‖ session keyHash ‖ `0x00` | 98 bytes, key | 65 bytes, EOA root key | 98 bytes, non-admin key (expiry set) | 98 bytes, key |
| inner call tags | ours on both calls | theirs on all 4 | theirs | none | none |
| outer calldata tail | ABI padding | `celo_d6a0b77183c8` (35 bytes) | same | `celo_3f5cac8c49f6` | same |
| `verifyTx` | null | their code | their code | their code | their code |

- The intents of the credited teams are relay-prepared: every key-signed one
  is on the SDK's lane of the key that signed it (`0xa17a ‖ keccak(keyHash)`,
  checked in `core/test/unit/prepared.test.ts`), pays `0xaF08…C4bC` and has
  `expiry = 0`.
- Only the relay lowers `paymentAmount` when it sends: 9,740 of 19,648 and
  7,549 of 16,356 on our two purchases. Self-submitters pay
  `paymentAmount = paymentMaxAmount`, which is what the prepared answer holds.
- **The fee was paid.** Receipts show USD₮ `Transfer(wallet → 0xaF08…C4bC)` of
  exactly `paymentAmount` (19,557; 8,225). For the CELO fees, the recipient's
  balance grew by exactly `paymentAmount` in each block (0.667229954848972819
  and 0.317550833252863516 CELO), and no other transaction in those blocks was
  sent to it or to the Orchestrator.
- `0xd540…` and `0xa390…` are cip64 transactions: the wallet itself paid the
  gas in USD₮, on top of Altana's fee.
- **Sourcify sources** (Orchestrator 0.5.5, IthacaAccount 0.5.10):
  - `execute(bytes)` has no `msg.sender` or `tx.origin` check
    (Orchestrator.sol 197–205). `tx.origin` appears only in `simulateExecute`
    (252) and in the paymaster branch of `IthacaAccount.pay` (656).
  - The fee goes to `paymentRecipient`, never to `msg.sender`: `_pay`
    (Orchestrator.sol 660–706) calls `IthacaAccount.pay`, which transfers to
    `intent.paymentRecipient` (IthacaAccount.sol 665).
  - The fee is charged to the signing key's spend limit in `paymentToken`
    (`_incrementSpent`, IthacaAccount.sol 666–670). In USD₮ it counts against
    the plan's cap. In CELO it would revert `NoSpendPermissions` (our keys
    have no native limit), so a CELO-fee intent can never work for Autumn.

**Answer.** A relay-prepared, session-signed intent can be submitted by any
EOA. That EOA pays only the gas, in CELO. The wallet pays the fee to whatever
`paymentRecipient` the submitted bytes name, up to the signed
`paymentMaxAmount` and within the key's cap. The submitter chooses the
recipient and the amount, because both fields are unsigned.

**Who gets paid, who pays gas:**

| Mode | Outer sender | Gas paid by | Wallet pays | Altana receives | Tag at end of outer calldata |
|---|---|---|---|---|---|
| `relay` (default) | relay EOA | Altana's relay | relay fee, lowered at send (9,740 and 7,549 USD₮ base units so far) | that fee | no |
| `direct` | agent EOA | agent EOA, CELO (313k gas on the fork) | nothing (`paymentMaxAmount = 0` is signed) | nothing | yes |
| `direct-prepared` | agent EOA | agent EOA, CELO (340k gas on the fork) | the prepared `paymentAmount`, which equals the maximum (19,648 for our last purchase) | that amount, to `0xaF08…C4bC` | yes |

### The relay's prepared answer

`@altananetwork/sdk` 1.1.0 runs `execute` as `prepareIntent` →
`porto/viem/RelayActions.prepareCalls` (`wallet_prepareCalls`) →
`signCalls` (session key, payload `prepared.digest`, unwrapped) →
`sendPreparedCalls` (`wallet_sendPreparedCalls`). The relay wraps the
signature as `inner ‖ keyHash ‖ 0x00` (`dist/internal/relay.js` 272–306 and
702–803; porto `RelayActions.ts` 186–302 and 618–644). The SDK's intent
builder is internal, so the executor sends the same request itself
(`prepareCallsParams`, core/src/prepared.ts):

- `from`: the wallet;
- the calls, each still tagged;
- `capabilities.meta`: `feeToken` USD₮ and the SDK lane nonce;
- `key`: `{type: secp256k1, publicKey: pad32(session key address), prehash: false}`.

A read-only `wallet_prepareCalls` for our wallet `0xA177…683C` returned the
complete 20-field `ICommon.Intent` in `context.quote.quotes[0].intent`. This
call used the admin key, because the wallet holds no session key any more.
`signature` was `0x`, `paymentAmount = paymentMaxAmount` (8,784), expiry 0
and the recipient `0xaF08…C4bC`. `wallet_getCapabilities` gives
`fees.recipient` = `contracts.funder` = `0xaF08…C4bC`, a quote TTL of 30 s
(off-chain only) and an `intentBuffer` of 50,000 gas.

Our EIP-712 digest of that intent equals the hash of the relay's own
`typedData`, but **not** the relay's `digest` field. That field matched none
of the variants we tried (no chain id, multichain, sha256, EIP-191,
ERC-1271 replay-safe, other nonces). Executed relay intents, ours included,
verify against the EIP-712 digest. The executor therefore signs only the
digest it computes from the checked fields, and logs when the relay's digest
differs.

### Implementation

- `core/src/prepared.ts`:
  - `prepareCallsParams`;
  - `parsePreparedCalls`: exactly one single-chain quote, exactly the 20 fields
    of Orchestrator 0.5.5, no pre-call;
  - `checkPreparedIntent`: every field against what we asked for. It refuses
    unless all of these hold:
    - eoa = the wallet;
    - `executionData` = exactly our tagged calls;
    - nonce = the one we asked for, on the SDK lane of the key;
    - payer 0, token USD₮, recipient `ALTANA_FEE_RECIPIENT`;
    - `paymentAmount ≤ paymentMaxAmount ≤` the allowance;
    - `0 < combinedGas ≤ 2,000,000`;
    - expiry 0 or at least 60 s ahead;
    - no signature, payment signature, pre-calls, fund transfers, funder or
      settler, and not multichain;
    - `supportedAccountImplementation` = the pinned implementation;
    - the quote's Orchestrator and chain are the pinned ones.
  - `RELAY_READ_ONLY_METHODS`.
- `core/src/constants.ts`: `ALTANA_FEE_RECIPIENT`.
- `agent/src/intentSubmit.ts`: what both EOA submitters share, moved out of
  `direct.ts` unchanged: the session-key checks, revert decoding, the locked
  broadcast and the receipt outcome.
- `agent/src/directPrepared.ts`: `createDirectPreparedExecutor`. The relay
  client refuses any method but `wallet_prepareCalls` and
  `wallet_getCapabilities`. Steps:
  1. the same key and implementation checks as `direct`;
  2. `getNonce` on the SDK lane;
  3. `wallet_prepareCalls`;
  4. field checks;
  5. local digest;
  6. sign and wrap;
  7. `executeCalldata` with the tag last, checked with `fromDataSuffix`;
  8. preflight `eth_call` of the exact bytes;
  9. gas, CELO balance, and the send under the agent EOA's send lock;
  10. `CONFIRMED` only with `Bought(wallet)` in the receipt.

  `quote()` runs steps 1–4 without the fee bound and returns the relay's
  `paymentMaxAmount`, so the runner's `relayFeeVerdict` decides as before.
  `execute` signs the intent `quote()` prepared (same wallet, key and calls,
  under 60 s old, nonce unchanged). Otherwise (the `try-buy` probe) it
  prepares again and holds the fee to `DEFAULT_FEE_ALLOWANCE_PER_BUY`. Every
  refusal before sending is a `DirectSubmitError` with `bought: "no"`.
- `agent/src/production.ts`: `AUTUMN_SUBMITTER=direct-prepared` with
  `AUTUMN_DIRECT_SUBMITTER_KEY`. `relay` stays the default; `direct` is
  unchanged.

Tests:

- `core/test/unit/prepared.test.ts`: the real relay answer and the real
  mainnet intents, plus 25 tampered fields.
- `core/test/unit/attribution.test.ts`: Celo's `verifyTx` on our builder's
  calldata and on the four credited transactions. Our relay-sent `0xe6f4…`
  bytes followed by the tag are exactly what `direct-prepared` sends for that
  intent.
- `agent/test/directPrepared.test.ts`: a fake node and relay, and the runner
  end to end (buys once; `fee_too_high` with nothing signed).
- Scenario 5 of `agent/test/direct-fork.test.ts`. Run of 2026-11-22: fork of
  block 83,458,663, tx `0x1dfc…4b4f` (fork only), 339,678 gas.
  - Sent from the agent EOA. `IntentExecuted(incremented, err 0)` and
    `Bought(1,000,000 → 280)`.
  - The wallet paid 1,019,648 and Altana's recipient received 19,648. The cap
    spent is 1,019,648, so the fee is inside the cap.
  - The SDK-lane counter went from 0 to 1, and `verifyTx` returns
    `celo_c24c5a65e5a3`.
  - A 40,000 fee that the cap cannot hold is refused in the preflight
    (`ExceededSpendLimit`, nothing sent), even with the executor's own
    ceiling raised.
  - **The relay is faked in this scenario.** The relay prepares only against
    mainnet state. The fake builds its answer from the envelope of the real
    answer, with the relay's field values and `combinedGas` = `simulateExecute`
    gas + 50,000.

### Risks and how the code handles them

1. **Someone copies the signed intent from the mempool and sends it first,
   without the tag.** The purchase still happens once, because the nonce is
   used once. Our transaction then fails the preflight, or lands with
   `InvalidNonce`. Only the tag is lost. Unlike `direct`, the copier can also
   rewrite the unsigned `paymentRecipient` and `paymentAmount` and take up to
   `paymentMaxAmount`. The wallet pays the same and Altana loses its fee. This
   is bounded by the allowance and the cap. Whether Celo's mempool is public
   was not checked.
2. **Expiry 0.** A signed intent stays valid until its nonce is used, as on
   the relay path, where every intent also has expiry 0.
   - The executor keeps this, because changing a signed field would no longer
     be the relay's intent.
   - The signature exists only in our transaction. The relay never receives
     it.
   - The lane is sequential. The next intent of this key that lands on the
     lane, in any mode but `direct`, kills a stale one at the same counter.
     At most one of them can ever execute.
   - The quote cache is used only while the on-chain counter is unchanged.
   - What remains: a broadcast that is dropped and then replayed by someone
     who kept it, while no later purchase has used the counter. It is one
     purchase, still bounded by `minOut`, GoldBuyer's TWAP floor and the cap
     of the period it lands in. If that happens after the runner's 1,800 s
     hold, the runner's retry has the same nonce, so it is refused in the
     preflight, and the late purchase is found by the chain scan.
3. **Nonce races with the relay.** The executor uses the SDK's lane, like
   relay mode, and the relay's own background work uses lane 0. Two modes on
   one key at once (two deployments) cannot both land: the second gets
   `InvalidNonce`.
4. **The relay answers something else.** The executor refuses it field by
   field (`bought: "no"`) and signs only its own digest. If the relay moves to
   another Orchestrator, account implementation or fee recipient, the
   executor refuses until the pins are updated.
5. **Fee level.** The wallet pays the prepared `paymentAmount`, which equals
   `paymentMaxAmount` (about twice what the relay charges when it sends
   itself). Altana receives more than in relay mode while paying no gas. The
   agent EOA pays about 340k gas in CELO. This is a decision to make, not a
   bug. Lowering the unsigned amount is possible but would no longer be
   "exactly as the relay prepared".
6. **The relay is down.** Nothing is prepared, so there is no purchase, as in
   relay mode.
7. **Terms.** Altana's terms say that anyone may use the contracts directly.
   The same section prohibits circumventing "usage limits … of the Services".
   This mode uses the Services only to prepare, and pays the fee.

### What the first funded mainnet attempt must check

1. The agent EOA is the address registered with Celo for the project, and
   holds CELO (about 340k gas per purchase).
2. Set `AUTUMN_SUBMITTER=direct-prepared`, `AUTUMN_DIRECT_SUBMITTER_KEY` and
   `AUTUMN_EXECUTION=live`.
3. Before sending, run `quote()` once with a real active session key. The
   session-key `wallet_prepareCalls` request has never been made by this code
   against the real relay (it reproduces the SDK's request), so confirm that
   the relay accepts it.
4. The log has no `direct-prepared digest differs from the relay's` line for
   that session key. If it does, find out why before relying on the mode.
5. The receipt shows:
   - `from` the agent EOA and `to` the Orchestrator;
   - `IntentExecuted(eoa, nonce, true, 0x00000000)` with the nonce on the
     `0xa17a…` lane;
   - `Bought(wallet)`;
   - a USD₮ `Transfer(wallet → 0xaF08…C4bC)` of exactly `paymentAmount`;
   - the cap spent equal to amount plus fee.
6. `verifyTx(hash)` returns `celo_c24c5a65e5a3`, and Celo's dashboard counts
   the transaction.
7. Gas used and the CELO cost, compared with the fork's 339,678 gas.

### Which mode for the hackathon

**`direct-prepared`**, once item 3 above works on mainnet:

- Celo's requirement holds: tag last, sent by our agent EOA. It is the same
  shape as the credited `0xaaab…` and `0x6272…`.
- Altana's flow holds:
  - the Altana wallet, the session key and its cap and allowlist;
  - the relay prepares and prices each purchase;
  - Altana's fee is paid from the wallet inside the cap;
  - the SDK's nonce lane.
- `direct` leaves Altana's relay out entirely and pays Altana nothing.

`direct` is cheaper for the user (no fee) and works when the relay is down.
It stays the fallback, but it is not the one to show for the Altana track.

## The Orchestrator entry

Every Altana session key on Celo carries a fourth kind of allowlist entry
that we never asked for: the Orchestrator with "any function".

### Facts

- **What is added.** `Key.toRelay` in porto 0.2.37 (the version
  `@altananetwork/sdk` 1.1.0 pins) appends
  `{type: "call", to: orchestrator, selector: Call.anySelector}` to every key
  with `role === "session"` (`porto/src/viem/Key.ts` lines 1110–1115).
  `Call.anySelector` is `0x32323232` (`src/core/internal/call.ts`), the same
  value as GuardedExecutor's `ANY_FN_SEL` (GuardedExecutor.sol line 135).
  The account stores it as the packed word
  `0xaf140d0416a994aebb3fa6212b16ce6700f09751000000000000000032323232`.
- **Which address.** `orchestrator` is `contracts.orchestrator.address` from
  the relay's `wallet_getCapabilities` (`RelayActions.ts` lines 211–223 and
  376–391). For `0xa4ec` the relay returns
  `0xAF140d0416A994Aebb3fA6212B16CE6700f09751` (v0.5.5) and an empty
  `legacyOrchestrators` (read 2026-11-21). It is also the immutable
  `ORCHESTRATOR()` of the account implementation (IthacaAccount.sol line
  226; checked read-only in `core/test/integration/intent.test.ts`). A relay
  that moved to a new Orchestrator would change this address, and our check
  would then refuse the new keys until the pin is updated.
- **Live keys.** All four session keys found on Celo mainnet (three wallets,
  found from `IntentExecuted` logs, block 83,392,655) carry exactly this word,
  the same address on every wallet. Their raw `canExecutePackedInfos` and
  `spendInfos` are in `core/test/fixtures/mainnet-session-allowlists.json`.
- **Why Porto adds it.** The code says only "temporary": it was introduced
  as `// TODO(relay): remove temporary call scope on EntryPoint.` (porto
  commit 793f4e7, 2025-03-27; renamed to Orchestrator in ca969a4,
  2025-05-21). Nothing in the current execution path needs it: the
  Orchestrator calls the account (`execute`, `pay`), never the other way
  round. We cannot remove it without changing the SDK, so we accept it.

### What a session-key holder can do with it

The entry lets the wallet itself (msg.sender = the wallet) call any function
of the Orchestrator inside a session batch. The verified Orchestrator 0.5.5
reads `msg.sender` in one place only (line 426) and never pulls tokens from
its caller. Its external functions:

| Function (Orchestrator.sol) | Called as the wallet |
|---|---|
| `withdrawTokens(token, recipient, amount)` (154) | Anyone may already call it. It sends the Orchestrator's own balance, not the wallet's. With a `token` the attacker controls, it calls that contract, which then runs in the middle of the batch (see approvals below). |
| `executePreCalls(parentEOA, preCalls)` (160) | Anyone may already call it. Each pre-call needs a valid signature of a key of its `eoa` (166). One signed by the session key runs under that key's own guards again. |
| `execute(bytes)` / `execute(bytes[])` (197, 210) | `nonReentrant`, and the guard is on for every chain (`_useTransientReentrancyGuardOnlyOnMainnet` returns false, 844–852). Inside a relayed or direct intent it reverts. Outside one (a session batch sent through the account's own ERC-7821 path), it runs another intent, which anyone could submit anyway; that intent's calls and payment are again checked against the signing key's guards. |
| `simulateExecute(...)` (235) | Always reverts, unless `tx.origin` holds at least 2^192 wei of CELO, which is impossible on chain. |
| `selfCallPayVerifyCall537021665()` (425) | `require(msg.sender == address(this))`: reverts. |
| `receive()` (821) | Payable, empty calldata: allowed by the any-selector entry. See native value below. |

What bounds every one of these:

- **Native CELO.** Every call value in a session batch is summed (GuardedExecutor.sol line 254) and charged to the key's native limit after the batch (311). Our keys have no native limit, so any value reverts `NoSpendPermissions` (644). A relay or nested intent paying its fee in CELO is charged the same way (IthacaAccount.sol 669). Verification refuses a key with a native (or any non-USD₮) limit. Fork probe: 1 CELO to the Orchestrator reverts `NoSpendPermissions`.
- **The wallet's tokens.** The Orchestrator has no path that moves the caller's tokens. A contract that gains control mid-batch (via `withdrawTokens`) can pull only what the wallet has approved to it. The only approval the key can make is `USD₮.approve`, whose amount is charged to the USD₮ cap (GuardedExecutor.sol 275–281, and with the balance drop, 331–344) and reset to zero after the batch (318). Fork probe: approving an attacker for 2 USD₮ next to an Orchestrator call reverts `ExceededSpendLimit` against the 1.05 cap. XAUt0 and other tokens have no cap, so the key cannot approve or transfer them, and the Orchestrator never pulls them.
- **Account authority.** The account trusts the Orchestrator only for intents and pre-calls whose signature it verified, with that signer's key hash (IthacaAccount.sol 633 and 687). Calling the Orchestrator gives the session key no other key's authority.

**Conclusion: the entry is safe for Autumn.** A stolen session key cannot use
it to move the owner's funds beyond the cap, or anywhere it could not already
send them. It does add one route to the loss we already state: with a
same-batch USD₮ approval and a contract of its own called back through
`withdrawTokens`, a thief can take USD₮ up to the cap's remaining room. The
relay fee field already allowed exactly that amount
([architecture.md, "The cap and the fee allowance"](architecture.md#the-cap-and-the-fee-allowance)),
so the bound is unchanged: the cap, not the allowlist.

The check therefore accepts exactly {USD₮.approve, GoldBuyer.buy, pinned
Orchestrator any-selector}. It refuses a missing or duplicated entry, any
other extra entry, a wildcard target (`0x3232…3232`), and the any-selector on
any other address (core/test/unit/verify.test.ts; runner and fork tests).

Not checked by us, as before this change: `callCheckerInfos` (a call checker
would widen a key without appearing in the allowlist) and entries stored
under `ANY_KEYHASH` for all keys. Only the passkey admin can set either.
