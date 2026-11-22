import { describe, expect, it } from "vitest";
import { BaseError } from "viem";
import { errorText } from "../src/lib/useAutumn";
import { ApiError, activateVerdict, backoffDelays, checkGrantOnchain } from "../src/lib/pending";
import { CheckAgainError } from "../src/lib/autumn";

describe("errorText", () => {
  it("words the server's machine codes, never its raw status", () => {
    expect(errorText(new ApiError(503, "Celo could not be read to check the agent's key; try again", "chain_unavailable"))).toMatch(/did not answer. Nothing was changed/);
    expect(errorText(new ApiError(0, "x", "network"))).toMatch(/could not be reached/);
    expect(errorText(new ApiError(500, "the Autumn server could not complete this request"))).toMatch(/Nothing was changed/);
    expect(errorText(new ApiError(429, "too many plans"))).toMatch(/Too many requests/);
    expect(errorText(new ApiError(400, "expiresAt must be 12 weeks from now"))).toBe("The Autumn server refused this: expiresAt must be 12 weeks from now.");
  });

  it("shortens SDK and viem dumps", () => {
    expect(errorText(new Error("Session grant did not confirm: status=PENDING (relay code 100)"))).toMatch(/nothing will be paid twice/);
    expect(errorText(new Error("erc8004: register reverted (callsId 0xabc)"))).toMatch(/identity could not be registered/);
    expect(errorText(new Error("RPC Request failed.\nURL: https://relay.altana.network\nRequest body: {...}"))).toMatch(/Altana relay could not handle/);
    expect(errorText(new BaseError("HTTP request failed.", { details: "fetch failed" }))).toMatch(/did not answer/);
    expect(errorText(new Error("x".repeat(400)))).toMatch(/Something went wrong/);
  });

  it("keeps Autumn's own sentences", () => {
    const own = new CheckAgainError("send", "The relay accepted the transfer but has not confirmed it yet. Do not send again.");
    expect(errorText(own)).toBe(own.message);
    expect(errorText(new Error("That is the zero address. Funds sent there are lost."))).toBe("That is the zero address. Funds sent there are lost.");
  });
});

describe("activateVerdict (when a key may be called stray)", () => {
  it("retries transport failures, busy servers and keys not visible yet", () => {
    for (const e of [new TypeError("fetch failed"), new ApiError(0, "x", "network"), new ApiError(503, "x", "chain_unavailable"), new ApiError(500, "x"), new ApiError(409, "x", "not_visible"), new ApiError(429, "x")]) {
      expect(activateVerdict(e)).toBe("retry");
    }
    // An older server's 409 for a key not on the account yet.
    expect(activateVerdict(new ApiError(409, "the session is not active onchain (revoked)"))).toBe("retry");
    // An older server reporting an RPC failure as 409 with a raw message is not proof either.
    expect(activateVerdict(new ApiError(409, "HTTP request failed. Status: 502"))).toBe("fail");
  });

  it("calls a key stray only on a definite answer", () => {
    expect(activateVerdict(new ApiError(409, "the session's onchain weekly cap differs from the plan", "limits_mismatch"))).toBe("stray");
    expect(activateVerdict(new ApiError(404, "no such plan", "no_such_plan"))).toBe("stray");
    expect(activateVerdict(new ApiError(409, "the granted session does not match the plan", "session_mismatch"))).toBe("fail");
  });
});

describe("checkGrantOnchain", () => {
  const grant = { period: "week", periodCap: 5_050_000n, expiry: 100 } as never;
  it("is unknown without a read and not_visible while the key is not on the account", () => {
    expect(checkGrantOnchain(null, grant, "0x0000000000000000000000000000000000000001")).toEqual({ kind: "unknown" });
    expect(checkGrantOnchain({ status: "revoked", onAccount: false } as never, grant, "0x0000000000000000000000000000000000000001")).toEqual({ kind: "not_visible" });
    expect(checkGrantOnchain({ status: "expired", onAccount: true } as never, grant, "0x0000000000000000000000000000000000000001").kind).toBe("mismatch");
  });
});

describe("backoffDelays", () => {
  it("grows to 8 s and covers the budget", () => {
    expect(backoffDelays(0)).toEqual([]);
    expect(backoffDelays(30_000)).toEqual([2000, 4000, 6000, 8000, 8000, 8000]);
  });
});
