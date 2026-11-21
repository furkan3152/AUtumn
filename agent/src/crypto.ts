import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { EncryptedKey } from "./types.js";

/**
 * Session private keys at rest: AES-256-GCM, a fresh 96-bit IV per key, and
 * the plan id bound as additional authenticated data so a ciphertext cannot be
 * moved to another plan's row.
 */

export const KEY_VERSION = 1;

/** Parses the 32-byte key from env: 64 hex chars or base64. */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("AUTUMN_KEY_ENCRYPTION_KEY is not set");
  const trimmed = raw.trim();
  const buf = /^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed.replace(/^0x/, ""), "hex")
    : Buffer.from(trimmed, "base64");
  if (buf.length !== 32) throw new Error("AUTUMN_KEY_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)");
  return buf;
}

function aad(planId: string): Buffer {
  return Buffer.from(`autumn:session-key:v${KEY_VERSION}:${planId}`, "utf8");
}

export function encryptSessionKey(privateKey: Hex, planId: string, key: Buffer): EncryptedKey {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("not a 32-byte private key");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(planId));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: KEY_VERSION };
}

export function decryptSessionKey(enc: EncryptedKey, planId: string, key: Buffer): Hex {
  if (enc.keyVersion !== KEY_VERSION) throw new Error(`unsupported session key version ${enc.keyVersion}`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv));
  decipher.setAAD(aad(planId));
  decipher.setAuthTag(Buffer.from(enc.authTag));
  const plain = Buffer.concat([decipher.update(Buffer.from(enc.ciphertext)), decipher.final()]);
  if (plain.length !== 32) throw new Error("decrypted session key has the wrong length");
  return `0x${plain.toString("hex")}` as Hex;
}

/** A fresh secp256k1 session key pair. Only the public key ever leaves the server. */
export function generateSessionKey(): { privateKey: Hex; publicKey: Hex } {
  const privateKey = generatePrivateKey();
  return { privateKey, publicKey: privateKeyToAccount(privateKey).publicKey };
}
