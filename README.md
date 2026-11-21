# Autumn

A little gold every week. Never more than you allow.

Autumn is an agent that buys a small amount of tokenized gold (Tether Gold,
XAUt0) for you on Celo each week. You keep custody: the wallet is yours, opened
with a passkey. The agent works from a session key that the chain limits to a
weekly spend cap, to gold purchases delivered to your own wallet, and to an
expiry date. One transaction stops it.

Built for the Celo "Agents Open for Business" hackathon, Altana Agent Wallets
track. Work started on 21 November 2026 and is in progress.

## How it works

1. You create an [Altana](https://altana.network) wallet with a passkey and
   deposit USD₮ on Celo.
2. You pick a plan, for example 5 USD₮ of gold per week. Confirming it grants
   the agent a session key with those limits, recorded in Altana's public
   Keystore.
3. The agent buys gold on schedule through `GoldBuyer`, a small contract with
   no owner that can only swap USD₮ for XAUt0 and send it back to the caller.
   The session key can call nothing else.
4. You can stop the agent at any time. The revoke is one onchain transaction.

## Layout

| Path | Contents |
|---|---|
| `web/` | The app (Next.js) |
| `contracts/` | `GoldBuyer` and its mainnet-fork tests |
| `agent/` | The service that runs scheduled purchases |
| `docs/altana-spike/` | Findings and scripts from testing the Altana flow on Celo |

## Licence

MIT
