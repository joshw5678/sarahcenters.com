import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  logLevel: "error",
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          SESSION_SECRET: "test-session-secret-that-is-at-least-thirty-two-characters",
          PASSWORD_HASH_ITERATIONS: "1000",
          STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
          STRIPE_SECRET_KEY: "sk_test_dummy",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 20000,
  },
});
