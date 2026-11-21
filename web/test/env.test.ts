import { describe, expect, it } from "vitest";
import { parsePublicConfig, passkeyOriginProblem } from "../src/lib/env";

const ok = { goldBuyer: "0x5b73c5498c1e3b4dba84de0f1833c4a029d90519", deployBlock: "83380000", rpId: "localhost" };

describe("parsePublicConfig", () => {
  it("needs the GoldBuyer address, its deploy block and the passkey rpId", () => {
    expect(parsePublicConfig({})).toEqual({
      ok: false,
      problems: ["NEXT_PUBLIC_AUTUMN_GOLD_BUYER_ADDRESS", "NEXT_PUBLIC_AUTUMN_GOLD_BUYER_DEPLOY_BLOCK", "NEXT_PUBLIC_AUTUMN_RP_ID"],
    });
    const r = parsePublicConfig(ok);
    expect(r).toMatchObject({ ok: true, config: { rpId: "localhost", rpcUrl: "https://forno.celo.org", logBlockRange: 5000n, appOrigin: null } });
  });
  it("rejects malformed values", () => {
    expect(parsePublicConfig({ ...ok, goldBuyer: "0x12" }).ok).toBe(false);
    expect(parsePublicConfig({ ...ok, rpId: "https://autumn.example" }).ok).toBe(false);
    expect(parsePublicConfig({ ...ok, appOrigin: "not a url" }).ok).toBe(false);
    expect(parsePublicConfig({ ...ok, logBlockRange: "0" }).ok).toBe(false);
  });
});

describe("passkeyOriginProblem", () => {
  it("allows the rpId host and its subdomains, and only the configured origin", () => {
    expect(passkeyOriginProblem({ rpId: "localhost", appOrigin: null }, { origin: "http://localhost:3000", hostname: "localhost" })).toBeNull();
    expect(passkeyOriginProblem({ rpId: "autumn.example", appOrigin: null }, { origin: "https://app.autumn.example", hostname: "app.autumn.example" })).toBeNull();
    expect(passkeyOriginProblem({ rpId: "autumn.example", appOrigin: null }, { origin: "https://evilautumn.example", hostname: "evilautumn.example" })).toMatch(/cannot use passkeys/);
    expect(passkeyOriginProblem({ rpId: "localhost", appOrigin: "http://localhost:3000" }, { origin: "http://localhost:3001", hostname: "localhost" })).toMatch(/only on/);
  });
});
