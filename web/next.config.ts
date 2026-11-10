import type { NextConfig } from "next";

// Static export: the dapp is plain HTML/JS served from Cloudflare (wrangler.jsonc assets) and reads
// Avalanche directly from the browser (no server rendering, so no Cache Components / PPR). The node API is reached at NEXT_PUBLIC_NODE_URL (default /api).
const nextConfig: NextConfig = {
  output: "export",
  transpilePackages: ["@countersign/x402", "@countersign/core"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
