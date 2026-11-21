/**
 * Human-readable mapping of Altana SDK failures for Autumn. Branches on the
 * SDK's `AltanaError.code` (docs: /sdk/errors), falling back to the relay's
 * revert names, which the SDK quotes in `relayMessage` / `message`.
 *
 * `bought` says what the failure proves about a purchase:
 * - "no": the relay refused before inclusion or the SDK refused before
 *   sending; nothing reached a block.
 * - "unknown": the outcome is not established (transport failure, timeout,
 *   unrecognised error). The caller must re-read the chain before acting again.
 */

export type FailureKind =
  | "cap_exceeded"
  | "call_not_permitted"
  | "session_ended"
  | "insufficient_balance"
  | "quote_expired"
  | "twap_unavailable"
  | "relay_failure"
  | "unknown";

export type ExplainedFailure = {
  kind: FailureKind;
  /** One sentence for the owner. */
  message: string;
  /** SDK code when there was one. */
  code?: string;
  bought: "no" | "unknown";
  /** The session can no longer act: stop the plan. */
  stopsPlan: boolean;
};

const MESSAGES: Record<FailureKind, string> = {
  cap_exceeded: "This purchase would go over the limit you set, so it was not made.",
  call_not_permitted: "The agent's key is not allowed to make this call, so nothing was sent.",
  session_ended: "The agent's key has been revoked or has expired. Set up a new plan to continue.",
  insufficient_balance: "The wallet does not hold enough USD₮ for this purchase and its fee.",
  quote_expired: "The relay's fee quote expired before sending. The next run will try again.",
  twap_unavailable: "Price check not available right now, the agent will retry.",
  relay_failure: "The Altana relay could not be reached or did not answer. Autumn will check the chain before trying again.",
  unknown: "The purchase did not complete for a reason Autumn did not recognise. Autumn will check the chain before trying again.",
};

type ErrorLike = { code?: unknown; message?: unknown; relayMessage?: unknown; name?: unknown; cause?: unknown };

function textOf(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    const x = e as ErrorLike;
    if (typeof x.message === "string") parts.push(x.message);
    if (typeof x.relayMessage === "string") parts.push(x.relayMessage);
    e = x.cause;
  }
  return parts.join(" | ");
}

/** The SDK's AltanaError nearest the surface, duck-typed (works across package copies). */
function altanaCodeOf(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    const x = e as ErrorLike;
    if (x.name === "AltanaError" && typeof x.code === "string") return x.code;
    e = x.cause;
  }
  return undefined;
}

function make(kind: FailureKind, bought: "no" | "unknown", code?: string): ExplainedFailure {
  return { kind, message: MESSAGES[kind], ...(code ? { code } : {}), bought, stopsPlan: kind === "session_ended" };
}

/** Maps a thrown SDK error (from execute/quoteExecute) to an ExplainedFailure. */
export function explainAltanaError(err: unknown): ExplainedFailure {
  const code = altanaCodeOf(err);
  const text = textOf(err);

  switch (code) {
    case "spend_limit_exceeded":
      return make("cap_exceeded", "no", code);
    case "call_not_permitted":
      return make("call_not_permitted", "no", code);
    case "session_expired":
      return make("session_ended", "no", code);
    case "insufficient_funds":
      return make("insufficient_balance", "no", code);
    case "quote_expired":
      return make("quote_expired", "no", code);
    case "relay_unreachable":
      return make("relay_failure", "unknown", code);
    case "chain_not_served":
    case "wallet_unknown_to_relay":
    case "price_unavailable":
    case "prices_stale":
      // Refused while preparing: nothing was signed and sent.
      return make("relay_failure", "no", code);
  }

  // The pool's oracle has under 30 minutes of history (Uniswap V3 reverts "OLD"):
  // GoldBuyer refuses to price the buy. Refused in simulation, nothing sent.
  if (/\bOLD\b/.test(text)) {
    return make("twap_unavailable", "no", code);
  }

  // Revert names the relay reports from its simulation (before inclusion).
  if (/ExceededSpendLimit|NoSpendPermissions/.test(text)) return make("cap_exceeded", "no", code);
  if (/UnauthorizedCall|Unauthorized\(\)/.test(text)) return make("call_not_permitted", "no", code);
  if (/key hash 0x[0-9a-fA-F]+ is unknown|KeyDoesNotExist/i.test(text)) return make("session_ended", "no", code);
  if (/\(relay code [34]\d\d\)|status(Code)?[=: ]+[34]\d\d\b/i.test(text)) return make("relay_failure", "no", code);
  return make(code === undefined ? "unknown" : "relay_failure", "unknown", code);
}

/**
 * Maps a non-throwing execute result. CONFIRMED is not a failure and returns
 * undefined. FAILED with a 3xx/4xx code was refused before inclusion; FAILED
 * with 5xx/6xx landed and reverted (it consumed a fee but bought nothing);
 * PENDING is unknown.
 */
export function explainExecuteResult(r: { status: string; statusCode?: number }): ExplainedFailure | undefined {
  if (r.status === "CONFIRMED") return undefined;
  if (r.status === "PENDING") return make("relay_failure", "unknown");
  const c = r.statusCode;
  if (c !== undefined && c >= 300 && c < 500) return make("relay_failure", "no");
  if (c !== undefined && c >= 500 && c < 700) {
    return { ...make("unknown", "no"), message: "The purchase transaction reverted onchain, so no gold was bought." };
  }
  return make("unknown", "unknown");
}
