import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache binding: every route that reads data is dynamic, and the pages are static assets.
const config = defineCloudflareConfig({});

// The Workers build uses webpack with web/ as the tracing root (see next.config.ts): Turbopack would need
// the repository root as its root to reach ../core and ../agent, and OpenNext expects web/ as the root.
config.buildCommand = "AUTUMN_NEXT_TARGET=cloudflare npx next build --webpack";

export default config;
