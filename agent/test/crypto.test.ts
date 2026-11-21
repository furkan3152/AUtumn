import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { decryptSessionKey, encryptSessionKey, generateSessionKey, parseEncryptionKey } from "../src/crypto.js";

describe("session key encryption (AES-256-GCM)", () => {
  const key = randomBytes(32);

  it("round-trips a session private key", () => {
    const { privateKey, publicKey } = generateSessionKey();
    const enc = encryptSessionKey(privateKey, "plan-1", key);
    expect(enc.iv).toHaveLength(12);
    expect(enc.authTag).toHaveLength(16);
    expect(Buffer.from(enc.ciphertext).toString("hex")).not.toContain(privateKey.slice(2));
    const back = decryptSessionKey(enc, "plan-1", key);
    expect(back).toBe(privateKey);
    expect(privateKeyToAccount(back).publicKey).toBe(publicKey);
  });

  it("uses a fresh IV each time", () => {
    const { privateKey } = generateSessionKey();
    const a = encryptSessionKey(privateKey, "p", key);
    const b = encryptSessionKey(privateKey, "p", key);
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
  });

  it("refuses a ciphertext moved to another plan, a wrong key, or tampering", () => {
    const { privateKey } = generateSessionKey();
    const enc = encryptSessionKey(privateKey, "plan-1", key);
    expect(() => decryptSessionKey(enc, "plan-2", key)).toThrow();
    expect(() => decryptSessionKey(enc, "plan-1", randomBytes(32))).toThrow();
    const tampered = { ...enc, ciphertext: Buffer.from(enc.ciphertext).map((b, i) => (i === 0 ? b ^ 1 : b)) };
    expect(() => decryptSessionKey(tampered, "plan-1", key)).toThrow();
  });

  it("parses the env key as hex or base64 and rejects other lengths", () => {
    const k = randomBytes(32);
    expect(parseEncryptionKey(k.toString("hex")).equals(k)).toBe(true);
    expect(parseEncryptionKey(k.toString("base64")).equals(k)).toBe(true);
    expect(() => parseEncryptionKey(randomBytes(16).toString("hex"))).toThrow(/32 bytes/);
    expect(() => parseEncryptionKey(undefined)).toThrow(/not set/);
  });
});
