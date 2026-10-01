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
            // Never open a remote session to Cloudflare from tests (the AI binding would
            // otherwise try, using whatever account wrangler is logged into). CI has no creds.
            remoteBindings: false,
            // Pinned so a local .dev.vars can't leak in: no receiving address means no
            // facilitator calls, keeping tests offline.
            miniflare: {
              bindings: {
                DEV_FAKE_PAY: "true",
                ADMIN_TOKEN: "test-admin-token",
                PAY_TO_ADDRESS: "",
                MODERATION: "off",
              },
            },
          }),
        ],
        test: { name: "worker", include: ["worker/**/*.worker.test.ts"] },
      },
    ],
  },
});
