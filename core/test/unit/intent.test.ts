import { describe, expect, it } from "vitest";
import { fromDataSuffix } from "@celo/attribution-tags";
import { decodeAbiParameters, decodeFunctionData, getAddress, size, slice, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ATTRIBUTION_SUFFIX, buildBuyCalls } from "../../src/calls.js";
import { ATTRIBUTION_CODE } from "../../src/constants.js";
import { DirectSubmitError, explainAltanaError } from "../../src/errors.js";
import {
  ALTANA_ACCOUNT_IMPLEMENTATION,
  buildSessionIntent,
  directLaneSeqKey,
  DIRECT_LANE_PREFIX,
  encodeIntent,
  executeCalldata,
  INTENT_ABI_PARAMETER,
  intentDigest,
  intentErrorName,
  laneNonce,
  orchestratorAbi,
  sdkLaneSeqKey,
  wrapKeySignature,
  type Intent,
} from "../../src/intent.js";
import { sessionKeyIds } from "../../src/keys.js";

const GB = "0x1111111111111111111111111111111111111111" as Address;
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const session = sessionKeyIds(privateKeyToAccount(generatePrivateKey()).publicKey);

function intent(): { intent: Intent; calls: ReturnType<typeof buildBuyCalls> } {
  const calls = buildBuyCalls(5_000_000n, 1_393n, GB);
  const nonce = laneNonce(directLaneSeqKey(session.keyHash), 0n);
  return { ...buildSessionIntent({ wallet: WALLET, calls, nonce, combinedGas: 400_000n, expiry: 1_800_000_000n }), calls };
}

describe("direct-submit intents", () => {
  it("never shares a nonce lane with the SDK, and never uses the multichain prefix", () => {
    const ours = directLaneSeqKey(session.keyHash);
    expect(ours >> 176n).toBe(DIRECT_LANE_PREFIX);
    expect(sdkLaneSeqKey(session.keyHash) >> 176n).toBe(0xa17an);
    expect(ours).not.toBe(sdkLaneSeqKey(session.keyHash));
    expect(ours < 1n << 192n).toBe(true);
    expect(laneNonce(ours, 7n) >> 64n).toBe(ours);
    expect(laneNonce(ours, 7n) & ((1n << 64n) - 1n)).toBe(7n);
  });

  it("signs no payment and pins the account implementation", () => {
    const { intent: i } = intent();
    expect(i.paymentMaxAmount).toBe(0n);
    expect(i.paymentAmount).toBe(0n);
    expect(i.payer).toBe("0x0000000000000000000000000000000000000000");
    expect(i.supportedAccountImplementation).toBe(ALTANA_ACCOUNT_IMPLEMENTATION);
    expect(i.encodedPreCalls).toEqual([]);
    expect(i.isMultichain).toBe(false);
  });

  it("refuses intents that could be replayed forever or across chains", () => {
    const calls = buildBuyCalls(5_000_000n, 1n, GB);
    expect(() => buildSessionIntent({ wallet: WALLET, calls, nonce: 0n, combinedGas: 1n, expiry: 0n })).toThrow(/expiry/);
    expect(() => buildSessionIntent({ wallet: WALLET, calls, nonce: 0xc1d0n << 240n, combinedGas: 1n, expiry: 1n })).toThrow(/multichain/);
  });

  it("puts the ERC-8021 tag at the very end of the outer calldata, after the ABI-encoded intent", () => {
    const { intent: i } = intent();
    i.signature = wrapKeySignature(`0x${"ab".repeat(65)}`, session.keyHash);
    const data = executeCalldata(i);
    expect(fromDataSuffix(data)?.codes).toEqual([ATTRIBUTION_CODE]);
    const body = slice(data, 0, size(data) - size(ATTRIBUTION_SUFFIX));
    expect(body).toBe(executeCalldata(i, null));
    // The ABI decoder reads the argument by offset and length; the suffix is not part of it.
    const { args } = decodeFunctionData({ abi: orchestratorAbi, data });
    expect(args[0]).toBe(encodeIntent(i));
    const [decoded] = decodeAbiParameters([INTENT_ABI_PARAMETER], args[0] as Hex);
    expect(decoded.signature).toBe(i.signature);
  });

  it("wraps a session signature as inner ‖ keyHash ‖ prehash", () => {
    const w = wrapKeySignature(`0x${"cd".repeat(65)}`, session.keyHash);
    expect(size(w)).toBe(98);
    expect(slice(w, 65, 97)).toBe(session.keyHash);
    expect(slice(w, 97)).toBe("0x00");
  });

  it("the digest commits to every signed field and to nothing the filler may change", () => {
    const { intent: i, calls } = intent();
    const d = intentDigest({ ...i, calls });
    expect(intentDigest({ ...i, calls, paymentAmount: 5n, paymentRecipient: GB, signature: "0x01", supportedAccountImplementation: GB })).toBe(d);
    expect(intentDigest({ ...i, calls, paymentMaxAmount: 1n })).not.toBe(d);
    expect(intentDigest({ ...i, calls, combinedGas: i.combinedGas + 1n })).not.toBe(d);
    expect(intentDigest({ ...i, calls, expiry: i.expiry + 1n })).not.toBe(d);
    expect(intentDigest({ ...i, calls, nonce: i.nonce + 1n })).not.toBe(d);
    expect(intentDigest({ ...i, calls: buildBuyCalls(5_000_000n, 1_394n, GB) })).not.toBe(d);
    expect(intentDigest({ ...i, calls }, { chainId: 11142220 })).not.toBe(d);
  });

  it("names the error selectors an intent reports", () => {
    expect(intentErrorName("0x9054c912")).toBe("ExceededSpendLimit");
    expect(intentErrorName("0xfbcb0b34")).toBe("VerificationError");
    expect(intentErrorName("0x756688fe")).toBe("InvalidNonce");
    expect(intentErrorName("0x00000000")).toBeUndefined();
  });

  it("maps a DirectSubmitError by its own kind and outcome, with its own message", () => {
    const e = new DirectSubmitError("The agent's gas account is empty.", "relay_failure", "no");
    expect(explainAltanaError(e)).toMatchObject({ kind: "relay_failure", bought: "no", message: "The agent's gas account is empty.", code: "direct_submit" });
    expect(explainAltanaError(new DirectSubmitError("x", "session_ended", "no"))).toMatchObject({ stopsPlan: true });
    expect(explainAltanaError(new DirectSubmitError("x", "relay_failure", "unknown")).bought).toBe("unknown");
  });
});
