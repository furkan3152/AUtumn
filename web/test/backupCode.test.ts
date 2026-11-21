import { describe, expect, it } from "vitest";
import * as Key from "porto/viem/Key";
import * as PublicKey from "ox/PublicKey";
import {
  BACKUP_CODE_PREFIX,
  BackupCodeError,
  base64UrlToBytes,
  bytesToBase64Url,
  decodeBackupCode,
  encodeBackupCode,
  webAuthnKeyHash,
  type BackupData,
} from "../src/lib/backupCode";

const data: BackupData = {
  wallet: "0x3CE7ba69E7D85a6C4509FE1779B9864086e51cDF",
  // A 64-byte id, about the size Android produces for a non-discoverable credential.
  credentialId: bytesToBase64Url(Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff)),
  publicKey: "0xa8fd8e83458ce2815bb3a71727205991f98ce7cac27ae723969ab11e3834f6d386831084a0e01624c8a33181ae10a7f2a76c02344410a1b2589af04b1904be43",
  rpId: "autumn.example",
  discoverable: false,
};

describe("backup code", () => {
  it("round-trips every field", () => {
    const code = encodeBackupCode(data);
    expect(code.startsWith(BACKUP_CODE_PREFIX)).toBe(true);
    expect(code).toMatch(/^autumn1-[A-Za-z0-9_-]+$/);
    expect(decodeBackupCode(code)).toEqual(data);
    for (const discoverable of [true, false, "unknown"] as const) {
      expect(decodeBackupCode(encodeBackupCode({ ...data, discoverable })).discoverable).toBe(discoverable);
    }
  });

  it("is compact: about 230 characters for a 64-byte credential id", () => {
    expect(encodeBackupCode(data).length).toBeLessThan(240);
  });

  it("ignores spaces and line breaks from copying", () => {
    const code = encodeBackupCode(data);
    const wrapped = `  ${code.slice(0, 50)}\n${code.slice(50, 120)} \r\n${code.slice(120)}  `;
    expect(decodeBackupCode(wrapped)).toEqual(data);
  });

  it("refuses any single changed character (checksum)", () => {
    const code = encodeBackupCode(data);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let refused = 0;
    let total = 0;
    for (let i = BACKUP_CODE_PREFIX.length; i < code.length; i++) {
      const c = code[i]!;
      const other = alphabet[(alphabet.indexOf(c) + 17) % 64]!;
      const tampered = code.slice(0, i) + other + code.slice(i + 1);
      total++;
      try {
        const d = decodeBackupCode(tampered);
        // Only the last character's unused low bits can change without changing a byte.
        expect(d).toEqual(data);
      } catch (e) {
        expect(e).toBeInstanceOf(BackupCodeError);
        refused++;
      }
    }
    expect(refused).toBeGreaterThanOrEqual(total - 1);
  });

  it("refuses a truncated or extended code", () => {
    const code = encodeBackupCode(data);
    expect(() => decodeBackupCode(code.slice(0, -1))).toThrow(BackupCodeError);
    expect(() => decodeBackupCode(code.slice(0, 40))).toThrow(/incomplete|check out/);
    expect(() => decodeBackupCode(code + "AA")).toThrow(BackupCodeError);
  });

  it("names the problem for foreign text and other versions", () => {
    expect(() => decodeBackupCode("hello")).toThrow(/not an Autumn wallet backup code/);
    expect(() => decodeBackupCode("autumn2-AAAA")).toThrow(/version/);
    expect(() => decodeBackupCode("autumn1-!!!!")).toThrow(/characters/);
  });

  it("keeps the rpId so a code for another domain can be refused", () => {
    const other = decodeBackupCode(encodeBackupCode({ ...data, rpId: "localhost" }));
    expect(other.rpId).toBe("localhost");
    expect(other.rpId).not.toBe(data.rpId);
  });

  it("refuses malformed input when encoding", () => {
    expect(() => encodeBackupCode({ ...data, publicKey: "0x04" })).toThrow();
    expect(() => encodeBackupCode({ ...data, wallet: "0x12" as never })).toThrow();
    expect(() => encodeBackupCode({ ...data, rpId: "https://x" })).toThrow();
    expect(() => encodeBackupCode({ ...data, credentialId: "" })).toThrow();
  });

  it("base64url round-trips bytes", () => {
    for (let n = 0; n < 70; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 91 + n) & 0xff);
      expect(Array.from(base64UrlToBytes(bytesToBase64Url(b)))).toEqual(Array.from(b));
    }
  });
});

describe("webAuthnKeyHash", () => {
  it("matches porto's key hash for a webauthn-p256 key", () => {
    const key = Key.fromWebAuthnP256({
      credential: { id: "abc", publicKey: PublicKey.fromHex(`0x04${data.publicKey.slice(2)}`) },
      rpId: "autumn.example",
      role: "admin",
    });
    expect(webAuthnKeyHash(data.publicKey)).toBe(key.hash);
  });

  it("matches the hash Altana's relay reported for this admin key (testnet wallet_getKeys)", () => {
    expect(webAuthnKeyHash(data.publicKey)).toBe("0x70f61686647ff21667014b7e4964c3d822828ea71dd2fc40528b2d3682500be9");
  });
});
