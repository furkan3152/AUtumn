/**
 * The wallet backup code.
 *
 * WHAT IT IS: a short text holding the public facts needed to use this
 * wallet's passkey again on the SAME device after the browser's site data is
 * cleared: the wallet address, the passkey's credential id, its public key
 * and the relying-party id (the domain the passkey belongs to). It is
 * versioned and checksummed so a mistyped or truncated code is refused.
 *
 * WHAT IT IS NOT: it contains no private key and no secret. Anyone who reads
 * it learns the wallet address and the passkey's public key, which are public
 * onchain anyway once the wallet has transacted. It cannot sign or move
 * anything. It only lets this app ask the device for the passkey by its id.
 *
 * Why it exists: on some phones (Android devices where Google Password
 * Manager cannot store a discoverable passkey) the passkey is created
 * "non-discoverable": the device will only use it when the site names its
 * credential id, and it cannot be found from the passkey alone. Autumn keeps
 * that id in the browser (localStorage and IndexedDB). If both are cleared,
 * the backup code is the only way to name the passkey again.
 *
 * LIMITS: the code works only on the device that holds the passkey. If the
 * device is reset or the passkey is deleted, the wallet cannot sign again and
 * its funds are lost; no code can help. Keep small amounts only, and use
 * "Send out" to move funds to an address you control.
 *
 * Layout (version 1), then base64url with the prefix `autumn1-`:
 *   version u8 = 1 | flags u8 | address 20 bytes | public key 64 bytes (P-256 x‖y)
 *   | credential id length u16 BE | credential id | rpId length u8 | rpId (ASCII)
 *   | checksum: first 4 bytes of SHA-256 over everything before it
 * flags: bit 0 = discoverability known, bit 1 = discoverable.
 */
import { encodeAbiParameters, getAddress, keccak256, sha256, type Hex } from "viem";
import type { Address } from "./autumn";
import type { Discoverable } from "./passkey";

export const BACKUP_CODE_PREFIX = "autumn1-";
const VERSION = 1;
const CHECKSUM_BYTES = 4;
const MAX_CREDENTIAL_ID_BYTES = 1023; // WebAuthn's limit

export type BackupData = {
  wallet: Address;
  /** WebAuthn credential id, base64url (PublicKeyCredential.id). */
  credentialId: string;
  /** Flat P-256 public key x‖y, 0x-prefixed, 64 bytes. */
  publicKey: Hex;
  rpId: string;
  discoverable: Discoverable;
};

export class BackupCodeError extends Error {
  readonly name = "BackupCodeError";
}

/**
 * A backup code whose passkey belongs to another host this deployment serves: its passkey can only be used
 * there, so no passkey call is made here. `url` is the address where the wallet opens.
 */
export class WrongDoorError extends Error {
  readonly name = "WrongDoorError";
  constructor(
    readonly host: string,
    readonly url: string,
  ) {
    super(`This wallet was made at ${host}. Open it there.`);
  }
}

/* ---------- base64url ---------- */

export function base64UrlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new BackupCodeError("not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const hexToBytes = (hex: string) => {
  const h = hex.slice(2);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const checksum = (b: Uint8Array) => hexToBytes(sha256(b)).slice(0, CHECKSUM_BYTES);

/* ---------- encode / decode ---------- */

export function encodeBackupCode(d: BackupData): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(d.wallet)) throw new BackupCodeError("The wallet address is malformed.");
  if (!/^0x[0-9a-fA-F]{128}$/.test(d.publicKey)) throw new BackupCodeError("The passkey public key must be 64 bytes.");
  if (!/^[a-z0-9.-]{1,253}$/.test(d.rpId)) throw new BackupCodeError("The passkey domain is malformed.");
  const cred = base64UrlToBytes(d.credentialId);
  if (cred.length === 0 || cred.length > MAX_CREDENTIAL_ID_BYTES) throw new BackupCodeError("The passkey credential id is malformed.");
  const rp = new TextEncoder().encode(d.rpId);
  const flags = d.discoverable === "unknown" ? 0 : d.discoverable ? 0b11 : 0b01;
  const body = new Uint8Array(2 + 20 + 64 + 2 + cred.length + 1 + rp.length);
  let o = 0;
  body[o++] = VERSION;
  body[o++] = flags;
  body.set(hexToBytes(d.wallet), o);
  o += 20;
  body.set(hexToBytes(d.publicKey), o);
  o += 64;
  body[o++] = cred.length >> 8;
  body[o++] = cred.length & 0xff;
  body.set(cred, o);
  o += cred.length;
  body[o++] = rp.length;
  body.set(rp, o);
  const all = new Uint8Array(body.length + CHECKSUM_BYTES);
  all.set(body);
  all.set(checksum(body), body.length);
  return BACKUP_CODE_PREFIX + bytesToBase64Url(all);
}

/** Parses a backup code. Spaces and line breaks are ignored. Throws BackupCodeError with a plain sentence. */
export function decodeBackupCode(input: string): BackupData {
  const text = input.replace(/\s+/g, "");
  if (!text.toLowerCase().startsWith(BACKUP_CODE_PREFIX.slice(0, 6))) throw new BackupCodeError("This is not an Autumn wallet backup code.");
  const damaged = "This backup code is damaged or was changed (its letters are case-sensitive). Paste it exactly as you saved it.";
  // The code is case-sensitive base64url: "AUTUMN1-…" is the right code with its letters changed, not another version.
  if (!text.startsWith(BACKUP_CODE_PREFIX)) {
    if (text.toLowerCase().startsWith(BACKUP_CODE_PREFIX) || !/^autumn\d+-/.test(text)) throw new BackupCodeError(damaged);
    throw new BackupCodeError("This backup code is from a version of Autumn this app does not read.");
  }
  let all: Uint8Array;
  try {
    all = base64UrlToBytes(text.slice(BACKUP_CODE_PREFIX.length));
  } catch {
    throw new BackupCodeError("The backup code contains characters that do not belong in it. Copy it again.");
  }
  const tooShort = new BackupCodeError("The backup code is incomplete. Copy all of it.");
  if (all.length < 2 + 20 + 64 + 2 + 1 + 1 + CHECKSUM_BYTES) throw tooShort;
  const body = all.slice(0, all.length - CHECKSUM_BYTES);
  const sum = all.slice(all.length - CHECKSUM_BYTES);
  if (!checksum(body).every((b, i) => b === sum[i])) throw new BackupCodeError(damaged);
  let o = 0;
  if (body[o++] !== VERSION) throw new BackupCodeError("This backup code is from a version of Autumn this app does not read.");
  const flags = body[o++]!;
  const wallet = getAddress(bytesToHex(body.slice(o, o + 20)));
  o += 20;
  const publicKey = bytesToHex(body.slice(o, o + 64));
  o += 64;
  const credLen = (body[o]! << 8) | body[o + 1]!;
  o += 2;
  if (credLen === 0 || credLen > MAX_CREDENTIAL_ID_BYTES || o + credLen + 1 > body.length) throw tooShort;
  const credentialId = bytesToBase64Url(body.slice(o, o + credLen));
  o += credLen;
  const rpLen = body[o++]!;
  if (o + rpLen !== body.length || rpLen === 0) throw tooShort;
  const rpId = new TextDecoder().decode(body.slice(o, o + rpLen));
  if (!/^[a-z0-9.-]{1,253}$/.test(rpId)) throw new BackupCodeError("The backup code names a malformed passkey domain.");
  const discoverable: Discoverable = flags & 0b01 ? (flags & 0b10) !== 0 : "unknown";
  return { wallet, credentialId, publicKey, rpId, discoverable };
}

/**
 * The account key hash of a WebAuthn P-256 key, as the Altana account
 * (IthacaAccount) and porto compute it: keccak256(abi.encode(uint8 1, keccak256(publicKey))).
 * `getKey(keyHash)` on the wallet returns the key when the wallet holds it.
 */
export function webAuthnKeyHash(publicKey: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{128}$/.test(publicKey)) throw new Error("A P-256 public key is 64 bytes (x‖y).");
  return keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [1, keccak256(publicKey.toLowerCase() as Hex)]));
}
