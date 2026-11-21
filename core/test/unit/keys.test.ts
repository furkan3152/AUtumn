import { describe, expect, it } from "vitest";
import { deserializeSession, keyHashForSessionOrKey, keyIdForSessionOrKey, signerFromPrivateKey } from "@altananetwork/sdk";
import { generatePrivateKey } from "viem/accounts";
import { sessionKeyIds, sessionSignerFromPublicKey } from "../../src/keys.js";
import { unpackCanExecute } from "../../src/readers.js";

describe("session key ids", () => {
  it("match the SDK's keyId and keyHash for the same public key", () => {
    const signer = signerFromPrivateKey(generatePrivateKey());
    const ids = sessionKeyIds(signer.publicKey);
    expect(ids.address).toBe(signer.address);
    expect(ids.keyId).toBe(keyIdForSessionOrKey(signer.publicKey));
    expect(ids.keyHash).toBe(keyHashForSessionOrKey(signer.publicKey));
  });

  it("a public-key-only signer has the same identity and cannot sign", async () => {
    const real = signerFromPrivateKey(generatePrivateKey());
    const pub = sessionSignerFromPublicKey(real.publicKey);
    expect(pub.address).toBe(real.address);
    expect(pub.publicKey.toLowerCase()).toBe(real.publicKey.toLowerCase());
    await expect(pub.signDigest(("0x" + "00".repeat(32)) as `0x${string}`)).rejects.toThrow(/public key/);
    // The agent's real key rebuilds a session granted to that public key.
    const s = deserializeSession(
      { walletAddress: "0x2222222222222222222222222222222222222222", publicKey: pub.publicKey, permissions: {}, expiry: 2_000_000_000 },
      real,
    );
    expect(s.signer).toBe(real);
  });

  it("rejects compressed or malformed keys", () => {
    expect(() => sessionKeyIds(("0x02" + "ab".repeat(32)) as `0x${string}`)).toThrow();
  });

  it("unpacks canExecute entries (target upper 20 bytes, selector lower 4)", () => {
    const packed = ("0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e" + "00".repeat(8) + "095ea7b3") as `0x${string}`;
    expect(unpackCanExecute(packed)).toEqual({ target: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", selector: "0x095ea7b3" });
  });
});
