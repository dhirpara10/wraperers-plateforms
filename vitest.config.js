import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Tests run inside the real Workers runtime, against a throwaway local D1
// database built from the same migration files used in production.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ORIGIN: "https://app.wraperers.com",
            // Throwaway values for tests only. Real ones are Worker secrets.
            IP_SALT: "test-salt",
            TOTP_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.js"],
    },
  };
});
