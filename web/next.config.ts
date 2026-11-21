import path from "node:path";
import type { NextConfig } from "next";

/** core/ and agent/ live next to web/ and are linked as file: dependencies. */
const repoRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Do not write AGENTS.md into the project on `next dev`.
  agentRules: false,
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
