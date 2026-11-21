import { describe, expect, it } from "vitest";
import { AltanaError } from "@altananetwork/sdk";
import { explainAltanaError, explainExecuteResult } from "../../src/errors.js";

const altana = (code: any, relayMessage?: string) =>
  new AltanaError({ code, statement: "s", action: "a", ...(relayMessage ? { relayMessage } : {}) });

describe("SDK error mapping", () => {
  it("maps the SDK codes", () => {
    expect(explainAltanaError(altana("spend_limit_exceeded"))).toMatchObject({ kind: "cap_exceeded", bought: "no" });
    expect(explainAltanaError(altana("call_not_permitted"))).toMatchObject({ kind: "call_not_permitted", bought: "no" });
    expect(explainAltanaError(altana("session_expired"))).toMatchObject({ kind: "session_ended", stopsPlan: true });
    expect(explainAltanaError(altana("insufficient_funds"))).toMatchObject({ kind: "insufficient_balance", bought: "no" });
    expect(explainAltanaError(altana("relay_unreachable"))).toMatchObject({ kind: "relay_failure", bought: "unknown" });
  });

  it("reads revert names and the revoked-key message from the relay text", () => {
    expect(explainAltanaError(altana("unknown", "intent reverted: ExceededSpendLimit(0x48…)")).kind).toBe("cap_exceeded");
    expect(explainAltanaError(new Error("UnauthorizedCall(0x…)")).kind).toBe("call_not_permitted");
    expect(explainAltanaError(altana("unknown", "key hash 0xabc123 is unknown"))).toMatchObject({ kind: "session_ended", stopsPlan: true });
    expect(explainAltanaError(new Error("wrapped", { cause: altana("spend_limit_exceeded") })).kind).toBe("cap_exceeded");
  });

  it("reads the pool oracle's OLD revert as a price check that is not available yet, nothing sent", () => {
    expect(explainAltanaError(altana("unknown", "execution reverted: OLD"))).toMatchObject({ kind: "twap_unavailable", bought: "no", stopsPlan: false });
    expect(explainAltanaError(new Error("simulation failed", { cause: new Error('reverted with reason "OLD"') })).kind).toBe("twap_unavailable");
    expect(explainAltanaError(new Error("old socket")).kind).toBe("unknown");
  });

  it("treats an unrecognised error as an unknown outcome", () => {
    expect(explainAltanaError(new Error("socket hang up"))).toMatchObject({ kind: "unknown", bought: "unknown" });
  });

  it("maps execute results by relay status band", () => {
    expect(explainExecuteResult({ status: "CONFIRMED", statusCode: 200 })).toBeUndefined();
    expect(explainExecuteResult({ status: "FAILED", statusCode: 300 })?.bought).toBe("no");
    expect(explainExecuteResult({ status: "FAILED", statusCode: 500 })?.bought).toBe("no");
    // 600: partially reverted. Not proof that nothing was bought: re-read the chain.
    expect(explainExecuteResult({ status: "FAILED", statusCode: 600 })?.bought).toBe("unknown");
    expect(explainExecuteResult({ status: "PENDING", statusCode: 100 })?.bought).toBe("unknown");
    expect(explainExecuteResult({ status: "FAILED" })?.bought).toBe("unknown");
  });
});
