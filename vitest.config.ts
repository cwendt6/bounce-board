import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "worker/**/*.unit.test.ts"],
        },
      },
      {
        // Runs inside the Workers runtime (Miniflare) with the real Durable Object.
        // Needs `npm run build` first because the Worker serves dist/ as assets.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { DEV_FAKE_PAY: "true" } },
          }),
        ],
        test: { name: "worker", include: ["worker/**/*.worker.test.ts"] },
      },
    ],
  },
});
