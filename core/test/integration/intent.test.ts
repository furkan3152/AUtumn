/**
 * Read-only: checks the intent encoding and digest in src/intent.ts against a
 * real Altana relay transaction on Celo mainnet. Sends nothing.
 *
 * Tx 0x37c107db… (block 83,378,101) is a session-key intent another builder
 * sent through the Altana relay (docs/altana-spike/RESULTS.md section 7). If
 * our struct layout, EIP-712 types and domain are right, then decoding its
 * calldata and recomputing the digest recovers the session key's address,
 * whose key hash is the one the signature carries.
 */
import { describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  padHex,
  recoverAddress,
  size,
  slice,
  type Hex,
} from "viem";
import { createCeloPublicClient } from "../../src/client.js";
import { ALTANA_ORCHESTRATOR } from "../../src/constants.js";
import {
  ALTANA_ACCOUNT_IMPLEMENTATION,
  encodeExecutionData,
  encodeIntent,
  INTENT_ABI_PARAMETER,
  intentDigest,
  orchestratorAbi,
  type Intent,
} from "../../src/intent.js";

const client = createCeloPublicClient(process.env.AUTUMN_CELO_RPC_URL);
const RELAY_TX = "0x37c107dbe9efcfa20ffe56d179045c2ac29dae9cd16d16f094bcf3c4355513db" as const;

describe("intent encoding against a real relay transaction", () => {
  it("the Orchestrator's EIP-712 domain is (Orchestrator, 0.5.5, 42220, itself)", async () => {
    const d = await client.readContract({ address: ALTANA_ORCHESTRATOR, abi: orchestratorAbi, functionName: "eip712Domain" });
    expect(d[1]).toBe("Orchestrator");
    expect(d[2]).toBe("0.5.5");
    expect(d[3]).toBe(42220n);
    expect(d[4].toLowerCase()).toBe(ALTANA_ORCHESTRATOR.toLowerCase());
  });

  it("the pinned Orchestrator is the account implementation's own ORCHESTRATOR() (the session allowlist entry's target)", async () => {
    const orch = await client.readContract({
      address: ALTANA_ACCOUNT_IMPLEMENTATION,
      abi: [{ type: "function", name: "ORCHESTRATOR", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const,
      functionName: "ORCHESTRATOR",
    });
    expect(orch).toBe(ALTANA_ORCHESTRATOR);
  });

  it("decodes, re-encodes byte for byte, and the recomputed digest recovers the signing session key", async () => {
    const tx = await client.getTransaction({ hash: RELAY_TX });
    expect(tx.to?.toLowerCase()).toBe(ALTANA_ORCHESTRATOR.toLowerCase());
    const { functionName, args } = decodeFunctionData({ abi: orchestratorAbi, data: tx.input });
    expect(functionName).toBe("execute");
    const encoded = args[0] as Hex;
    const [intent] = decodeAbiParameters([INTENT_ABI_PARAMETER], encoded) as unknown as [Intent];

    // Layout: our encoder reproduces the relay's bytes exactly.
    expect(encodeIntent(intent)).toBe(encoded);

    // executionData is abi.encode(Call[]).
    const [calls] = decodeAbiParameters(
      [{ type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }],
      intent.executionData,
    );
    expect(encodeExecutionData(calls)).toBe(intent.executionData);

    // Relay intents pay the relay: unsigned fields the filler chose.
    expect(intent.paymentAmount).toBeGreaterThan(0n);
    expect(intent.paymentAmount <= intent.paymentMaxAmount).toBe(true);

    // Signature = inner (65) ‖ keyHash (32) ‖ prehash (1).
    const sig = intent.signature;
    expect(size(sig)).toBe(98);
    const inner = slice(sig, 0, 65);
    const keyHash = slice(sig, 65, 97);
    expect(slice(sig, 97)).toBe("0x00");

    const digest = intentDigest({ ...intent, calls });
    const signer = await recoverAddress({ hash: digest, signature: inner });
    // A secp256k1 key's account keyHash: keccak256(abi.encode(uint8(2), keccak256(pad32(address)))).
    const expected = keccak256(
      encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [2, keccak256(padHex(signer, { size: 32 }))]),
    );
    expect(expected).toBe(keyHash);
  });
});
