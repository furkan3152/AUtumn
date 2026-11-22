/**
 * Celo's own checker (`verifyTx` from @celo/attribution-tags, re-exported by
 * src/attribution.ts) on the outer calldata our builder produces, next to the
 * credited mainnet transactions of other teams and our relay-sent one
 * (core/test/fixtures/relay-prepared-intents.json). `verifyTx` reads only
 * `tx.input`, so a client that returns the input is all it needs.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionData, getAddress, size, slice, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fromDataSuffix, verifyTx } from "../../src/attribution.js";
import { ATTRIBUTION_SUFFIX, buildBuyCalls } from "../../src/calls.js";
import { ATTRIBUTION_CODE } from "../../src/constants.js";
import { buildSessionIntent, directLaneSeqKey, executeCalldata, laneNonce, orchestratorAbi, wrapKeySignature } from "../../src/intent.js";
import { sessionKeyIds } from "../../src/keys.js";
import { parsePreparedCalls } from "../../src/prepared.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/relay-prepared-intents.json", import.meta.url), "utf8")) as {
  prepareCalls: { result: { context: { quote: { quotes: { intent: Record<string, unknown> }[] } } } };
  mainnetIntents: { hash: Hex; from: Address; input: Hex; intent: Record<string, unknown>; note: string }[];
};
const clientFor = (input: Hex) => ({ getTransaction: async () => ({ input }) }) as never;
const check = (input: Hex) => verifyTx({ client: clientFor(input), hash: `0x${"00".repeat(32)}` });
const EXECUTE = toFunctionSelector("execute(bytes)");

/** The tail Celo reads: code, 1-byte codes length, 1-byte schema id, 16-byte ERC-8021 marker. */
function tailLayout(input: Hex) {
  const t = slice(input, size(input) - 35);
  return { codesLength: slice(t, 17, 18), schemaId: slice(t, 18, 19), marker: slice(t, 19) };
}
/** The calldata without the 35-byte tag re-encodes to itself: the tag sits after the ABI-encoded intent, nothing else does. */
function abiPartIsExact(input: Hex): boolean {
  const body = slice(input, 0, size(input) - 35);
  const { args } = decodeFunctionData({ abi: orchestratorAbi, data: body });
  return encodeFunctionData({ abi: orchestratorAbi, functionName: "execute", args: [args[0] as Hex] }) === body;
}

describe("Celo's verifyTx on Orchestrator.execute calldata", () => {
  const session = sessionKeyIds(privateKeyToAccount(generatePrivateKey()).publicKey);
  const wallet = getAddress("0x2222222222222222222222222222222222222222");
  const calls = buildBuyCalls(1_000_000n, 280n, "0x1111111111111111111111111111111111111111");

  it("credits the direct builder's calldata, laid out exactly like the credited teams' transactions", async () => {
    const { intent } = buildSessionIntent({ wallet, calls, nonce: laneNonce(directLaneSeqKey(session.keyHash), 0n), combinedGas: 450_000n, expiry: 1_800_000_000n });
    intent.signature = wrapKeySignature(`0x${"ab".repeat(65)}`, session.keyHash);
    const ours = executeCalldata(intent);
    expect(await check(ours)).toEqual({ codes: [ATTRIBUTION_CODE], schemaId: 0 });
    expect(fromDataSuffix(ours)).toEqual({ codes: [ATTRIBUTION_CODE], schemaId: 0 });
    expect(ours.slice(0, 10)).toBe(EXECUTE);
    expect(abiPartIsExact(ours)).toBe(true);
    // Without the tag (what the relay sends), Celo finds nothing.
    expect(await check(executeCalldata(intent, null))).toBeNull();

    const credited = fixture.mainnetIntents.filter((m) => m.note.startsWith("credited"));
    expect(credited).toHaveLength(4);
    for (const m of credited) {
      const r = await check(m.input);
      expect(r?.codes).toHaveLength(1);
      expect(r?.codes[0]).toMatch(/^celo_[0-9a-f]{12}$/);
      expect(m.input.slice(0, 10)).toBe(EXECUTE);
      expect(size(m.input) - 35 - 4).toBeGreaterThan(0);
      expect(abiPartIsExact(m.input)).toBe(true);
      expect(tailLayout(m.input)).toEqual(tailLayout(ours));
    }
  });

  it("credits the relay-prepared intent signed and sent by us, and not the same intent sent by the relay", async () => {
    const relaySent = fixture.mainnetIntents.find((m) => m.hash.startsWith("0xe6f4"))!;
    expect(await check(relaySent.input)).toBeNull();
    // The same intent, as executeCalldata builds it for direct-prepared: the relay's fields plus the signature, then the tag.
    const answer = structuredClone(fixture.prepareCalls.result);
    answer.context.quote.quotes[0]!.intent = { ...relaySent.intent };
    const { intent } = parsePreparedCalls(answer);
    const data = executeCalldata(intent);
    expect(slice(data, 0, size(data) - 35)).toBe(relaySent.input.toLowerCase());
    expect(slice(data, size(data) - 35)).toBe(ATTRIBUTION_SUFFIX.toLowerCase());
    expect(await check(data)).toEqual({ codes: [ATTRIBUTION_CODE], schemaId: 0 });
  });
});
