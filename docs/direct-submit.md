# Direct submission of the Altana intent

Status: implemented and proven on a local fork of Celo mainnet; off by
default (`AUTUMN_SUBMITTER=relay`); not used by the live deployment.

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
layouts. We do not reuse the relay's `wallet_prepareCalls` output. The
prepared intent is not bound to the relay on-chain, but:

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
2. **Who gets credited: not confirmed.**
   - `from` is the agent EOA and `to` is the Orchestrator.
   - `verifyTx` returns codes only, with no sender, for tail tags.
   - Whether Celo's dashboard credits the project for a transaction whose
     outer sender is the agent EOA (not the user's wallet) is not confirmed.
     Ask Celo before counting on it.
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
