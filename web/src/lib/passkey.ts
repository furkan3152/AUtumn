/**
 * WebAuthn wrappers around the Altana SDK's passkey calls.
 *
 * Why: the SDK creates the wallet's passkey through porto
 * `Key.createWebAuthnP256`, which asks for `residentKey: "required"`. On
 * phones where Google Password Manager cannot store a discoverable passkey,
 * Android then offers only "Create a passkey on another device?", and the
 * phone itself cannot be used. Most sites ask for `residentKey: "preferred"`,
 * which lets such a phone create a passkey that only the site can find
 * again (a "non-discoverable" passkey: the site must name its credential id).
 *
 * - `preferredResidentKeyCreateFn` is passed to `createPasskeyWallet` as
 *   `webAuthn.createFn`. It changes exactly three fields of the creation
 *   options and keeps everything else porto set (user id = wallet address,
 *   credProps, rp, challenge, algorithms).
 * - A device that can store a discoverable passkey still makes one with
 *   "preferred", exactly as before.
 * - Where even "preferred" only offers another device (no passkey provider on
 *   the phone), `DEVICE_AUTHENTICATOR_SELECTION` asks for a device-bound
 *   passkey behind the screen lock: chosen from the browser's capabilities,
 *   or by the owner ("Use this phone's screen lock instead").
 * - `userHandleFillingGetFn` is the signing counterpart: an authenticator
 *   does not return the user handle for a non-discoverable credential, and
 *   porto's `Key.sign` refuses an assertion without one. The signature does
 *   not cover the user handle; the wrapper supplies the wallet address that
 *   was written into it at creation.
 *
 * Nothing in this file touches keys: the private key stays inside the
 * device's authenticator.
 */
import type { Address } from "./autumn";

export type CreateFn = (options?: CredentialCreationOptions) => Promise<Credential | null>;
export type GetFn = (options?: CredentialRequestOptions) => Promise<Credential | null>;

/** Whether the passkey can be found again from the passkey alone (a discoverable / resident credential). */
export type Discoverable = boolean | "unknown";

/** The only three fields Autumn changes in the SDK's creation options. */
export const AUTUMN_AUTHENTICATOR_SELECTION = {
  residentKey: "preferred",
  requireResidentKey: false,
  userVerification: "required",
} as const satisfies AuthenticatorSelectionCriteria;

/** The SDK's creation options with `residentKey: "preferred"`, `requireResidentKey: false`, `userVerification: "required"`; nothing else changes. */
export function withPreferredResidentKey(options: CredentialCreationOptions | undefined): CredentialCreationOptions {
  return withAuthenticatorSelection(options, "preferred");
}

/* ---------- Device-bound passkeys (this device's screen lock) ---------- */

/**
 * Why a second request exists: on some Android phones no passkey provider
 * (Google Password Manager) is available to Chrome. Chrome sends requests
 * with `residentKey` "required" or "preferred" through Android's Credential
 * Manager, which then only offers "Create a passkey on another device?".
 * A request with `residentKey` "discouraged" (the WebAuthn default) goes
 * through the older Play Services FIDO2 path, which can make a passkey on
 * the phone itself: device-bound, not discoverable, protected by the screen
 * lock. Autumn already signs with such passkeys (see `userHandleFillingGetFn`)
 * and restores them from the backup code.
 */
export const DEVICE_AUTHENTICATOR_SELECTION = {
  residentKey: "discouraged",
  requireResidentKey: false,
  authenticatorAttachment: "platform",
  userVerification: "required",
} as const satisfies AuthenticatorSelectionCriteria;

/**
 * - "auto": choose from what the browser reports (`chooseRequestKind`).
 * - "device": always the device-bound request, for phones that report a passkey provider they cannot use.
 */
export type CreationMode = "auto" | "device";
/** Which creation request is sent: "preferred" (`AUTUMN_AUTHENTICATOR_SELECTION`) or "device" (`DEVICE_AUTHENTICATOR_SELECTION`). */
export type RequestKind = "preferred" | "device";

/** What the browser says about its platform authenticators. undefined: it did not say. */
export type PlatformCapabilities = {
  /** getClientCapabilities() key "passkeyPlatformAuthenticator". */
  passkeyPlatformAuthenticator: boolean | undefined;
  /** isUserVerifyingPlatformAuthenticatorAvailable(), or else the getClientCapabilities() key "userVerifyingPlatformAuthenticator". */
  userVerifyingPlatformAuthenticator: boolean | undefined;
};

/**
 * The request to send. Device-bound only when forced, or when the browser
 * says no passkey platform authenticator is available while a user-verifying
 * platform authenticator is. Anything unknown keeps "preferred".
 */
export function chooseRequestKind(mode: CreationMode, caps: PlatformCapabilities): RequestKind {
  if (mode === "device") return "device";
  if (caps.passkeyPlatformAuthenticator === false && caps.userVerifyingPlatformAuthenticator === true) return "device";
  return "preferred";
}

/** The authenticatorSelection fields Autumn sets for a request kind. */
export function authenticatorSelectionFor(kind: RequestKind): AuthenticatorSelectionCriteria {
  return kind === "device" ? { ...DEVICE_AUTHENTICATOR_SELECTION } : { ...AUTUMN_AUTHENTICATOR_SELECTION };
}

/** The SDK's creation options with the authenticatorSelection fields of `kind`; nothing else changes. */
export function withAuthenticatorSelection(options: CredentialCreationOptions | undefined, kind: RequestKind): CredentialCreationOptions {
  if (!options?.publicKey) throw new Error("The passkey request has no publicKey options.");
  return {
    ...options,
    publicKey: {
      ...options.publicKey,
      authenticatorSelection: { ...options.publicKey.authenticatorSelection, ...authenticatorSelectionFor(kind) },
    },
  };
}

type CapabilityApi = {
  getClientCapabilities?: () => Promise<Record<string, unknown>>;
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
};

/**
 * Reads the browser's platform capabilities. Never rejects: anything the
 * browser does not answer is undefined. Spec (WebAuthn L3 §5.1.7, §5.8.7): a
 * missing key means "not known"; false means "known to be not supported".
 */
export async function readPlatformCapabilities(api: CapabilityApi | undefined = globalThis.PublicKeyCredential as CapabilityApi | undefined): Promise<PlatformCapabilities> {
  let caps: Record<string, unknown> = {};
  try {
    if (typeof api?.getClientCapabilities === "function") caps = (await api.getClientCapabilities()) ?? {};
  } catch {
    /* unknown */
  }
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  let uvpa: boolean | undefined;
  try {
    if (typeof api?.isUserVerifyingPlatformAuthenticatorAvailable === "function") uvpa = bool(await api.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    /* unknown */
  }
  return {
    passkeyPlatformAuthenticator: bool(caps.passkeyPlatformAuthenticator),
    userVerifyingPlatformAuthenticator: uvpa ?? bool(caps.userVerifyingPlatformAuthenticator),
  };
}

/**
 * A `createFn` for the SDK that sends the request of `kind` and reports
 * whether the passkey is discoverable. A device-bound request counts as not
 * discoverable unless the browser's credProps says `rk: true`.
 */
export function selectionCreateFn(create: CreateFn, kind: RequestKind, onCreated: (discoverable: Discoverable) => void): CreateFn {
  return async (options) => {
    const credential = await create(withAuthenticatorSelection(options, kind));
    if (credential) {
      const d = discoverableFrom(credential);
      onCreated(kind === "device" ? d === true : d);
    }
    return credential;
  };
}

/**
 * From a newly created credential: whether it is discoverable. Only the
 * browser's credProps `rk` answers this; without it the answer is "unknown",
 * which Autumn treats as not discoverable.
 */
export function discoverableFrom(credential: Credential | null | undefined): Discoverable {
  const ext = (credential as PublicKeyCredential | null | undefined)?.getClientExtensionResults?.();
  const rk = ext?.credProps?.rk;
  return typeof rk === "boolean" ? rk : "unknown";
}

/**
 * A `createFn` for the SDK that creates the passkey with the options of
 * `withPreferredResidentKey` and reports whether it is discoverable.
 */
export function preferredResidentKeyCreateFn(create: CreateFn, onCreated: (discoverable: Discoverable) => void): CreateFn {
  return selectionCreateFn(create, "preferred", onCreated);
}

/** The browser's own credential functions, bound. */
export function browserCreateFn(): CreateFn {
  return (o) => navigator.credentials.create(o);
}
export function browserGetFn(): GetFn {
  return (o) => navigator.credentials.get(o);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A `getFn` for signing that returns the assertion unchanged when it carries
 * a user handle, and otherwise the same assertion with the wallet address as
 * its user handle (the value written into the passkey at creation). The
 * signature, authenticator data and client data are untouched.
 */
export function userHandleFillingGetFn(get: GetFn, wallet: Address): GetFn {
  const handle = hexToBytes(wallet);
  return async (options) => {
    const credential = (await get(options)) as PublicKeyCredential | null;
    if (!credential) return credential;
    const response = credential.response as AuthenticatorAssertionResponse;
    if (response.userHandle && response.userHandle.byteLength > 0) return credential;
    const filled = {
      id: credential.id,
      rawId: credential.rawId,
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      getClientExtensionResults: () => credential.getClientExtensionResults(),
      response: {
        clientDataJSON: response.clientDataJSON,
        authenticatorData: response.authenticatorData,
        signature: response.signature,
        userHandle: handle.slice().buffer,
      },
    };
    return filled as unknown as Credential;
  };
}

/* ---------- Failures ---------- */

/**
 * Why a passkey step failed, for the UI to explain:
 * - cancelled: the prompt was closed, timed out, or the device refused (WebAuthn NotAllowedError)
 * - wrong-site: the page is not allowed to use passkeys for this domain (SecurityError)
 * - already-exists: this authenticator already holds this passkey (InvalidStateError)
 * - interrupted: another passkey prompt or a page change stopped it (AbortError)
 * - unsupported: this browser or device cannot make this kind of passkey (no WebAuthn, NotSupportedError)
 */
export type PasskeyFailureReason = "cancelled" | "wrong-site" | "already-exists" | "interrupted" | "unsupported";
export type PasskeyStep = "create" | "find" | "sign";

/** A failed passkey step. `message` is a short plain sentence; `reason` lets the UI pick its own text or help. */
export class PasskeyError extends Error {
  readonly name = "PasskeyError";
  constructor(
    readonly reason: PasskeyFailureReason,
    readonly step: PasskeyStep,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const MESSAGES: Record<PasskeyStep, Record<PasskeyFailureReason, string>> = {
  create: {
    cancelled: "The passkey was not created: the prompt was closed or timed out. Nothing was set up; you can try again.",
    "wrong-site": "This page is not allowed to create passkeys for Autumn. Open Autumn on its own address.",
    "already-exists": "This device already has this passkey. Try again, or use \"I already have an Autumn passkey\".",
    interrupted: "The passkey prompt was interrupted. Try again.",
    unsupported: "This browser cannot create a passkey here. Try your phone's default browser, with a screen lock set.",
  },
  find: {
    cancelled: "No passkey was chosen: the prompt was closed or timed out.",
    "wrong-site": "This page is not allowed to use Autumn's passkeys. Open Autumn on its own address.",
    "already-exists": "The passkey could not be used. Try again.",
    interrupted: "The passkey prompt was interrupted. Try again.",
    unsupported: "This browser cannot use passkeys here.",
  },
  sign: {
    cancelled: "Nothing was signed: the passkey prompt was closed or timed out.",
    "wrong-site": "This page is not allowed to use Autumn's passkeys. Open Autumn on its own address.",
    "already-exists": "The passkey could not be used. Try again.",
    interrupted: "The passkey prompt was interrupted. Nothing was signed.",
    unsupported: "This browser cannot use passkeys here.",
  },
};

const REASON_BY_DOM_NAME: Record<string, PasskeyFailureReason> = {
  NotAllowedError: "cancelled",
  SecurityError: "wrong-site",
  InvalidStateError: "already-exists",
  AbortError: "interrupted",
  NotSupportedError: "unsupported",
};

/** The WebAuthn DOMException name inside an error, following `cause` (ox and the SDK wrap it). */
function webAuthnErrorName(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur; i++) {
    const name = (cur as { name?: unknown }).name;
    if (typeof name === "string" && name in REASON_BY_DOM_NAME) return name;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** A PasskeyError for a WebAuthn failure, or null when the error is something else (relay, network, ...). */
export function passkeyFailure(e: unknown, step: PasskeyStep): PasskeyError | null {
  if (e instanceof PasskeyError) return e;
  const name = webAuthnErrorName(e);
  if (!name) return null;
  const reason = REASON_BY_DOM_NAME[name]!;
  return new PasskeyError(reason, step, MESSAGES[step][reason], { cause: e });
}

/** Thrown before any prompt when the browser has no WebAuthn at all. */
export function unsupportedPasskeys(step: PasskeyStep): PasskeyError {
  return new PasskeyError("unsupported", step, MESSAGES[step].unsupported);
}

/** Whether this browser exposes WebAuthn. */
export function hasWebAuthn(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined" && !!navigator.credentials;
}
