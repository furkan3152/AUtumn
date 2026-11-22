/**
 * Public (browser) settings. Next.js inlines `process.env.NEXT_PUBLIC_…` only
 * when each name is written out literally, so they are read one by one here.
 *
 * Required for the live app:
 * - NEXT_PUBLIC_AUTUMN_GOLD_BUYER_ADDRESS   the deployed GoldBuyer
 * - NEXT_PUBLIC_AUTUMN_GOLD_BUYER_DEPLOY_BLOCK  its deployment block (purchase history starts there)
 * - NEXT_PUBLIC_AUTUMN_RP_ID                the passkey relying-party id: the app's domain ("localhost" in development).
 *                                           Optional when NEXT_PUBLIC_AUTUMN_RP_IDS is set.
 * Optional:
 * - NEXT_PUBLIC_AUTUMN_RP_IDS               the hosts this deployment serves as passkey domains, comma-separated,
 *                                           primary first, e.g. "autumngold.example,autumn-gold.onrender.com".
 *                                           Each entry is a hostname (its origin is https://<host>; any port on
 *                                           localhost and *.localhost) or an exact origin (http://localhost:3000).
 *                                           A page whose hostname is listed uses that entry as its rpId and
 *                                           origin; any other page uses NEXT_PUBLIC_AUTUMN_RP_ID (or the first
 *                                           entry) exactly as a single-host build does. See passkeyDomainFor.
 * - NEXT_PUBLIC_AUTUMN_APP_ORIGIN           the app's origin, e.g. https://autumn.example; the app refuses to
 *                                           create passkeys from any other origin
 * - NEXT_PUBLIC_AUTUMN_CELO_RPC_URL         browser reads (default https://forno.celo.org)
 * - NEXT_PUBLIC_AUTUMN_LOGS_BLOCK_RANGE     max blocks per eth_getLogs (default 5000, forno's limit)
 */
import { DEFAULT_CELO_RPC_URL } from "@autumn/core";
import type { Address } from "./autumn";

/** One host the deployment serves as a passkey domain. `origin` null: derived from the page (see `hostOrigin`). */
export type PasskeyHost = { rpId: string; origin: string | null };

export type PublicConfig = {
  goldBuyer: Address;
  goldBuyerDeployBlock: bigint;
  /** The single configured rpId: NEXT_PUBLIC_AUTUMN_RP_ID, or else the first entry of `rpIds`. */
  rpId: string;
  appOrigin: string | null;
  /** NEXT_PUBLIC_AUTUMN_RP_IDS, primary first; null when unset (one host, as before). */
  rpIds: PasskeyHost[] | null;
  rpcUrl: string;
  logBlockRange: bigint;
};

export type RawPublicEnv = {
  goldBuyer?: string;
  deployBlock?: string;
  rpId?: string;
  rpIds?: string;
  appOrigin?: string;
  rpcUrl?: string;
  logBlockRange?: string;
};

function rawEnv(): RawPublicEnv {
  return {
    goldBuyer: process.env.NEXT_PUBLIC_AUTUMN_GOLD_BUYER_ADDRESS,
    deployBlock: process.env.NEXT_PUBLIC_AUTUMN_GOLD_BUYER_DEPLOY_BLOCK,
    rpId: process.env.NEXT_PUBLIC_AUTUMN_RP_ID,
    rpIds: process.env.NEXT_PUBLIC_AUTUMN_RP_IDS,
    appOrigin: process.env.NEXT_PUBLIC_AUTUMN_APP_ORIGIN,
    rpcUrl: process.env.NEXT_PUBLIC_AUTUMN_CELO_RPC_URL,
    logBlockRange: process.env.NEXT_PUBLIC_AUTUMN_LOGS_BLOCK_RANGE,
  };
}

/** Parses the public settings; lists every missing or malformed one. */
export function parsePublicConfig(raw: RawPublicEnv): { ok: true; config: PublicConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const goldBuyer = raw.goldBuyer?.trim();
  if (!goldBuyer || !/^0x[0-9a-fA-F]{40}$/.test(goldBuyer)) problems.push("NEXT_PUBLIC_AUTUMN_GOLD_BUYER_ADDRESS");
  const block = raw.deployBlock?.trim();
  if (!block || !/^\d+$/.test(block)) problems.push("NEXT_PUBLIC_AUTUMN_GOLD_BUYER_DEPLOY_BLOCK");
  const rpIds = parseRpIds(raw.rpIds);
  if (rpIds === "invalid") problems.push("NEXT_PUBLIC_AUTUMN_RP_IDS");
  const rpIdRaw = raw.rpId?.trim().toLowerCase();
  const rpId = rpIdRaw || (Array.isArray(rpIds) ? rpIds[0]!.rpId : undefined);
  if (!rpId || !isRpId(rpId)) problems.push("NEXT_PUBLIC_AUTUMN_RP_ID");
  let appOrigin: string | null = null;
  if (raw.appOrigin?.trim()) {
    try {
      appOrigin = new URL(raw.appOrigin.trim()).origin;
    } catch {
      problems.push("NEXT_PUBLIC_AUTUMN_APP_ORIGIN");
    }
  }
  const range = raw.logBlockRange?.trim();
  if (range && !/^[1-9]\d*$/.test(range)) problems.push("NEXT_PUBLIC_AUTUMN_LOGS_BLOCK_RANGE");
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    config: {
      goldBuyer: goldBuyer as Address,
      goldBuyerDeployBlock: BigInt(block!),
      rpId: rpId!,
      appOrigin,
      rpIds: Array.isArray(rpIds) ? rpIds : null,
      rpcUrl: raw.rpcUrl?.trim() || DEFAULT_CELO_RPC_URL,
      logBlockRange: range ? BigInt(range) : 5000n,
    },
  };
}

const isRpId = (h: string) => /^[a-z0-9.-]+$/.test(h) && !h.startsWith(".") && !h.endsWith(".");

/**
 * NEXT_PUBLIC_AUTUMN_RP_IDS: comma-separated hostnames or origins. Spaces and case are ignored, empty entries
 * and repeats are dropped. null when unset or empty; "invalid" when any entry is not a hostname or an
 * http(s) origin without a path.
 */
export function parseRpIds(raw: string | undefined): PasskeyHost[] | null | "invalid" {
  const entries = (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
  if (entries.length === 0) return null;
  const out: PasskeyHost[] = [];
  for (const e of entries) {
    let host: PasskeyHost;
    if (e.includes("://")) {
      let u: URL;
      try {
        u = new URL(e);
      } catch {
        return "invalid";
      }
      if ((u.protocol !== "https:" && u.protocol !== "http:") || u.pathname !== "/" || u.search || u.hash || u.username || u.password) return "invalid";
      host = { rpId: u.hostname, origin: u.origin };
    } else host = { rpId: e, origin: null };
    if (!isRpId(host.rpId)) return "invalid";
    if (out.some((h) => h.rpId === host.rpId)) continue;
    out.push(host);
  }
  return out;
}

/** localhost and its subdomains: secure contexts over plain http, on any port. */
const isLoopbackHost = (host: string) => host === "localhost" || host.endsWith(".localhost");

/**
 * The origin a listed host is served from: its own when the entry names one, the configured app origin when that
 * is on this host, https://<host> otherwise. On localhost and *.localhost a bare entry pins no origin (null), as a
 * single-host build without NEXT_PUBLIC_AUTUMN_APP_ORIGIN does: development servers pick their port.
 */
function hostOrigin(cfg: Pick<PublicConfig, "appOrigin">, h: PasskeyHost): string | null {
  if (h.origin) return h.origin;
  if (cfg.appOrigin && new URL(cfg.appOrigin).hostname === h.rpId) return cfg.appOrigin;
  return isLoopbackHost(h.rpId) ? null : `https://${h.rpId}`;
}

/** The address to send someone to for a listed host: its origin, or on a loopback host this page's scheme and port. */
function hostUrl(cfg: Pick<PublicConfig, "appOrigin">, h: PasskeyHost, location: { protocol: string; port: string }): string {
  const o = hostOrigin(cfg, h);
  if (o) return o;
  return `${location.protocol}//${h.rpId}${location.port ? `:${location.port}` : ""}`;
}

/** The passkey domain this page uses: `rpId` for every WebAuthn call, `appOrigin` for passkeyOriginProblem. */
export type PasskeyDomain = { rpId: string; appOrigin: string | null; listed: boolean };

/**
 * The passkey domain of the page at `location`, read in the browser only (the server render cannot know the host).
 * - NEXT_PUBLIC_AUTUMN_RP_IDS unset: the single configured rpId and app origin, exactly as before.
 * - The page's hostname is listed: that entry (rpId = the hostname, origin per `hostOrigin`).
 * - Otherwise: the single configured rpId and app origin, which passkeyOriginProblem then refuses on this page.
 *   An rpId is never taken from an unlisted hostname.
 */
export function passkeyDomainFor(cfg: Pick<PublicConfig, "rpId" | "appOrigin" | "rpIds">, location: { hostname: string }): PasskeyDomain {
  const host = location.hostname.toLowerCase();
  const h = cfg.rpIds?.find((e) => e.rpId === host);
  if (!h) return { rpId: cfg.rpId, appOrigin: cfg.appOrigin, listed: false };
  return { rpId: h.rpId, appOrigin: hostOrigin(cfg, h), listed: true };
}

/** A configured host other than this page's, with the address where its wallets open. */
export type OtherDoor = { host: string; url: string };

/** The configured hosts other than this page's passkey domain; empty unless more than one host is configured. */
export function otherDoors(cfg: Pick<PublicConfig, "rpId" | "appOrigin" | "rpIds">, location: { hostname: string; protocol: string; port: string }): OtherDoor[] {
  if (!cfg.rpIds || cfg.rpIds.length < 2) return [];
  const here = passkeyDomainFor(cfg, location).rpId;
  return cfg.rpIds.filter((h) => h.rpId !== here).map((h) => ({ host: h.rpId, url: hostUrl(cfg, h, location) }));
}

/**
 * Where a backup code's passkey can be used, seen from this page:
 * - "here": its rpId is this page's passkey domain
 * - "elsewhere": it is another host this deployment serves; the wallet opens at `url`
 * - "foreign": no host of this deployment
 */
export type BackupCodeDoor = { kind: "here" } | { kind: "elsewhere"; host: string; url: string } | { kind: "foreign" };

export function backupCodeDoor(
  codeRpId: string,
  cfg: Pick<PublicConfig, "rpId" | "appOrigin" | "rpIds">,
  location: { hostname: string; protocol: string; port: string },
): BackupCodeDoor {
  const rpId = codeRpId.toLowerCase();
  if (rpId === passkeyDomainFor(cfg, location).rpId) return { kind: "here" };
  const h = cfg.rpIds?.find((e) => e.rpId === rpId);
  return h ? { kind: "elsewhere", host: h.rpId, url: hostUrl(cfg, h, location) } : { kind: "foreign" };
}

export function publicConfig() {
  return parsePublicConfig(rawEnv());
}

/**
 * Whether a passkey for `rpId` can be used on this page. WebAuthn requires
 * the relying-party id to be the page's host or a parent domain of it; a
 * configured app origin must match exactly.
 */
export function passkeyOriginProblem(cfg: Pick<PublicConfig, "rpId" | "appOrigin">, location: { origin: string; hostname: string }): string | null {
  if (cfg.appOrigin && cfg.appOrigin !== location.origin) {
    return `Passkeys for Autumn work only on ${cfg.appOrigin}. This page is ${location.origin}.`;
  }
  const host = location.hostname.toLowerCase();
  if (host !== cfg.rpId && !host.endsWith(`.${cfg.rpId}`)) {
    return `This page (${host}) cannot use passkeys for ${cfg.rpId}. Open Autumn on ${cfg.rpId}.`;
  }
  return null;
}
