/**
 * Pure decisions about agent keys that are granted (or may be) but not yet running a plan, and about the Autumn
 * server's answers. Kept apart from autumn.live.ts so they can be tested without a browser or a chain.
 *
 * The rule they keep: a key is only ever called "stray" (and offered for revoking, which costs a fee) when a
 * successful read proves it cannot run its plan. A failed read, a slow relay or a busy server is never proof.
 */
import { sessionLimitsMismatch, type SessionGrant, type SessionState } from "@autumn/core";

/** An answer from the Autumn server that was not 2xx. status 0: the server could not be reached at all. */
export class ApiError extends Error {
  readonly name = "ApiError";
  constructor(
    readonly status: number,
    message: string,
    /** The server's stable machine-readable reason (HttpError.code), when it gave one. */
    readonly code?: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * What to do after POST /api/plans/:id/activate failed:
 * - "retry": nothing was decided (server or chain unreachable, the key not visible yet); try again with backoff.
 * - "stray": the server answered for good that this key cannot run its plan (the chain shows other limits, or the
 *   plan is gone or stopped): the owner should be offered a revoke.
 * - "fail": a definite refusal that says nothing about the key itself (a malformed report): show it, do not revoke.
 */
export function activateVerdict(e: unknown): "retry" | "stray" | "fail" {
  if (!(e instanceof ApiError)) return "retry"; // fetch failed, timeout: unknown
  if (e.status === 0 || e.status >= 500 || e.status === 429) return "retry";
  switch (e.code) {
    case "not_visible":
    case "chain_unavailable":
      return "retry";
    case "limits_mismatch":
    case "no_such_plan":
    case "plan_stopped":
    case "session_expired":
    case "other_plan_active":
    case "grant_reverted":
      return "stray";
    case undefined:
      // An older server without codes: its "not visible / not active" answers meant "try again".
      if (e.status === 404) return "stray";
      return /not visible|not active/.test(e.message) ? "retry" : "fail";
    default:
      return "fail";
  }
}

/** The key's state after a successful read, against the plan's grant. "unknown" when the read did not succeed. */
export type GrantCheck = { kind: "ok" } | { kind: "mismatch"; reason: string } | { kind: "not_visible" } | { kind: "unknown" };

export function checkGrantOnchain(state: SessionState | null, grant: SessionGrant, goldBuyer: `0x${string}`): GrantCheck {
  if (!state) return { kind: "unknown" };
  if (state.status === "revoked" && !state.onAccount) return { kind: "not_visible" };
  if (state.status !== "active") return { kind: "mismatch", reason: `the key is ${state.status} onchain` };
  const reason = sessionLimitsMismatch(state, grant, goldBuyer);
  return reason ? { kind: "mismatch", reason } : { kind: "ok" };
}

/** Delays between retries, ms: 2 s, 4 s, 6 s, then 8 s, until `budgetMs` is spent. */
export function backoffDelays(budgetMs: number): number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = 1; total < budgetMs; i++) {
    const d = Math.min(8000, 2000 * i);
    out.push(d);
    total += d;
  }
  return out;
}
