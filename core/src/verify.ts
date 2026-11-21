import { type Address } from "viem";
import { SPEND_PERIOD } from "./abis.js";
import { ALTANA_ORCHESTRATOR_BY_CHAIN, ANY_SELECTOR, ANY_TARGET, CELO_CHAIN_ID, USDT } from "./constants.js";
import { ACCOUNT_KEY_TYPE_SECP256K1 } from "./keys.js";
import { expectedOnchainAllowlist, type SessionGrant } from "./grant.js";
import type { SessionState } from "./readers.js";

/**
 * Compares what the account stores for a session key with the grant a plan
 * asks for. Returns undefined when they are equal, otherwise the first
 * difference in words. Used by the browser before it tells the server to
 * activate, by the server before it activates, and by the runner before each
 * purchase.
 *
 * Equal means: the key is on the account and valid in the KeyStore; the
 * account stores it as an ordinary secp256k1 key, not a super admin (a super
 * admin key skips every guard, IthacaAccount `_isSuperAdmin`); the allowlist
 * is exactly {USD₮.approve, GoldBuyer.buy, Orchestrator any-selector}, where
 * the Orchestrator is the one pinned for Celo (expectedOnchainAllowlist: the
 * SDK's Porto layer adds that entry to every session key, and it cannot move
 * funds); no wildcard target and no any-selector entry on any other target;
 * there is exactly one spend cap, on USD₮ (so no native CELO limit: a session
 * call or fee with CELO value reverts `NoSpendPermissions`), with the plan's
 * period and limit; and the account's expiry is the plan's expiry.
 */
export function sessionLimitsMismatch(
  state: SessionState,
  grant: Pick<SessionGrant, "period" | "periodCap" | "expiry">,
  goldBuyer: Address,
  opts: { requireActive?: boolean; checkExpiry?: boolean } = {},
): string | undefined {
  const { requireActive = true, checkExpiry = true } = opts;
  if (requireActive && state.status !== "active") return `the session is not active onchain (${state.status})`;
  if (state.onAccount) {
    if (state.isSuperAdmin !== false) return "the key is a super admin on the account, not a limited session key";
    if (state.keyType !== Number(ACCOUNT_KEY_TYPE_SECP256K1)) return "the key on the account is not a secp256k1 session key";
  }
  const orchestrator = ALTANA_ORCHESTRATOR_BY_CHAIN[CELO_CHAIN_ID]!.toLowerCase();
  const key = (target: string, selector: string) => `${target.toLowerCase()}:${selector.toLowerCase()}`;
  for (const c of state.allowedCalls) {
    if (c.target.toLowerCase() === ANY_TARGET.toLowerCase()) return "the session's onchain allowlist has a wildcard target (any contract)";
    if (c.selector.toLowerCase() === ANY_SELECTOR && c.target.toLowerCase() !== orchestrator) {
      return `the session's onchain allowlist lets it call any function of ${c.target}`;
    }
  }
  const want = new Set(expectedOnchainAllowlist(goldBuyer).map((c) => key(c.target, c.selector)));
  const have = state.allowedCalls.map((c) => key(c.target, c.selector));
  if (have.length !== want.size || new Set(have).size !== want.size || have.some((h) => !want.has(h))) {
    return "the session's onchain allowlist differs from the plan";
  }
  if (state.spend.some((s) => s.token.toLowerCase() !== USDT.toLowerCase())) return "the session can spend a token other than USD₮";
  if (state.spend.length !== 1) return "the session has more than one USD₮ spend cap";
  const cap = state.spend[0]!;
  if (cap.period !== SPEND_PERIOD[grant.period]) return `the session's onchain spend period differs from the plan (${grant.period})`;
  if (cap.limit !== grant.periodCap) return `the session's onchain ${grant.period === "day" ? "daily" : "weekly"} cap differs from the plan`;
  if (checkExpiry && state.accountExpiry !== grant.expiry) return "the session's onchain expiry differs from the plan";
  return undefined;
}
