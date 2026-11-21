# Altana agent-wallet de-risk spike: results

Date: 2026-11-21 (UTC). SDK `@altananetwork/sdk` 1.1.0, viem 2.x, Node 22.23.4.
No mainnet transaction was sent. No real funds were spent. Every mainnet item below comes from a read-only `eth_call`, `eth_getCode` or `eth_getStorageAt` against `https://forno.celo.org`, from verified contract source, or from the GeckoTerminal public API.

## Summary

| Step | Status |
|---|---|
| SDK supports Celo Sepolia (testnet) | **Yes.** `CELO_SEPOLIA` (chain 11142220) has its own KeyStore and is served by `https://testnet-relay.altana.network` |
| Throwaway admin key generated, kept only in `.env` | Done (`.env`, mode 600, git-ignored) |
| Fund from a public faucet | **Blocked.** The faucet needs reCAPTCHA v3, a GitHub login, or an API key (details below) |
| Full grant → act → refuse → revoke → refuse cycle | **Written (`cycle.ts`), not run on-chain.** Blocked on funds. No transaction hashes exist yet |
| Preflight (no transactions): wallet, fee tokens, grant quote | **Ran.** Output in `runs/2026-11-21T18-09-39-472Z.json` |
| Mainnet XAUt0, pool, router, selector, quotes | **Done**, read-only |
| Recipient-safety analysis | **Done**, from the account contract's verified source |
| ERC-8021 attribution tag `celo_c24c5a65e5a3` on session calls | **Can be attached, but Celo's checker does not credit it.** The tag lands inside the relay transaction's calldata, not at its end. Shown on real Altana mainnet transactions by another builder; our own testnet transaction is blocked on funds (section 7) |

## 1. Testnet support and funding

- From the SDK config (`node_modules/@altananetwork/sdk/dist/config.js`):
  - KeyStore `0xCC3df52B6aD826781AAD86EcEB1459ed0b1Ae3F6`, controller `0x54eAb49d805336DB8591BAAF9ac630D0A58Ad2cD`.
  - RPC `https://forno.celo-sepolia.celo-testnet.org`.
- `wallet_getCapabilities` on the testnet relay for chain `0xaa044c` lists:
  - orchestrator `0xcb5cef3c…62b9` (v0.5.5) and account implementation `0x33ad2f49…53de` (v0.5.10);
  - fee tokens CELO, USD₮ `0xd077A400968890Eacc75cdc901F0356c943e4fDb` (6 decimals), USDC `0x01C5C0122039549AD1493B8220cABEdD739BC44E`, USDm, EURm and KESm.
- The testnet registration fee is low. `getRegistrationFeeInWei()` on the controller returned `0x028ab968f30e007f`, which is **0.1829 CELO per key**. On mainnet it is 9.18 CELO.

**Wallet that needs funds (Celo Sepolia only):** `0xED58Da0B13bF9f63c3608F9068d488559cDCAA51`. This is both the admin EOA and the EIP-7702 wallet address.

| Asset | Amount needed | Why |
|---|---|---|
| CELO (testnet) | **1 CELO** (≥ 0.45 strictly) | The SDK quote says verbatim: `Not enough S-CELO for the registration: needs about 0.402957 S-CELO, you have 0 S-CELO.` That covers two registrations: admin plus session. The rest pays the ERC-8004 registration tx and buffer |
| USD₮ on Celo Sepolia (`0xd077…4fDb`) | **5 USD₮** | The cap is 2 USD₮/week. The script moves 0.5, attempts 3 (must be refused), and pays relay fees in USD₮ |

What I tried for funding:

1. **`faucet.celo.org` without a key.**
   - `POST /api/faucet {"beneficiary":"0xED58…AA51","network":"celo-sepolia"}` returned `{"status":"Failed","message":"invalid-input-response"}`. This is the reCAPTCHA v3 rejection.
   - The page says it pays 1 CELO per request, or 3 with GitHub sign-in. The keyless paths are a GitHub-minted API key or an ERC-8004 agent registered on Celo **mainnet**. The second would need a mainnet transaction, so I stopped.
2. **The Altana relay's ERC-20 faucet** (`wallet_addFaucetFunds`, as Porto exposes it) for Celo Sepolia USD₮ and USDC returned `{"transactionHash":null,"message":"Token address not supported"}`.
3. **Public mints on the testnet tokens.** I checked with `eth_call` only.
   - USD₮ `mint(address,uint256)`: `Ownable: caller is not the owner.`
   - USDC: `FiatToken: caller is not a minter.`

How a human can unblock this in about 2 minutes:

1. Sign in with GitHub at faucet.celo.org/celo-sepolia and request once to the address above. That gives 3 CELO.
2. Get test USD₮. Either:
   - swap about 1 CELO to USD₮ on Mento testnet (app.mento.org); I have not checked whether a USD₮ pool exists there; or
   - set `STABLE=0x01C5C0122039549AD1493B8220cABEdD739BC44E` (USDC) in `.env` and get USDC from faucet.circle.com (captcha).

Then run `npm run run`. The script works with any 6- or 18-decimal relay fee token.

## 2. The cycle script (`cycle.ts`)

`npm run preflight` sends no transactions. `npm run run` sends testnet transactions only. Every run writes a JSON log to `runs/` with:

- each step's outcome and transaction hash;
- the full error (`message`, `code`, `relayMessage`, `detail`, `cause`);
- the wallet's CELO and stablecoin balance change per step, which is the fee actually paid.

| # | Step | Expected |
|---|---|---|
| 1 | `grantSession`: spend cap `{token: USD₮, limit: 2 USD₮, period: "week"}`; allowlist `{to: USD₮, signature: "transfer(address,uint256)"}`; expiry now + 48 h; `feeToken: USD₮`; registered in the KeyStore | `granted`, tx hash |
| 2 | Session: `USD₮.transfer(recipient, 0.5)` | `CONFIRMED` |
| 3a | Session: `USD₮.approve(recipient, 1)` (selector not on the allowlist) | refused (`call_not_permitted` / `UnauthorizedCall`) |
| 3b | Session: `USD₮.transfer(recipient, 3)` (over the 2/week cap) | refused (`spend_limit_exceeded` / `ExceededSpendLimit`) |
| 4 | Admin: `revokeSession`, then a KeyStore `isValidKey` read | `revoked`, `isValidKey == false` |
| 5 | Session: `USD₮.transfer(recipient, 0.1)` after revoke | refused |

The recipient is a second throwaway key in `.env`, so test funds can be recovered.

**Run results: none yet.** There are no transaction hashes, no on-chain errors, and no measured fees, because the wallet is unfunded. Nothing in this file is simulated and presented as a result.

### What did run (preflight, 2026-11-21 18:09 UTC)

- `createWallet` registered the counterfactual wallet with the testnet relay. No transaction.
- `feeCurrencies` returned:

  | Token | Rate vs CELO |
  |---|---|
  | S-CELO | 1.0 |
  | EURm | 20.09 |
  | KESm | 0.1408 |
  | USDC | 0.6667 |
  | USDm | 18.32 |
  | USD₮ | 0.6667 |

  The stablecoin rates look wrong for a live market. The testnet relay appears to price with placeholder rates, so testnet fee amounts will not predict mainnet fees.
- `quoteGrantSession` returned a single `account` line with `feeToken` = native, `value` = `needed` = 0.20148 CELO, and `complete: false`. The reason was: `Not enough S-CELO for the registration: needs about 0.402957 S-CELO, you have 0 S-CELO. Add S-CELO on Celo Sepolia Testnet.`
  - **Possible product-review finding:** on a first grant the line's `value`/`needed` (0.2015) is one registration fee plus 10%. The reason text says twice that (0.403). An app that sizes funding from `needed` would under-fund the first grant by half. To be confirmed on a funded run.

## 3. Things learned from the account contract source (relevant before building)

The Celo mainnet account implementation `0x4b5d20cd8a3927b500540d9bccddc27385c9fa79` is verified on Celoscan as `IthacaAccount` (solc 0.8.28). These facts come from its `GuardedExecutor.sol`:

1. **"week" is a calendar week, not a rolling window.**
   - The code is `startOfSpendPeriod(Week) = DateTimeLib.mondayTimestamp(now)`, and spend resets to 0 when `lastUpdated < current`.
   - So a 50 USD₮/week cap allows 50 on Sunday 23:59 UTC and another 50 at Monday 00:00 UTC.
   - The docs' and our wording of "rolling" is wrong. Design and copy should say "per calendar week (resets Monday 00:00 UTC)". A product that needs a true rolling cap must enforce it in a wrapper contract.
2. **How spend is metered.** For each capped token, spend is `max(sum of transfer/transferFrom/approve amounts in calldata, balance drop of the wallet during the batch)`. A third-party contract that pulls the wallet's tokens through an existing allowance is still counted.
3. **Approvals are reset to 0 after every session batch.** A session cannot leave a standing allowance. Every swap must be the batch `[USD₮.approve(router, x), router.swap(...)]`.
4. **Every period on the same token is charged the full amount** (`_incrementSpent` loops over all periods). The SDK's `feeToken` daily cap (default 1 token/day) is added **only if the token has no cap yet** (`addFeeSpendCaps` in `internal/feeTokenSelection.js`). With a weekly USD₮ cap and `feeToken: USD₮`, relay fees therefore come out of the weekly cap and no daily cap is added. This comes from the code; it is not yet proven on-chain.
5. **The limits are publicly readable on the account.** `spendInfos(keyHash)` returns each token's limit, spent amount and period. `canExecutePackedInfos(keyHash)` returns the allowlist. An app can show "cap used" without trusting us.
6. **Argument checks exist in the contract but not in the SDK.** `setCallChecker(keyHash, target, checker)` plus `ICallChecker.canExecute(keyHash, target, data)` would allow argument-level checks. The SDK's `CallPermission` has no field for it. Whether the admin can set one via a self-call through the relay is **untested**.

## 4. Mainnet (read-only): USD₮ → XAUt0 swap

Raw output: `probes/mainnet-swap.output.json` (block 83,383,936). Scripts: `probes/mainnet-tokens.mjs`, `probes/mainnet-swap.mjs` and `probes/build-swap-calls.mjs`.

### Tokens

| Token | Address | Decimals | Notes |
|---|---|---|---|
| USD₮ | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | 6 | Fee-currency adapter `0x0E2A…6f72` |
| **XAUt0** | **`0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff`** | **6** | Total supply 92.86 XAUt0. Found via FeeCurrencyDirectory `0x15F3…6276`: its entry `0x857BF24e…4C16` is an 18-decimal adapter whose `getAdaptedToken()` is this token. Do not confuse the two |

### Pools

GeckoTerminal lists three XAUt0 pools on Celo:

| Pool | Address | Reserves | 24 h volume |
|---|---|---|---|
| **Uniswap V3 USD₮/XAUt0, 0.3% (deepest)** | **`0xbb469A28f64C72aECC7d05Ca6e45B2FB1a63B4F9`** | about $126.1k | about $82.7k |
| Uniswap V3 XAUt0/CELO, 0.3% | `0x0ddf8a55…cd64` | about $0.8k | |
| Carbon XAUt0/USDC | — | about $11 | |

Verified on-chain for the deepest pool:

- `token0` = USD₮, `token1` = XAUt0, `fee` = 3000.
- The pool's factory is the Uniswap V3 factory `0xAfE208a311B21f13EF87E33A90049fC17A7acDEc`. `getPool` returns this pool for fee 3000 and zero for 100, 500 and 10000.
- Balances: 24,786.76 USD₮ and 28.772 XAUt0.
- Mid price **3,542.54 USD₮ per XAUt0**.

### Router and call shape a session key needs allowlisted

- Router: **Uniswap SwapRouter02 `0x5615CDAb10dc425a742d643d949a7F474C01abc4`**. Its `factory()` is the factory above, and its bytecode contains the selector.
- Function: **`exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))`**, selector **`0x04e45aaf`**. There is no deadline field in SwapRouter02.
- Call batch (one `execute`):
  1. `USD₮.approve(0x5615…abc4, amountIn)`, selector `0x095ea7b3`.
  2. `SwapRouter02.exactInputSingle({tokenIn: USD₮, tokenOut: XAUt0, fee: 3000, recipient: <wallet>, amountIn, amountOutMinimum: quote × (1 − slippage), sqrtPriceLimitX96: 0})`.

  Example calldata for 5 USD₮ is printed by `node probes/build-swap-calls.mjs`.
- Session grant to match:
  - calls `[{to: USD₮, signature: "approve(address,uint256)"}, {to: 0x5615…abc4, signature: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"}]`;
  - spend `[{token: USD₮, limit, period: "week"}]`;
  - `feeToken: USD₮`.
  - Not yet confirmed: whether the relay accepts a tuple signature string. A raw selector may be needed.
- Do **not** allowlist the other router functions: `exactInput` (`0xb858183f`) accepts arbitrary multi-hop paths, and the `multicall` variants (`0x5ae401dc`, `0xac9650d8`) reach every router function.
- XAUt0 needs no cap to be **received**. Selling XAUt0 later needs its own cap at grant time (SDK issue #75).
- Quoter for prices: QuoterV2 `0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8`. Its factory matches.

### Quotes (QuoterV2 `quoteExactInputSingle`, eth_call, block 83,383,936)

| Buy | XAUt0 out | Effective price | Cost vs mid (incl. 0.3% LP fee) | Price impact excluding fee |
|---|---|---|---|---|
| $5 (5 USD₮) | 0.001407 | 3,553.66 | +0.314% | about 0.013%; mostly 6-decimal rounding of the output |
| $50 | 0.014071 | 3,553.41 | +0.307% | **about 0.006%** |
| $500 (reference) | 0.140674 | 3,554.32 | +0.332% | about 0.031% |

No initialized ticks are crossed even at $500. Two other costs matter:

- **Rounding.** XAUt0 has 6 decimals, so one unit is about $0.0035. That rounding is visible on $5 buys.
- **Relay fee.** It is about $0.005 per session tx on mainnet, per Altana's own report. That is 0.1% of a $5 buy.

## 5. Recipient safety: can a compromised agent send funds elsewhere through this router call?

**Yes.** The allowlist checks only `(target, selector)`. `canExecute` matches packed `(target, fnSel)` and never decodes arguments. A leaked session key holding `{USD₮.approve, SwapRouter02.exactInputSingle}` can do any of the following, each bounded only by the remaining calendar-week USD₮ cap (and, at the Monday reset, up to two caps back to back):

1. **Set `recipient` to an attacker address.** The XAUt0 bought with the wallet's USD₮ goes to the attacker.
2. **Choose `tokenOut` and `fee` freely.** The attacker creates a worthless token and a Uniswap V3 pool for USD₮/that token, then "buys" it. The wallet's USD₮ ends up in the attacker's pool.
3. **Set `amountOutMinimum = 0`** and sandwich its own trade in the thin $126k pool.
4. **Approve any spender.** This is harmless on its own. The approval is reset after the batch and can only be used by an allowlisted target in the same batch.

The cap bounds the loss. Nothing in the allowlist stops it.

### Design that removes this: a tiny immutable wrapper, and the session allowlists only the wrapper

```solidity
// GoldBuyer: no owner, no storage, no admin functions, holds no balance between calls.
function buy(uint256 amountIn, uint256 minOut) external returns (uint256 out) {
    require(minOut >= twapFloor(amountIn, MAX_SLIPPAGE_BPS));  // e.g. 30-min TWAP via pool.observe(), 1%
    USDT.transferFrom(msg.sender, address(this), amountIn);
    USDT.forceApprove(ROUTER02, amountIn);
    out = ROUTER02.exactInputSingle(Params(USDT, XAUT0, 3000, msg.sender, amountIn, minOut, 0));
}
```

- The session grant becomes calls `[{to: USD₮, signature: "approve(address,uint256)"}, {to: GoldBuyer, signature: "buy(uint256,uint256)"}]` with the weekly USD₮ cap. Each agent batch is `[USD₮.approve(GoldBuyer, x), GoldBuyer.buy(x, minOut)]`.
- `recipient` is fixed to `msg.sender` (the wallet). `tokenIn`, `tokenOut` and fee are constants. The price floor is enforced on-chain.
- The wallet's spend is still metered: the approve amount and the balance drop both count. The account resets the approval after the batch, so the wrapper never keeps an allowance.
- The wrapper can also enforce a true **rolling** 7-day cap. The account's "week" cannot.
- Residual risk is a compromised agent buying gold at a fair price, up to the cap, at bad times. That is acceptable for this product.
- Alternative without a wrapper: an `ICallChecker` attached with `setCallChecker` that decodes `exactInputSingle` and requires `tokenIn == USD₮`, `tokenOut == XAUt0`, `fee == 3000` and `recipient == wallet`. The contract supports this, but the SDK does not expose it and it is untested. The wrapper is the simpler path and is easy to show in a demo.
- The wrapper is a new, unaudited contract. Keep it about 30 lines and fork-test it against mainnet state before use.

## 7. ERC-8021 attribution tag through the Altana relay

Our tag: `toDataSuffix("celo_c24c5a65e5a3")` = `0x63656c6f5f633234633561363565356133110080218021802180218021802180218021` (35 bytes). Package `@celo/attribution-tags` 0.5.0. Testnet only for now.

### How Celo's checker reads tags

From `BUILDERS.md`, `INDEXERS.md` and `sdk/README.md` in celo-org/attribution-tags:

- It parses **backwards from the end of the outer `tx.input`**. The 16-byte marker `0x8021…8021` must be the last bytes.
- The only exception is **ERC-4337**. The checker detects `handleOps` by selector (`0x1fad948c` for v0.6, `0x765e827f` for v0.7), decodes each UserOperation's `callData`, and credits the op's `sender`.
- No other relayer, bundler or EIP-7702 path is decoded. The guide says relayers that re-encode calldata "can still drop the suffix" and tells you to contact the maintainers.

### How Altana transactions look on-chain

- The outer transaction comes from the relay's EOA (e.g. `0xde3136c4…c5b4`) and goes to the Orchestrator `0xaf140d04…9751` on Celo mainnet.
- It calls `execute(bytes encodedIntent)`, selector `0x09c5eabe`. The ABI is verified on Celoscan.
- This is an Ithaca/Porto intent, **not** an ERC-4337 `handleOps`. The outer input ends with ABI zero padding.
- The signed intent's `executionData` carries our calls' `data` byte for byte. The relay cannot change it, because it is covered by the signature.

### Evidence (read-only, `probes/attribution-check.mjs`, `probes/embedded-tags.mjs`)

Another builder already sent Celo mainnet transactions through the Altana relay with the tag `spike_altana_test` appended to an inner call:

| Tx | Embedded tag found (decoded) | Bytes after the marker | `verifyTx` (attribution-tags 0.5.0) |
|---|---|---|---|
| `0x37c107dbe9efcfa20ffe56d179045c2ac29dae9cd16d16f094bcf3c4355513db` | `spike_altana_test` at byte 1083 of 1444 | 345 | **null** |
| `0x2226464a8499c60bbf80bb96e8f8432b938f976f84ca2148fbed4b8cb059f95d` | `spike_altana_test`, twice (bytes 1115 and 2299 of 2660) | 1529 / 345 | **null** |

The tag survives the relay intact, but Celo's own checker does not see it.

I also modelled the best case offline: a tagged `transfer` wrapped as `abi.encode(Call[])` inside `execute(bytes)`, with nothing after it. Even there the marker ends 25 bytes before the end, because of ABI padding, and `fromDataSuffix(outer)` is null.

### How to attach it with the SDK

```ts
import { toDataSuffix } from "@celo/attribution-tags";
import { concat } from "viem";
const TAG = toDataSuffix("celo_c24c5a65e5a3");
await client.execute({ session, calls: [{ to, data: concat([calldata, TAG]) }] });
```

- This is the only hook available. The SDK has no `dataSuffix` option, and the relay's `wallet_prepareCalls` schema has no suffix capability. I searched the SDK, the Porto relay schema and the Altana docs.
- `withAttribution` and viem's client-level `dataSuffix` do not apply, because the SDK builds its own transport.
- The tag does not break the session's guards:
  - the allowlist reads only the selector;
  - spend metering reads the amount at offset 0x24 and the balance change;
  - ERC-20s and SwapRouter02 ignore trailing calldata.
- With the GoldBuyer wrapper, the tag goes after `buy(...)`'s calldata in the same way.
- `cycle.ts` now does this on every testnet session call (`ATTRIBUTION=off` disables it). After each confirmed call it records:
  - `verifyTx` and the tail parse;
  - every embedded tag with its byte offset, under `steps[].attribution` in the run log.

**No testnet transaction hash yet.** The wallet is unfunded (section 1). The first funded `npm run run` will show this on our own transactions.

### Conclusion and what would make it count

As Altana and Celo's checker work today, a session call **cannot** get the tag to the end of the outer transaction, and no transaction sent this way is credited. Ways out, none tested:

1. **Celo attribution team:** decode Ithaca/Porto `Orchestrator.execute(bytes)` (`0x09c5eabe`), and the batch form `execute(bytes[])`, the way they decode `handleOps`. They would credit the intent's `eoa` (the Altana wallet) for a tag inside a call's `data`. This is the cleanest fix; we have two public example transactions to hand them.
2. **Altana:** a relay or SDK option to append a suffix to the outer transaction. `execute(bytes)` ignores trailing calldata, so this is safe. The outer `from` would still be the relay, so the indexer would need to credit the wallet.
3. **Submit the signed intent ourselves** from an EOA with the tag at the end. `execute` is permissionless, but the relay still charges its fee inside the intent. The SDK does not expose this, and `from` would be our submitter EOA, not the wallet.
4. **Owner (admin) transactions only:** the wallet is an EIP-7702 EOA, so the admin key can send ordinary self-transactions with the tag at the end. That tags owner actions such as funding and revoking, not the agent's session swaps.

Recommendation: raise options 1 and 2 with Celo and Altana now (both are reachable through hackathon channels), and do not count on agent transactions being credited until one of them ships.

## 6. Honest read

- **The flow is credible but not proven.**
  - The contract logic for cap, allowlist, expiry and revoke is clear, verified, and exactly what we need.
  - Altana's own runs and four other wallets show grants landing on Celo mainnet.
  - I could not execute a single grant, so the specific failure another entrant hit (`RPC Request failed`, code 3, at `wallet_prepareCalls`) is neither reproduced nor ruled out.
- **Treat as not de-risked** until `npm run run` completes on Celo Sepolia. After that, repeat once on mainnet: about 20 CELO for the first grant, plus a few USD₮, with the GoldBuyer wrapper deployed.
- **Traction attribution is at risk.** Agent transactions sent through the Altana relay carry our tag but are not credited by Celo's checker today (section 7). This needs a fix from Celo or Altana; we cannot fix it on our side.
- **Change the product spec:**
  - Say "weekly cap, resets Monday 00:00 UTC", or enforce a rolling window in the wrapper.
  - Never allowlist the router directly.

## Files

- `cycle.ts`: the grant/act/refuse/revoke script (testnet only).
- `.env`: `ADMIN_KEY`, `SESSION_KEY`, `RECIPIENT_KEY`. Throwaway testnet keys, mode 600, never printed, git-ignored.
- `runs/`: JSON logs of each run. Contains no secrets; I checked this file against the keys.
- `probes/`: read-only probes and the mainnet swap output.
