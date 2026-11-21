/**
 * Public (browser) settings. Next.js inlines `process.env.NEXT_PUBLIC_…` only
 * when each name is written out literally, so they are read one by one here.
 *
 * Required for the live app:
 * - NEXT_PUBLIC_AUTUMN_GOLD_BUYER_ADDRESS   the deployed GoldBuyer
 * - NEXT_PUBLIC_AUTUMN_GOLD_BUYER_DEPLOY_BLOCK  its deployment block (purchase history starts there)
 * - NEXT_PUBLIC_AUTUMN_RP_ID                the passkey relying-party id: the app's domain ("localhost" in development)
 * Optional:
 * - NEXT_PUBLIC_AUTUMN_APP_ORIGIN           the app's origin, e.g. https://autumn.example; the app refuses to
 *                                           create passkeys from any other origin
 * - NEXT_PUBLIC_AUTUMN_CELO_RPC_URL         browser reads (default https://forno.celo.org)
 * - NEXT_PUBLIC_AUTUMN_LOGS_BLOCK_RANGE     max blocks per eth_getLogs (default 5000, forno's limit)
 */
import { DEFAULT_CELO_RPC_URL } from "@autumn/core";
import type { Address } from "./autumn";

export type PublicConfig = {
  goldBuyer: Address;
  goldBuyerDeployBlock: bigint;
  rpId: string;
  appOrigin: string | null;
  rpcUrl: string;
  logBlockRange: bigint;
};

export type RawPublicEnv = {
  goldBuyer?: string;
  deployBlock?: string;
  rpId?: string;
  appOrigin?: string;
  rpcUrl?: string;
  logBlockRange?: string;
};

function rawEnv(): RawPublicEnv {
  return {
    goldBuyer: process.env.NEXT_PUBLIC_AUTUMN_GOLD_BUYER_ADDRESS,
    deployBlock: process.env.NEXT_PUBLIC_AUTUMN_GOLD_BUYER_DEPLOY_BLOCK,
    rpId: process.env.NEXT_PUBLIC_AUTUMN_RP_ID,
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
  const rpId = raw.rpId?.trim().toLowerCase();
  if (!rpId || !/^[a-z0-9.-]+$/.test(rpId) || rpId.startsWith(".") || rpId.endsWith(".")) problems.push("NEXT_PUBLIC_AUTUMN_RP_ID");
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
      rpcUrl: raw.rpcUrl?.trim() || DEFAULT_CELO_RPC_URL,
      logBlockRange: range ? BigInt(range) : 5000n,
    },
  };
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
