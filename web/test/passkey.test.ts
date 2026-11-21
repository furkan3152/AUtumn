import { describe, expect, it } from "vitest";
import * as Key from "porto/viem/Key";
import * as PublicKey from "ox/PublicKey";
import {
  AUTUMN_AUTHENTICATOR_SELECTION,
  PasskeyError,
  discoverableFrom,
  passkeyFailure,
  preferredResidentKeyCreateFn,
  userHandleFillingGetFn,
  withPreferredResidentKey,
} from "../src/lib/passkey";

/** Exactly what porto's Key.createWebAuthnP256 hands ox, after ox's getCredentialCreationOptions (porto 0.2.37, ox 0.9.17). */
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

const fakeCredential = (rk: boolean | undefined) =>
  ({ id: "abc", type: "public-key", getClientExtensionResults: () => (rk === undefined ? {} : { credProps: { rk } }) }) as unknown as Credential;

describe("withPreferredResidentKey", () => {
  it("changes residentKey, requireResidentKey and userVerification and nothing else", () => {
    const original = portoCreationOptions();
    const out = withPreferredResidentKey(original);
    const { authenticatorSelection, ...rest } = out.publicKey!;
    const { authenticatorSelection: origSel, ...origRest } = original.publicKey!;
    expect(authenticatorSelection).toEqual({ residentKey: "preferred", requireResidentKey: false, userVerification: "required" });
    expect(rest).toEqual(origRest);
    // Same object references for the untouched fields (user id = wallet address, challenge, credProps).
    expect(rest.user.id).toBe(origRest.user.id);
    expect(rest.challenge).toBe(origRest.challenge);
    expect(rest.extensions).toEqual({ credProps: true });
    // The caller's options are not mutated.
    expect(origSel).toEqual({ requireResidentKey: true, residentKey: "required", userVerification: "required" });
    expect(AUTUMN_AUTHENTICATOR_SELECTION).toEqual(authenticatorSelection);
  });

  it("keeps other authenticatorSelection fields and top-level options", () => {
    const o = portoCreationOptions();
    o.publicKey!.authenticatorSelection = { ...o.publicKey!.authenticatorSelection, authenticatorAttachment: "platform" };
    const signal = new AbortController().signal;
    const out = withPreferredResidentKey({ ...o, signal });
    expect(out.signal).toBe(signal);
    expect(out.publicKey!.authenticatorSelection).toEqual({
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      requireResidentKey: false,
      userVerification: "required",
    });
  });

  it("refuses options without publicKey", () => {
    expect(() => withPreferredResidentKey(undefined)).toThrow();
  });
});

describe("preferredResidentKeyCreateFn", () => {
  it("passes the changed options to the browser and reports discoverability", async () => {
    let seen: CredentialCreationOptions | undefined;
    let reported: unknown;
    const cred = fakeCredential(false);
    const fn = preferredResidentKeyCreateFn(async (o) => ((seen = o), cred), (d) => (reported = d));
    await expect(fn(portoCreationOptions())).resolves.toBe(cred);
    expect(seen!.publicKey!.authenticatorSelection).toEqual(AUTUMN_AUTHENTICATOR_SELECTION);
    expect(reported).toBe(false);
  });

  it("is what porto's Key.createWebAuthnP256 calls, with porto's own options", async () => {
    let seen: CredentialCreationOptions | undefined;
    const fn = preferredResidentKeyCreateFn(async (o) => {
      seen = o;
      throw Object.assign(new Error("stop here"), { name: "NotAllowedError" });
    }, () => {});
    const userId = new Uint8Array(20).fill(0x11);
    const err = await Key.createWebAuthnP256({ label: "Autumn", role: "admin", rpId: "autumn.example", userId, createFn: fn as never }).catch((e) => e);
    expect(seen!.publicKey!.authenticatorSelection).toEqual({ residentKey: "preferred", requireResidentKey: false, userVerification: "required" });
    expect(seen!.publicKey!.extensions).toEqual({ credProps: true });
    expect(seen!.publicKey!.rp).toEqual({ id: "autumn.example", name: "autumn.example" });
    expect(Array.from(seen!.publicKey!.user.id as Uint8Array)).toEqual(Array.from(userId));
    expect(seen!.publicKey!.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
    // ox wraps the browser's error; the mapping still finds it.
    expect(passkeyFailure(err, "create")?.reason).toBe("cancelled");
  });
});

describe("discoverableFrom", () => {
  it("uses credProps.rk when the browser reports it, otherwise unknown", () => {
    expect(discoverableFrom(fakeCredential(true))).toBe(true);
    expect(discoverableFrom(fakeCredential(false))).toBe(false);
    expect(discoverableFrom(fakeCredential(undefined))).toBe("unknown");
    expect(discoverableFrom({ id: "x", type: "public-key" } as Credential)).toBe("unknown");
    expect(discoverableFrom(null)).toBe("unknown");
  });
});

describe("userHandleFillingGetFn", () => {
  const wallet = "0x00112233445566778899aabbccddeeff00112233" as const;
  const assertion = (userHandle: ArrayBuffer | null) =>
    ({
      id: "cred",
      rawId: new Uint8Array([1, 2]).buffer,
      type: "public-key",
      getClientExtensionResults: () => ({}),
      response: { clientDataJSON: new Uint8Array([3]).buffer, authenticatorData: new Uint8Array([4]).buffer, signature: new Uint8Array([5]).buffer, userHandle },
    }) as unknown as Credential;

  it("returns an assertion with a user handle unchanged", async () => {
    const a = assertion(new Uint8Array(20).buffer);
    await expect(userHandleFillingGetFn(async () => a, wallet)()).resolves.toBe(a);
  });

  it("fills a missing user handle with the wallet address and keeps the signed parts", async () => {
    const a = assertion(null);
    const out = (await userHandleFillingGetFn(async () => a, wallet)()) as PublicKeyCredential;
    const r = out.response as AuthenticatorAssertionResponse;
    const orig = (a as PublicKeyCredential).response as AuthenticatorAssertionResponse;
    expect(Array.from(new Uint8Array(r.userHandle!), (b) => b.toString(16).padStart(2, "0")).join("")).toBe(wallet.slice(2));
    expect(r.signature).toBe(orig.signature);
    expect(r.authenticatorData).toBe(orig.authenticatorData);
    expect(r.clientDataJSON).toBe(orig.clientDataJSON);
    expect(out.id).toBe("cred");
  });

  it("passes the request options through untouched (allowCredentials names the passkey)", async () => {
    let seen: CredentialRequestOptions | undefined;
    const req = { publicKey: { challenge: new Uint8Array(32), allowCredentials: [{ type: "public-key" as const, id: new Uint8Array([7]) }] } };
    await userHandleFillingGetFn(async (o) => ((seen = o), assertion(null)), wallet)(req);
    expect(seen).toBe(req);
  });

  it("lets porto's Key.sign accept a non-discoverable assertion, which it refuses without the wrapper", async () => {
    // A real P-256 key signs what porto asks; the authenticator returns no user handle, as Chromium's does for a non-resident credential.
    const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]).then(async (kp) => {
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      return { privateKey: kp.privateKey, publicKey: PublicKey.from(raw) };
    });
    let requested: CredentialRequestOptions | undefined;
    const authenticator = async (o?: CredentialRequestOptions) => {
      requested = o;
      const challenge = o!.publicKey!.challenge as Uint8Array;
      const b64 = btoa(String.fromCharCode(...challenge)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: b64, origin: "https://autumn.example" }));
      const authenticatorData = new Uint8Array(37).fill(0);
      authenticatorData[32] = 0x05;
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
      const data = new Uint8Array([...authenticatorData, ...hash]);
      const p1363 = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data));
      const der = toDer(p1363);
      return {
        id: "Y3JlZA",
        rawId: new Uint8Array([1]).buffer,
        type: "public-key",
        getClientExtensionResults: () => ({}),
        response: { clientDataJSON: clientDataJSON.buffer, authenticatorData: authenticatorData.buffer, signature: der.buffer, userHandle: null },
      } as unknown as Credential;
    };
    const key = Key.fromWebAuthnP256({ credential: { id: "Y3JlZA", publicKey }, rpId: "autumn.example", role: "admin" });
    const payload = `0x${"11".repeat(32)}` as const;
    await expect(Key.sign(key, { payload, address: null, webAuthn: { getFn: authenticator as never } })).rejects.toThrow(/user handle/i);
    const sig = await Key.sign(key, { payload, address: null, webAuthn: { getFn: userHandleFillingGetFn(authenticator, wallet) as never } });
    expect(sig).toMatch(/^0x[0-9a-f]+$/);
    // The credential id was named in allowCredentials: that is how a non-discoverable passkey is found.
    expect(requested!.publicKey!.allowCredentials).toHaveLength(1);
  });
});

function toDer(p1363: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = new Uint8Array([0, ...v]);
    return new Uint8Array([0x02, v.length, ...v]);
  };
  const r = int(p1363.slice(0, 32));
  const s = int(p1363.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

describe("passkeyFailure", () => {
  const dom = (name: string) => Object.assign(new Error("browser text"), { name });
  it("maps WebAuthn errors to a reason and a plain message", () => {
    const cases: [string, string][] = [
      ["NotAllowedError", "cancelled"],
      ["SecurityError", "wrong-site"],
      ["InvalidStateError", "already-exists"],
      ["AbortError", "interrupted"],
      ["NotSupportedError", "unsupported"],
    ];
    for (const [name, reason] of cases) {
      const f = passkeyFailure(dom(name), "create");
      expect(f).toBeInstanceOf(PasskeyError);
      expect(f!.reason).toBe(reason);
      expect(f!.step).toBe("create");
      expect(f!.message).not.toMatch(/browser text|Error/);
    }
  });
  it("finds the browser error inside wrapping errors", () => {
    const wrapped = new Error("Failed to create credential.", { cause: new Error("inner", { cause: dom("NotAllowedError") }) });
    expect(passkeyFailure(wrapped, "find")?.reason).toBe("cancelled");
    expect(passkeyFailure(wrapped, "find")?.message).toMatch(/No passkey was chosen/);
  });
  it("leaves other errors alone", () => {
    expect(passkeyFailure(new Error("relay down"), "create")).toBeNull();
    expect(passkeyFailure("text", "create")).toBeNull();
  });
});
