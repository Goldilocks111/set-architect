import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // NOTE: Turbopack (Next 16) has no watch-ignore option. Any runtime write inside the
  // project triggers a rebuild -> Fast Refresh loop (page "flickers"). Therefore ALL
  // runtime data (adjacency index, caches, analysis results) lives OUTSIDE the project,
  // in ~/.setarchitect (see src/lib/dataDir.ts). Never write runtime files into the repo.
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
