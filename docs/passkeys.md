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
- **Restoring** ("Restore with backup code") checks the code's rpId first.
  A code for this page's passkey domain goes on; a code for another host of
  this deployment shows "This wallet was made at <host>. Open it there."
  with a link, and nothing else is tried (no passkey prompt, no network
  request); a code for any other domain is refused as before. Then it checks
  that the code's public key is an admin WebAuthn key of the wallet before
  using it: on Celo once the wallet has code (super-admin, not expired),
  otherwise in the Altana relay's record of the wallet's keys. The code
  always carries the domain its passkey was made on.
- **Limit:** it works only together with the passkey. If the device that holds
  a device-bound passkey is reset or the passkey is deleted, the wallet
  cannot sign again and its funds are lost; no code can help. Keep small
  amounts in such a wallet, and use "Send out" to move funds to an address
  you control.

## Which domain a passkey belongs to

A passkey is bound to its relying-party id (rpId), the domain it was made
on. It works only on pages served from that domain or a subdomain of it, and
the app also refuses to use passkeys on any other host
(`passkeyOriginProblem`, `web/src/lib/env.ts`).

One deployment can serve several domains ("two doors, one app"):
`NEXT_PUBLIC_AUTUMN_RP_IDS` lists them, primary first, for example
`autumngold.app,autumn-gold.onrender.com`. In the browser the app takes
the entry equal to the page's hostname as its rpId (`passkeyDomainFor`), and
every passkey step uses it: creating a wallet, "I already have an Autumn
passkey", restoring from a backup code, and the backup code itself. Signing
uses the rpId stored with the wallet, which is the domain the passkey was
made on. On a host that is not listed the app uses the single configured
rpId (`NEXT_PUBLIC_AUTUMN_RP_ID`, or the first entry) exactly as a
single-domain build does, which refuses passkeys on that page; it never
takes an rpId from an unlisted hostname. Without the list the app behaves as
before, with `NEXT_PUBLIC_AUTUMN_RP_ID` alone.

Which wallet opens where:

- A wallet made at `autumn-gold.onrender.com` (every wallet made before the
  custom domain) opens only there. Its passkey, its stored record and its
  backup code all name that domain.
- A wallet made at the custom domain opens only there.
- The browser keeps the wallet record per site, so each domain starts with
  no wallet. "I already have an Autumn passkey" on a domain where the
  device holds no passkey for it finds nothing, as before. When more than
  one domain is configured, the landing page names the other domain(s) with
  a link ("Wallets made at … open there."), and a backup code from another
  configured domain links there instead of trying the passkey.

New ERC-8004 registrations name the origin the owner is on as their service
endpoint; registrations already made keep the endpoint they were made with.

Not implemented: WebAuthn Related Origin Requests (a passkey of one domain
used on the other). Nothing in the app prevents adding it later: it needs a
`/.well-known/webauthn` file served from the passkey's own domain (for
example `web/public/.well-known/webauthn`, served as `application/json`),
listing the other origins, and browsers that support it.

## If our deployment is down

The wallet does not depend on our server. Balances are onchain, and "Send
out" needs only the passkey, the Altana relay and a Celo RPC. The app keeps
working (without plans and the agent's log) when the Autumn server cannot be
reached.

The constraint is the passkey's rpId. A copy of Autumn on another domain, or
on `localhost`, cannot use a passkey created on ours. Each domain is its own
door: a wallet made at `autumn-gold.onrender.com` needs that domain, and a
wallet made at the custom domain needs the custom domain. If our deployment
is down but a domain still resolves to a server you control (or you point it
at your own machine as below), the wallets of that domain can be used; the
other domain's wallets cannot be used through it. To use a passkey without
our deployment:

1. Build the app from this repository with `NEXT_PUBLIC_AUTUMN_PREVIEW`
   unset, `NEXT_PUBLIC_AUTUMN_RP_ID` set to the domain the wallet was made on
   (the rpId in its backup code), `NEXT_PUBLIC_AUTUMN_RP_IDS` and
   `NEXT_PUBLIC_AUTUMN_APP_ORIGIN` unset (or set to our deployment's values),
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

If a domain itself is lost (for example it expires and someone else takes
it), the passkeys made on it cannot be used by a website any more. That is a
property of passkeys, not something Autumn can work around. Move funds out
while you can. Keep every domain that wallets were made on.

## `web/public/passkey-test.html`

A standalone diagnostic page, served at `/passkey-test.html` and excluded
from search engines in `robots.txt`. It sends nothing anywhere: each button
asks the browser to create a test passkey for the current host with a
different `authenticatorSelection` (device-bound, preferred, required,
with and without credProps, the app's own requests) and prints the result,
so a phone's behaviour can be recorded with a screenshot. It does not create
a wallet.
