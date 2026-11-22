import { describe, expect, it } from "vitest";
import { createExecutor, serverConfigFromEnv, submitterFromEnv } from "../src/production.js";

const KEY = `0x${"1".repeat(64)}`;
const base = {
  DATABASE_URL: "postgres://x",
  AUTUMN_KEY_ENCRYPTION_KEY: "00".repeat(32),
  AUTUMN_GOLD_BUYER_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  AUTUMN_GOLD_BUYER_DEPLOY_BLOCK: "1",
};

describe("AUTUMN_SUBMITTER", () => {
  it("defaults to the relay", () => {
    expect(submitterFromEnv({})).toEqual({ kind: "relay" });
    expect(submitterFromEnv({ AUTUMN_SUBMITTER: "relay" })).toEqual({ kind: "relay" });
    expect(serverConfigFromEnv(base).submitter).toEqual({ kind: "relay" });
  });

  it("direct needs the agent EOA key and refuses anything else", () => {
    expect(() => submitterFromEnv({ AUTUMN_SUBMITTER: "direct" })).toThrow(/AUTUMN_DIRECT_SUBMITTER_KEY/);
    expect(() => submitterFromEnv({ AUTUMN_SUBMITTER: "Direct" })).toThrow(/"relay", "direct" or "direct-prepared"/);
    expect(submitterFromEnv({ AUTUMN_SUBMITTER: "direct", AUTUMN_DIRECT_SUBMITTER_KEY: KEY, AUTUMN_DIRECT_INTENT_TTL_SECS: "300" })).toEqual({
      kind: "direct",
      key: KEY,
      intentTtlSecs: 300,
    });
  });

  it("builds the direct executor only when asked, with the agent EOA as submitter", () => {
    const c = serverConfigFromEnv({ ...base, AUTUMN_SUBMITTER: "direct", AUTUMN_DIRECT_SUBMITTER_KEY: KEY });
    const ex = createExecutor(c) as { submitter?: string };
    expect(ex.submitter).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect((createExecutor(serverConfigFromEnv(base)) as { submitter?: string }).submitter).toBeUndefined();
    // An intent lifetime at or above the runner's 1800 s ambiguity hold is refused.
    expect(() => createExecutor(serverConfigFromEnv({ ...base, AUTUMN_SUBMITTER: "direct", AUTUMN_DIRECT_SUBMITTER_KEY: KEY, AUTUMN_DIRECT_INTENT_TTL_SECS: "1800" }))).toThrow(/intentTtlSecs/);
  });

  it("direct-prepared needs the same agent EOA key and builds its own executor; the TTL setting does not apply to it", () => {
    expect(() => submitterFromEnv({ AUTUMN_SUBMITTER: "direct-prepared" })).toThrow(/AUTUMN_SUBMITTER=direct-prepared needs AUTUMN_DIRECT_SUBMITTER_KEY/);
    expect(submitterFromEnv({ AUTUMN_SUBMITTER: "direct-prepared", AUTUMN_DIRECT_SUBMITTER_KEY: KEY, AUTUMN_DIRECT_INTENT_TTL_SECS: "300" })).toEqual({ kind: "direct-prepared", key: KEY });
    const c = serverConfigFromEnv({ ...base, AUTUMN_SUBMITTER: "direct-prepared", AUTUMN_DIRECT_SUBMITTER_KEY: KEY });
    const ex = createExecutor(c) as { submitter?: string; prepare?: unknown; quote?: unknown };
    expect(ex.submitter).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(typeof ex.prepare).toBe("function");
    // The relay stays the default.
    expect(serverConfigFromEnv(base).submitter).toEqual({ kind: "relay" });
  });
});
