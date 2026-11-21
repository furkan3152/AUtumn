import {
  encodeAbiParameters,
  keccak256,
  padHex,
  type Address,
  type Hex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { Signer } from "@altananetwork/sdk";

/** Key type ids as IthacaAccount stores them. */
export const ACCOUNT_KEY_TYPE_SECP256K1 = 2n;

export type SessionKeyIds = {
  /** SEC1 uncompressed secp256k1 public key, 0x04 || x || y. */
  publicKey: Hex;
  /** The key's EOA-style address. */
  address: Address;
  /** KeyStore id: keccak256(publicKey). Used with `isValidKey`. */
  keyId: Hex;
  /** Account key hash: keccak256(abi.encode(2, keccak256(pad32(address)))). Used with getKey/spendInfos. */
  keyHash: Hex;
};

function assertUncompressedSecp256k1(publicKey: Hex): void {
  if (!/^0x04[0-9a-fA-F]{128}$/.test(publicKey)) {
    throw new Error("session public key must be an uncompressed secp256k1 key (0x04 followed by 64 bytes)");
  }
}

/**
 * Every identifier of a secp256k1 session key, computed locally. Mirrors the
 * SDK's `keyIdForSessionOrKey` / `keyHashForSessionOrKey` (checked in tests).
 */
export function sessionKeyIds(publicKey: Hex): SessionKeyIds {
  assertUncompressedSecp256k1(publicKey);
  const pk = publicKey.toLowerCase() as Hex;
  const address = publicKeyToAddress(pk);
  const keyHash = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }],
      [ACCOUNT_KEY_TYPE_SECP256K1, keccak256(padHex(address, { size: 32 }))],
    ),
  );
  return { publicKey: pk, address, keyId: keccak256(pk), keyHash };
}

/**
 * A Signer that carries only a session's public key, for the browser's
 * `grantSession({ sessionSigner })`. The server generates the session key and
 * gives the browser only its public key; granting needs nothing more (the SDK
 * reads `type`, `address` and `publicKey`). It can never sign: `signDigest`
 * throws, so it cannot be used to execute.
 */
export function sessionSignerFromPublicKey(publicKey: Hex): Signer {
  const { address, publicKey: pk } = sessionKeyIds(publicKey);
  return {
    type: "privateKey",
    address,
    publicKey: pk,
    signDigest: async () => {
      throw new Error("This signer holds only a public key: the session key lives on the Autumn server.");
    },
  };
}
