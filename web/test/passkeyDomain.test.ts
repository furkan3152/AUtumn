import { afterEach, describe, expect, it, vi } from "vitest";
import * as Key from "porto/viem/Key";
import * as PublicKey from "ox/PublicKey";
import {
  backupCodeDoor,
  otherDoors,
  parsePublicConfig,
  parseRpIds,
  passkeyDomainFor,
  passkeyOriginProblem,
  type PublicConfig,
} from "../src/lib/env";
import { BackupCodeError, WrongDoorError, bytesToBase64Url, decodeBackupCode, encodeBackupCode, type BackupData } from "../src/lib/backupCode";

const base = { goldBuyer: "0x5b73c5498c1e3b4dba84de0f1833c4a029d90519", deployBlock: "83380000" };
const OLD = "autumn-gold.onrender.com";
const NEW = "autumngold.example";

function config(raw: { rpId?: string; rpIds?: string; appOrigin?: string }): PublicConfig {
  const r = parsePublicConfig({ ...base, ...raw });
  if (!r.ok) throw new Error(`config refused: ${r.problems.join(", ")}`);
  return r.config;
}
const at = (url: string) => {
  const u = new URL(url);
  return { hostname: u.hostname, origin: u.origin, protocol: u.protocol, port: u.port };
};

describe("NEXT_PUBLIC_AUTUMN_RP_IDS", () => {
  it("reads hostnames and origins, ignoring case, spaces, empty entries and repeats", () => {
    expect(parseRpIds(undefined)).toBeNull();
    expect(parseRpIds(" , ")).toBeNull();
    expect(parseRpIds(` AutumnGold.Example , ${OLD},,autumngold.example `)).toEqual([
      { rpId: NEW, origin: null },
      { rpId: OLD, origin: null },
    ]);
    expect(parseRpIds("http://localhost:3000, https://Alpha.Example:8443/")).toEqual([
      { rpId: "localhost", origin: "http://localhost:3000" },
      { rpId: "alpha.example", origin: "https://alpha.example:8443" },
    ]);
  });

  it("refuses entries that are not a hostname or a bare origin", () => {
    for (const bad of ["autumn.example/app", "https://autumn.example/app", "ftp://autumn.example", "autumn.example:3000", ".autumn.example", "autumn example", "https://a@autumn.example"]) {
      expect(parseRpIds(bad), bad).toBe("invalid");
      expect(parsePublicConfig({ ...base, rpId: OLD, rpIds: bad })).toMatchObject({ ok: false, problems: ["NEXT_PUBLIC_AUTUMN_RP_IDS"] });
    }
  });

  it("makes NEXT_PUBLIC_AUTUMN_RP_ID optional: the first entry is then the single configured rpId", () => {
    expect(config({ rpIds: `${NEW},${OLD}` })).toMatchObject({ rpId: NEW, appOrigin: null });
    expect(config({ rpIds: `${NEW},${OLD}`, rpId: OLD, appOrigin: `https://${OLD}` })).toMatchObject({ rpId: OLD, appOrigin: `https://${OLD}` });
    expect(parsePublicConfig({ ...base }).ok).toBe(false);
  });
});

describe("passkeyDomainFor", () => {
  const two = config({ rpIds: `${NEW},${OLD}`, rpId: OLD, appOrigin: `https://${OLD}` });

  it("list unset: the single configured rpId and origin on every host, as before", () => {
    const one = config({ rpId: OLD, appOrigin: `https://${OLD}` });
    for (const url of [`https://${OLD}/`, `https://${NEW}/`, "http://localhost:3000/"]) {
      expect(passkeyDomainFor(one, at(url))).toEqual({ rpId: OLD, appOrigin: `https://${OLD}`, listed: false });
    }
    // Development, exactly as web/.env.example sets it.
    const dev = config({ rpId: "localhost", appOrigin: "http://localhost:3000" });
    const d = passkeyDomainFor(dev, at("http://localhost:3000/"));
    expect(d).toEqual({ rpId: "localhost", appOrigin: "http://localhost:3000", listed: false });
    expect(passkeyOriginProblem(d, at("http://localhost:3000/"))).toBeNull();
  });

  it("a listed host: that host is the rpId, served from https://<host>", () => {
    expect(passkeyDomainFor(two, at(`https://${NEW}/`))).toEqual({ rpId: NEW, appOrigin: `https://${NEW}`, listed: true });
    expect(passkeyDomainFor(two, at(`https://${OLD}/plans?x=1`))).toEqual({ rpId: OLD, appOrigin: `https://${OLD}`, listed: true });
    // The hostname from the browser is lowercase already; a mixed-case value still matches.
    expect(passkeyDomainFor(two, { hostname: "AutumnGold.Example" }).rpId).toBe(NEW);
    for (const host of [NEW, OLD]) expect(passkeyOriginProblem(passkeyDomainFor(two, at(`https://${host}/`)), at(`https://${host}/`))).toBeNull();
  });

  it("an unlisted host: never its own hostname, but the single configured rpId, which it may not use", () => {
    for (const url of ["https://evil.example/", `https://www.${NEW}/`, "https://autumn-gold-pr-7.onrender.com/"]) {
      const d = passkeyDomainFor(two, at(url));
      expect(d).toEqual({ rpId: OLD, appOrigin: `https://${OLD}`, listed: false });
      expect(passkeyOriginProblem(d, at(url))).not.toBeNull();
    }
  });

  it("an origin with a port: the exact origin from the list, or the app origin on that host", () => {
    const ported = config({ rpIds: "https://alpha.example:8443,beta.example" });
    expect(passkeyDomainFor(ported, at("https://alpha.example:8443/"))).toEqual({ rpId: "alpha.example", appOrigin: "https://alpha.example:8443", listed: true });
    expect(passkeyOriginProblem(passkeyDomainFor(ported, at("https://alpha.example/")), at("https://alpha.example/"))).toMatch(/only on https:\/\/alpha\.example:8443/);
    const withApp = config({ rpIds: "localhost,beta.localhost", rpId: "localhost", appOrigin: "http://localhost:3000" });
    expect(passkeyDomainFor(withApp, at("http://localhost:3000/")).appOrigin).toBe("http://localhost:3000");
  });

  it("localhost and *.localhost: any port, as development servers choose", () => {
    const local = config({ rpIds: "alpha.localhost,beta.localhost" });
    for (const url of ["http://alpha.localhost:3000/", "http://alpha.localhost:4123/"]) {
      const d = passkeyDomainFor(local, at(url));
      expect(d).toEqual({ rpId: "alpha.localhost", appOrigin: null, listed: true });
      expect(passkeyOriginProblem(d, at(url))).toBeNull();
    }
    expect(passkeyDomainFor(local, at("http://beta.localhost:3000/")).rpId).toBe("beta.localhost");
    // Plain localhost is not listed: the primary rpId, refused on that page.
    const d = passkeyDomainFor(local, at("http://localhost:3000/"));
    expect(d.rpId).toBe("alpha.localhost");
    expect(passkeyOriginProblem(d, at("http://localhost:3000/"))).toMatch(/cannot use passkeys/);
  });
});

describe("otherDoors", () => {
  it("lists the other configured hosts with the address where their wallets open; nothing for one host", () => {
    const two = config({ rpIds: `${NEW},${OLD}` });
    expect(otherDoors(two, at(`https://${NEW}/`))).toEqual([{ host: OLD, url: `https://${OLD}` }]);
    expect(otherDoors(two, at(`https://${OLD}/`))).toEqual([{ host: NEW, url: `https://${NEW}` }]);
    expect(otherDoors(config({ rpIds: NEW }), at(`https://${NEW}/`))).toEqual([]);
    expect(otherDoors(config({ rpId: OLD }), at(`https://${OLD}/`))).toEqual([]);
    // On localhost the link keeps this page's scheme and port.
    expect(otherDoors(config({ rpIds: "alpha.localhost,beta.localhost" }), at("http://beta.localhost:3999/"))).toEqual([{ host: "alpha.localhost", url: "http://alpha.localhost:3999" }]);
  });
});

describe("backup codes per host", () => {
  const code = (rpId: string): BackupData => ({
    wallet: "0x3CE7ba69E7D85a6C4509FE1779B9864086e51cDF",
    credentialId: bytesToBase64Url(Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff)),
    publicKey: "0xa8fd8e83458ce2815bb3a71727205991f98ce7cac27ae723969ab11e3834f6d386831084a0e01624c8a33181ae10a7f2a76c02344410a1b2589af04b1904be43",
    rpId,
    discoverable: false,
  });
  const two = config({ rpIds: `${NEW},${OLD}`, rpId: OLD, appOrigin: `https://${OLD}` });

  it("a code carries the domain its passkey was made on, through a round trip", () => {
    for (const rpId of [NEW, OLD, "alpha.localhost", "beta.localhost"]) {
      expect(decodeBackupCode(encodeBackupCode(code(rpId))).rpId).toBe(rpId);
    }
  });

  it("restores here only on its own host; another configured host is the wrong door; anything else is refused", () => {
    const fromOld = decodeBackupCode(encodeBackupCode(code(OLD))).rpId;
    const fromNew = decodeBackupCode(encodeBackupCode(code(NEW))).rpId;
    expect(backupCodeDoor(fromOld, two, at(`https://${OLD}/`))).toEqual({ kind: "here" });
    expect(backupCodeDoor(fromNew, two, at(`https://${NEW}/`))).toEqual({ kind: "here" });
    expect(backupCodeDoor(fromOld, two, at(`https://${NEW}/`))).toEqual({ kind: "elsewhere", host: OLD, url: `https://${OLD}` });
    expect(backupCodeDoor(fromNew, two, at(`https://${OLD}/`))).toEqual({ kind: "elsewhere", host: NEW, url: `https://${NEW}` });
    expect(backupCodeDoor("autumn.other.example", two, at(`https://${NEW}/`))).toEqual({ kind: "foreign" });
    // One host configured: today's decision, a code for another domain is refused.
    const one = config({ rpId: OLD });
    expect(backupCodeDoor(fromOld, one, at(`https://${OLD}/`))).toEqual({ kind: "here" });
    expect(backupCodeDoor(fromNew, one, at(`https://${OLD}/`))).toEqual({ kind: "foreign" });
  });
});

/* ---------- The live client in a stand-in browser: which rpId its passkey calls carry ---------- */

type Seen = { create: CredentialCreationOptions[]; get: CredentialRequestOptions[]; fetch: string[] };

async function liveClientAt(url: string, cfg: PublicConfig) {
  const seen: Seen = { create: [], get: [], fetch: [] };
  const store = new Map<string, string>();
  const refuse = () => Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
  const u = new URL(url);
  vi.stubGlobal("window", {
    location: { href: url, origin: u.origin, hostname: u.hostname, protocol: u.protocol, port: u.port, search: "" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    PublicKeyCredential: function PublicKeyCredential() {},
  });
  vi.stubGlobal("PublicKeyCredential", { getClientCapabilities: async () => ({}), isUserVerifyingPlatformAuthenticatorAvailable: async () => true });
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0",
    credentials: {
      create: async (o: CredentialCreationOptions) => {
        seen.create.push(o);
        throw refuse();
      },
      get: async (o: CredentialRequestOptions) => {
        seen.get.push(o);
        throw refuse();
      },
    },
  });
  vi.stubGlobal("fetch", async (input: unknown) => {
    seen.fetch.push(String(input));
    throw new Error("no network in this test");
  });
  const { createLiveClient } = await import("../src/lib/autumn.live");
  return { client: createLiveClient(cfg), seen };
}

describe("live client passkey calls use the page's passkey domain", () => {
  afterEach(() => vi.unstubAllGlobals());
  const local = config({ rpIds: "alpha.localhost,beta.localhost" });

  for (const host of ["alpha.localhost", "beta.localhost"]) {
    it(`creation and passkey restore on ${host} name ${host}`, async () => {
      const { client, seen } = await liveClientAt(`http://${host}:3000/`, local);
      await expect(client.createWallet()).rejects.toMatchObject({ name: "PasskeyError", reason: "cancelled" });
      expect(seen.create).toHaveLength(1);
      expect(seen.create[0]!.publicKey!.rp).toEqual({ id: host, name: host });
      await expect(client.restoreWallet()).rejects.toMatchObject({ name: "PasskeyError", reason: "cancelled" });
      expect(seen.get).toHaveLength(1);
      expect(seen.get[0]!.publicKey!.rpId).toBe(host);
    });
  }

  it("one host configured: the configured rpId, as before", async () => {
    const { client, seen } = await liveClientAt("http://localhost:3000/", config({ rpId: "localhost", appOrigin: "http://localhost:3000" }));
    await expect(client.createWallet()).rejects.toMatchObject({ name: "PasskeyError" });
    expect(seen.create[0]!.publicKey!.rp.id).toBe("localhost");
    await expect(client.restoreWallet()).rejects.toMatchObject({ name: "PasskeyError" });
    expect(seen.get[0]!.publicKey!.rpId).toBe("localhost");
  });

  it("an unlisted host makes no passkey call", async () => {
    const { client, seen } = await liveClientAt("http://gamma.localhost:3000/", local);
    await expect(client.createWallet()).rejects.toThrow(/cannot use passkeys for alpha\.localhost/);
    await expect(client.restoreWallet()).rejects.toThrow(/cannot use passkeys/);
    expect(seen.create).toHaveLength(0);
    expect(seen.get).toHaveLength(0);
  });

  it("alpha's backup code on beta: the wrong door, with no passkey call and no network request", async () => {
    const alphaCode = encodeBackupCode({
      wallet: "0x3CE7ba69E7D85a6C4509FE1779B9864086e51cDF",
      credentialId: "Y3JlZGVudGlhbA",
      publicKey: `0x${"ab".repeat(64)}`,
      rpId: "alpha.localhost",
      discoverable: false,
    });
    const { client, seen } = await liveClientAt("http://beta.localhost:3000/", local);
    const err = await client.restoreFromBackupCode(alphaCode).catch((e) => e);
    expect(err).toBeInstanceOf(WrongDoorError);
    expect(err).toMatchObject({ host: "alpha.localhost", url: "http://alpha.localhost:3000", message: "This wallet was made at alpha.localhost. Open it there." });
    // A domain this deployment does not serve: today's refusal.
    const foreign = encodeBackupCode({ ...decodeBackupCode(alphaCode), rpId: "autumn.other.example" });
    await expect(client.restoreFromBackupCode(foreign)).rejects.toBeInstanceOf(BackupCodeError);
    expect(seen).toEqual({ create: [], get: [], fetch: [] });
  });
});

describe("signing uses the rpId stored with the passkey", () => {
  it("the assertion request names the domain the passkey was made on", async () => {
    const publicKey = PublicKey.from(new Uint8Array([4, ...new Uint8Array(32).fill(1), ...new Uint8Array(32).fill(2)]));
    for (const rpId of ["alpha.localhost", "beta.localhost"]) {
      let asked: CredentialRequestOptions | undefined;
      const key = Key.fromWebAuthnP256({ credential: { id: "Y3JlZA", publicKey }, rpId, role: "admin" });
      await Key.sign(key, {
        payload: `0x${"11".repeat(32)}`,
        address: null,
        webAuthn: {
          getFn: (async (o: CredentialRequestOptions) => {
            asked = o;
            throw Object.assign(new Error("stop"), { name: "NotAllowedError" });
          }) as never,
        },
      }).catch(() => null);
      expect(asked!.publicKey!.rpId).toBe(rpId);
    }
  });
});
