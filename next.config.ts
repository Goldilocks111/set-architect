import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Playwright MCP writes logs into .playwright-mcp/ at runtime; without this ignore,
  // every write triggers a Turbopack rebuild -> Fast Refresh loop (page "flickers").
  watchOptions: {
    ignored: ["**/.playwright-mcp/**", "**/data/cache/**", "**/data/index/**"],
  },
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
