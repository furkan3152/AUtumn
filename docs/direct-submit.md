# Plan B: submit the Altana intent ourselves, with the ERC-8021 tag at the end

Date: 2026-11-21. Status: **works on a local fork of Celo mainnet.** No mainnet
transaction was sent and no real funds were used. Every transaction hash below
exists only on a local anvil fork.

## Why

Celo's checker (`@celo/attribution-tags` 0.5.0, `verifyTx`, `sdk/src/index.ts`
lines 224–246) reads a tag only from the end of the outer `tx.input`. The only
wrapper it decodes is ERC-4337 `handleOps`. Altana relay transactions call
`Orchestrator.execute(bytes)` (`0x09c5eabe`), so a tag inside a call's data
ends up in the middle of the calldata, and `verifyTx` returns null
(docs/altana-spike/RESULTS.md section 7).

Plan B: the agent's own EOA sends `execute(abi.encode(intent))` and appends
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
  6. send (one at a time per process);
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
- allowlist: USD₮ `approve`, GoldBuyer `buy`, and Orchestrator `0x32323232`;
- one USD₮ cap of 1.05 per week, the plan's 1 USD₮ plus its fee allowance.

| Scenario | Fork tx | Gas | Result |
|---|---|---|---|
| 1. Buy 1 USD₮ | `0x323a17e6b8f8b9f19a8f31dd829600582c0da5aa136bef5ff80dbf4e95acb6e3` | 314,126 | from the agent EOA to the Orchestrator; `IntentExecuted(incremented=true, err=0)`; `Bought(1,000,000 → 280)`; wallet −1.000000 USD₮, no fee; cap spent 1,000,000 |
| 2a. Over cap (1 more USD₮) | none | – | refused before sending: `ExceededSpendLimit(USD₮)` in simulation; `cap_exceeded`, `bought: no` |
| 2b. Same, forced on chain (test-only flag) | `0x2e8f9979e6f47164e2483c03249c6a3a00fc88eb096dcf034466b37afd9acab5` | 334,030 | `err=ExceededSpendLimit (0x9054c912)`, nonce **used**, no `Bought`, USD₮ unchanged |
| 3a. After revoke (tx `0x891c0c88…01fa7`, account revoke + KeyStore `revokeKey`) | none | – | refused before sending: `KeyDoesNotExist` → `session_ended`; KeyStore `isValidKey` false |
| 3b. Same, forced | `0x9685ef08246a12a19edfb4b58b5ec16d984adb87a7ec14c9a6d276d559926978` | 61,623 | `err=VerificationError (0xfbcb0b34)`, `incremented=false`, USD₮ unchanged |
| 4. Runner + direct executor (second wallet) | `0x9d1a272c09729f5c02de1774bbc13ef345514601e9bb830984a5ba22e8968acd` | 314,118 | tick 1: `bought`, attempt `bought`; tick 2: `already_bought` with the same hash |

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
  - `authorize`, 3× `setCanExecute` and `setSpendLimit`.

  The relay's exact call order and encoding are not reproduced.
- **USD₮ came from a storage write** (balance mapping slot 51). The wallet got
  100 CELO.
- **Time:** one jump of 31 minutes before GoldBuyer was deployed, then
  1-second blocks. The pool keeps a single oracle observation, so GoldBuyer
  reverts `OLD` for 30 minutes after any swap. Mainnet behaves the same way.
- **Not exercised:** GoldBuyer on mainnet, the passkey, the relay, ERC-8004,
  and the real gas market.

## 4. Findings, risks and unknowns for a mainnet run

1. **The real grant will make the runner refuse, on both paths.**
   - Porto adds `{to: Orchestrator, selector: 0x32323232}` to every session
     key (`porto/src/viem/Key.ts` 1110; `RelayActions.ts` 218). The four live
     Celo sessions we read all carry it.
   - `sessionLimitsMismatch` (core/src/verify.ts) requires exactly
     {approve, buy}.
   - Fork proof: the runner answered `skipped` / `limits_mismatch` on the
     mainnet-shaped wallet.
   - This needs a deliberate fix in core before any mainnet run. It is not
     changed here.
2. **Who gets credited:**
   - `from` is the agent EOA and `to` is the Orchestrator.
   - `verifyTx` returns codes only, with no sender, for tail tags.
   - Whether Celo's dashboard credits the project for transactions sent by
     the agent EOA is unknown.
3. **Mempool copying:** anyone who sees the signed intent can submit it
   without the tag (see the table above). The purchase still counts once;
   only the tag is lost. Whether Celo's sequencer mempool is public was not
   checked.
4. **One EOA per process:** the send lock is in-process only. Overlapping cron
   instances sharing one agent EOA can collide on its transaction nonce. The
   runner then reports `ambiguous` and settles from the chain later.
5. **Costs:** the agent EOA needs CELO (about 314k gas per buy). The wallet's
   cap no longer pays a relay fee.
6. **Not tried here:** IthacaAccount also accepts a direct ERC-7821
   `execute(mode, abi.encode(calls, nonce ‖ wrappedSig))` from any sender,
   signed over `computeDigest(calls, nonce)` (IthacaAccount.sol 706–720, the
   "Execute" typehash at line 187). With it, the outer `to` would be the
   user's wallet itself, also with the tag at the end.
