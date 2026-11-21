import { getAddress, toFunctionSelector, type Address } from "viem";
import { SPEND_PERIOD } from "./abis.js";
import { USDT } from "./constants.js";
import { APPROVE_SIGNATURE, BUY_SIGNATURE, type SessionGrant } from "./grant.js";
import type { SessionState } from "./readers.js";

/**
 * Compares what the account stores for a session key with the grant a plan
 * asks for. Returns undefined when they are equal, otherwise the first
 * difference in words. Used by the browser before it tells the server to
 * activate, by the server before it activates, and by the runner before each
 * purchase.
 *
 * Equal means: the key is on the account and valid in the KeyStore; the
 * allowlist is exactly {USD₮.approve, GoldBuyer.buy}; there is exactly one
 * spend cap, on USD₮, with the plan's period and limit; and the account's
 * expiry is the plan's expiry.
 */
export function sessionLimitsMismatch(
  state: SessionState,
  grant: Pick<SessionGrant, "period" | "periodCap" | "expiry">,
  goldBuyer: Address,
  opts: { requireActive?: boolean; checkExpiry?: boolean } = {},
): string | undefined {
  const { requireActive = true, checkExpiry = true } = opts;
  if (requireActive && state.status !== "active") return `the session is not active onchain (${state.status})`;
  const want = new Set([
    `${USDT.toLowerCase()}:${toFunctionSelector(APPROVE_SIGNATURE)}`,
    `${getAddress(goldBuyer).toLowerCase()}:${toFunctionSelector(BUY_SIGNATURE)}`,
  ]);
  const have = state.allowedCalls.map((c) => `${c.target.toLowerCase()}:${c.selector.toLowerCase()}`);
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
