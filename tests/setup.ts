import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    [
      "email_deliveries",
      "download_grants",
      "purchase_claim_tokens",
      "entitlements",
      "purchase_items",
      "purchases",
      "password_reset_tokens",
      "email_verification_tokens",
      "sessions",
      "auth_rate_limits",
      "orders",
      "stripe_events",
      "admin_login_attempts",
      "books",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`))
  );
  const objects = await env.BOOK_FILES.list();
  if (objects.objects.length) {
    await env.BOOK_FILES.delete(objects.objects.map((object) => object.key));
  }
});
