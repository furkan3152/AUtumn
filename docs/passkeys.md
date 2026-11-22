# Passkeys

The wallet's only admin key is a WebAuthn passkey. Autumn creates it through
the Altana SDK but replaces the SDK's creation options with its own
(`web/src/lib/passkey.ts`, used by `createWallet` in
`web/src/lib/autumn.live.ts`). The private key stays in the device's
authenticator; Autumn never sees it.

## Which passkey Autumn asks for

The SDK asks for `residentKey: "required"`. On some Android phones Chrome
then offers only "Create a passkey on another device?". Autumn sends one of
two requests instead; everything else the SDK sets (user id = wallet
address, relying party, challenge, algorithms, credProps) is kept.

| Request | `authenticatorSelection` | Result |
|---|---|---|
| device-bound | `residentKey: "discouraged"`, `authenticatorAttachment: "platform"`, `userVerification: "required"` | A passkey on this device, behind its screen lock, usually not discoverable |
| preferred | `residentKey: "preferred"`, `requireResidentKey: false`, `userVerification: "required"` | A discoverable (often synced) passkey where the device can store one |

Which one is sent depends on the creation mode (`chooseRequestKind`):

- `"auto"` (the main button): device-bound on Android; elsewhere device-bound
  only when the browser reports no passkey platform authenticator but a
  user-verifying platform authenticator; otherwise preferred.
- `"device"`: always device-bound. Offered off Android as "My device only
  offers another device", and after a cancelled or unsupported attempt as
  "Use this phone's (device's) screen lock instead".
- `"synced"`: always preferred. Offered on Android as "Save the passkey to my
  Google account instead".

Whether the passkey is discoverable is taken from the browser's credProps
`rk`. A device-bound request counts as not discoverable unless `rk` is
`true`; an unknown answer is treated as not discoverable.

A non-discoverable passkey is used only when the site names its credential
id, and the authenticator then returns no user handle. Autumn supplies the
wallet address (the user handle written at creation) when signing
(`userHandleFillingGetFn`); the signature does not cover the user handle.

## The wallet backup code

Every wallet gets a backup code (`autumn1-…`, `web/src/lib/backupCode.ts`),
shown after the wallet is created and again from the "Backup code" chip.

- **What it is:** a versioned, checksummed text holding the wallet address,
  the passkey's credential id, its public key, the passkey's rpId and whether
  it is discoverable.
- **What it is not:** it holds no private key and cannot sign or move funds.
- **Why it exists:** Autumn keeps the credential id in the browser twice
  (localStorage and IndexedDB). A non-discoverable passkey cannot be found
  from the passkey alone, so "I already have an Autumn passkey" cannot find
  its wallet; if the browser's data is cleared, the code is the way to name
  the passkey again. For a synced passkey it is a second way back in.
- **Restoring** ("Restore with backup code") refuses a code for another rpId,
  and checks that the code's public key is an admin WebAuthn key of the
  wallet before using it: on Celo once the wallet has code (super-admin, not
  expired), otherwise in the Altana relay's record of the wallet's keys.
- **Limit:** it works only together with the passkey. If the device that holds
  a device-bound passkey is reset or the passkey is deleted, the wallet
  cannot sign again and its funds are lost; no code can help. Keep small
  amounts in such a wallet, and use "Send out" to move funds to an address
  you control.

## If our deployment is down

The wallet does not depend on our server. Balances are onchain, and "Send
out" needs only the passkey, the Altana relay and a Celo RPC. The app keeps
working (without plans and the agent's log) when the Autumn server cannot be
reached.

The constraint is the passkey's relying-party id (rpId). A passkey works
only on pages served from that domain or a subdomain of it, and the app also
refuses to use passkeys on any other host (`passkeyOriginProblem`,
`web/src/lib/env.ts`). A copy of Autumn on another domain, or on
`localhost`, cannot use a passkey created on ours. To use the same passkey
without our deployment:

1. Build the app from this repository with `NEXT_PUBLIC_AUTUMN_PREVIEW`
   unset, `NEXT_PUBLIC_AUTUMN_RP_ID` set to our deployment's rpId,
   `NEXT_PUBLIC_AUTUMN_APP_ORIGIN` unset or set to our deployment's origin,
   the GoldBuyer address and block from the [README](../README.md#deployed-on-celo-mainnet), and no server settings
   (the app then shows the server as unreachable, which is fine for sending
   out).
2. Serve it on that domain from your own machine: point the domain at
   `127.0.0.1` in your hosts file and serve it over HTTPS with a certificate
   your browser trusts (for example one made with `mkcert`). Browsers allow
   passkeys only in a secure context.
3. Open it and restore the wallet: "I already have an Autumn passkey" for a
   discoverable passkey (before the wallet's first transaction this reads
   the admin key from the Altana relay), or "Restore with backup code" for a
   device-bound one. Then use "Send out".

If the domain itself is lost (for example it expires and someone else takes
it), the passkey cannot be used by a website any more. That is a property of
passkeys, not something Autumn can work around. Move funds out while you can.

## `web/public/passkey-test.html`

A standalone diagnostic page, served at `/passkey-test.html` and excluded
from search engines in `robots.txt`. It sends nothing anywhere: each button
asks the browser to create a test passkey for the current host with a
different `authenticatorSelection` (device-bound, preferred, required,
with and without credProps, the app's own requests) and prints the result,
so a phone's behaviour can be recorded with a screenshot. It does not create
a wallet.
