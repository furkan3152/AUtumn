import path from "node:path";
import type { NextConfig } from "next";

/** core/ and agent/ live next to web/ and are linked as file: dependencies. */
const repoRoot = path.join(__dirname, "..");

const origin = (url: string | undefined, fallback: string) => {
  try {
    return new URL(url?.trim() || fallback).origin;
  } catch {
    return fallback;
  }
};

/**
 * What the browser may load. Scripts and styles from this origin only ('unsafe-inline' for Next's inline bootstrap
 * and React's style attributes; 'unsafe-eval' in development for its error overlay). Network reads: this server,
 * the Celo RPC the app is built with (and the SDK's own default Celo RPC), and the Altana relay.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${origin(process.env.NEXT_PUBLIC_AUTUMN_CELO_RPC_URL, "https://forno.celo.org")} https://celo-rpc.publicnode.com https://relay.altana.network`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Do not write AGENTS.md into the project on `next dev`.
  agentRules: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

if (process.env.AUTUMN_NEXT_TARGET !== "cloudflare") {
  // `next dev` / `next build` (Turbopack): the repository root as root, so ../core and ../agent resolve.
  nextConfig.turbopack = { root: repoRoot };
  nextConfig.outputFileTracingRoot = repoRoot;
  // The runner and Postgres run as plain Node modules in route handlers, never in the browser bundle.
  nextConfig.serverExternalPackages = ["@autumn/agent", "pg"];
}
// The Workers build (open-next.config.ts) runs `next build --webpack` with web/ as the root, which OpenNext
// expects: webpack bundles @autumn/agent and @autumn/core into the server code, and OpenNext bundles the rest
// (pg included) into the Worker. Workers have no external packages; everything is bundled.

export default nextConfig;
