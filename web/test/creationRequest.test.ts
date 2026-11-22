import { describe, expect, it } from "vitest";
import * as Key from "porto/viem/Key";
import {
  chooseRequestKind,
  isAndroid,
  readPlatformCapabilities,
  selectionCreateFn,
  withAuthenticatorSelection,
  type CreationMode,
  type PlatformCapabilities,
} from "../src/lib/passkey";

/** What porto's Key.createWebAuthnP256 hands ox (porto 0.2.37, ox 0.9.17). */
function portoCreationOptions(): CredentialCreationOptions {
  return {
    publicKey: {
      attestation: "none",
      authenticatorSelection: { requireResidentKey: true, residentKey: "required", userVerification: "required" },
      challenge: new Uint8Array(32).fill(9),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      extensions: { credProps: true },
      rp: { id: "autumn.example", name: "autumn.example" },
      user: { id: new Uint8Array(20).fill(0xab), name: "Autumn", displayName: "Autumn" },
    },
  };
}

const PREFERRED = { residentKey: "preferred", requireResidentKey: false, userVerification: "required" };
const DEVICE = { residentKey: "discouraged", requireResidentKey: false, authenticatorAttachment: "platform", userVerification: "required" };

/** The authenticatorSelection actually sent for a mode and what the browser reports. */
function selectionSent(mode: CreationMode, caps: PlatformCapabilities) {
  return withAuthenticatorSelection(portoCreationOptions(), chooseRequestKind(mode, caps)).publicKey!.authenticatorSelection;
}

describe("creation request by capability", () => {
  it("passkey provider available: residentKey preferred", () => {
    expect(selectionSent("auto", { passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true })).toEqual(PREFERRED);
    expect(selectionSent("auto", { passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: false })).toEqual(PREFERRED);
  });

  it("no passkey provider but a user-verifying platform authenticator: device-bound platform request", () => {
    expect(selectionSent("auto", { passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: true })).toEqual(DEVICE);
  });

  it("no passkey provider and no (or unknown) platform authenticator: preferred", () => {
    expect(selectionSent("auto", { passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: false })).toEqual(PREFERRED);
    expect(selectionSent("auto", { passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: undefined })).toEqual(PREFERRED);
  });

  it("capabilities unknown: preferred", () => {
    expect(selectionSent("auto", { passkeyPlatformAuthenticator: undefined, userVerifyingPlatformAuthenticator: true })).toEqual(PREFERRED);
    expect(selectionSent("auto", { passkeyPlatformAuthenticator: undefined, userVerifyingPlatformAuthenticator: undefined })).toEqual(PREFERRED);
  });

  it("Android: device-bound by default even when a passkey provider is reported, preferred when the owner asks for a synced passkey", () => {
    const reported = { passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true };
    const sent = (mode: CreationMode) =>
      withAuthenticatorSelection(portoCreationOptions(), chooseRequestKind(mode, reported, { android: true })).publicKey!.authenticatorSelection;
    expect(sent("auto")).toEqual(DEVICE);
    expect(sent("device")).toEqual(DEVICE);
    expect(sent("synced")).toEqual(PREFERRED);
    expect(isAndroid("Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36")).toBe(true);
    expect(isAndroid("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe(false);
  });

  it("forced device mode: device-bound platform request whatever is reported", () => {
    for (const caps of [
      { passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true },
      { passkeyPlatformAuthenticator: undefined, userVerifyingPlatformAuthenticator: undefined },
      { passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: false },
    ]) {
      expect(selectionSent("device", caps)).toEqual(DEVICE);
    }
  });

  it("device mode changes only authenticatorSelection", () => {
    const original = portoCreationOptions();
    const { authenticatorSelection: _a, ...rest } = withAuthenticatorSelection(original, "device").publicKey!;
    const { authenticatorSelection: origSel, ...origRest } = original.publicKey!;
    expect(rest).toEqual(origRest);
    expect(rest.user.id).toBe(origRest.user.id);
    expect(origSel).toEqual({ requireResidentKey: true, residentKey: "required", userVerification: "required" });
  });
});

describe("readPlatformCapabilities", () => {
  it("reads passkeyPlatformAuthenticator and prefers isUserVerifyingPlatformAuthenticatorAvailable", async () => {
    await expect(
      readPlatformCapabilities({
        getClientCapabilities: async () => ({ passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: false }),
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      }),
    ).resolves.toEqual({ passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: true });
  });

  it("missing keys, missing methods and rejections are unknown", async () => {
    await expect(readPlatformCapabilities({ getClientCapabilities: async () => ({}) })).resolves.toEqual({
      passkeyPlatformAuthenticator: undefined,
      userVerifyingPlatformAuthenticator: undefined,
    });
    await expect(readPlatformCapabilities(undefined)).resolves.toEqual({ passkeyPlatformAuthenticator: undefined, userVerifyingPlatformAuthenticator: undefined });
    await expect(
      readPlatformCapabilities({
        getClientCapabilities: () => Promise.reject(new Error("SecurityError")),
        isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.reject(new Error("x")),
      }),
    ).resolves.toEqual({ passkeyPlatformAuthenticator: undefined, userVerifyingPlatformAuthenticator: undefined });
  });

  it("falls back to the userVerifyingPlatformAuthenticator key without the older method", async () => {
    await expect(readPlatformCapabilities({ getClientCapabilities: async () => ({ passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: true }) })).resolves.toEqual(
      { passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: true },
    );
  });
});

describe("selectionCreateFn", () => {
  const cred = (rk: boolean | undefined) =>
    ({ id: "abc", type: "public-key", getClientExtensionResults: () => (rk === undefined ? {} : { credProps: { rk } }) }) as unknown as Credential;

  it("device mode: not discoverable unless credProps says rk true", async () => {
    for (const [rk, expected] of [
      [undefined, false],
      [false, false],
      [true, true],
    ] as const) {
      let reported: unknown;
      await selectionCreateFn(async () => cred(rk), "device", (d) => (reported = d))(portoCreationOptions());
      expect(reported).toBe(expected);
    }
  });

  it("preferred mode keeps unknown as unknown", async () => {
    let reported: unknown;
    await selectionCreateFn(async () => cred(undefined), "preferred", (d) => (reported = d))(portoCreationOptions());
    expect(reported).toBe("unknown");
  });

  it("is what porto's Key.createWebAuthnP256 sends in device mode", async () => {
    let seen: CredentialCreationOptions | undefined;
    const fn = selectionCreateFn(async (o) => {
      seen = o;
      throw Object.assign(new Error("stop here"), { name: "NotAllowedError" });
    }, "device", () => {});
    await Key.createWebAuthnP256({ label: "Autumn", role: "admin", rpId: "autumn.example", userId: new Uint8Array(20).fill(0x11), createFn: fn as never }).catch(() => {});
    expect(seen!.publicKey!.authenticatorSelection).toEqual(DEVICE);
    expect(seen!.publicKey!.extensions).toEqual({ credProps: true });
  });
});
