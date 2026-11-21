import path from "node:path";
import type { NextConfig } from "next";

/** core/ and agent/ live next to web/ and are linked as file: dependencies. */
const repoRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Do not write AGENTS.md into the project on `next dev`.
  agentRules: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // The runner and Postgres run as plain Node modules in route handlers, never in the browser bundle.
  serverExternalPackages: ["@autumn/agent", "pg"],
};

export default nextConfig;
