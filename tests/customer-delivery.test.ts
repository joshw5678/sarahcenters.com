import Stripe from "stripe";
import * as z from "zod";
import { accountResponseSchema, messageResponseSchema, libraryResponseSchema, downloadResponseSchema, parseFormats } from "../shared/contracts.js";
import type { EmailMessage, StripeGateway, StripeSession, UserRow, PurchaseRow } from "../worker/types.js";
import type { CountRow } from "../worker/rows.js";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test fixture to exist.");
  return value;
}
async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const value: unknown = await response.json();
  return schema.parse(value);
}
function mockStripe(sessions: Partial<StripeGateway["checkout"]["sessions"]>): StripeGateway {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected Stripe call."); };
  return { prices: { retrieve: unexpected }, checkout: { sessions: { create: unexpected, retrieve: unexpected, ...sessions } }, webhooks: new Stripe("sk_test_dummy").webhooks };
}
function dynamicLines(params: Stripe.Checkout.SessionCreateParams, prefix = "price_dynamic") {
  return required(params.line_items).map((line, index) => {
    const data = required(line.price_data);
    const product = required(data.product_data);
    return { price: { id: `${prefix}_${index}`, unit_amount: required(data.unit_amount), currency: data.currency, product: { metadata: z.record(z.string(), z.string()).parse(product.metadata) } } };
  });
}
interface RequestOptions { method?: string; body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string> }
interface TestUser { id: string; email: string; password: string }
import { env, exports as workerExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleAccountRequest } from "../worker/accounts.js";
import {
  createCustomerSession,
  hashPassword,
  hashToken,
  passwordIterations,
  validatePassword,
  verifyPassword,
} from "../worker/customer-auth.js";
import { ensureSeedBooks, findOrderById, listBooks } from "../worker/db.js";
import { createAwsSesInput } from "../worker/email.js";
import {
  createCheckout,
  normalizeCheckoutItems,
  processStripeEvent,
} from "../worker/stripe.js";

const ORIGIN = "https://example.com";
const GOOD_PASSWORD = "Strong!Pass234";

async function workerRequest(path: string, { method = "GET", body, cookie, csrf, headers = {} }: RequestOptions = {}) {
  const requestHeaders = new Headers({ Accept: "application/json", ...headers });
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  if (method !== "GET" && method !== "HEAD") requestHeaders.set("Origin", ORIGIN);
  if (cookie) requestHeaders.set("Cookie", cookie);
  if (csrf) requestHeaders.set("X-CSRF-Token", csrf);
  return workerExports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? null : JSON.stringify(body),
    })
  );
}



async function insertUser(email: string, { verified = true, password = GOOD_PASSWORD } = {}) {
  const id = `usr_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users
       (id, email, email_normalized, password_hash, display_name,
        email_verified_at, created_at, updated_at, last_login_at, status)
     VALUES (?, ?, ?, ?, 'Test Reader', ?, ?, ?, NULL, 'active')`
  )
    .bind(
      id,
      email,
      email.toLowerCase(),
      await hashPassword(password, 1000),
      verified ? now : null,
      now,
      now
    )
    .run();
  return { id, email, password };
}

async function sessionFor(user: TestUser) {
  const request = new Request(`${ORIGIN}/login.html`, {
    headers: { "User-Agent": "Vitest", "CF-Connecting-IP": "192.0.2.1" },
  });
  const session = await createCustomerSession(request, env, user.id);
  return { ...session, cookie: session.cookie.split(";")[0] ?? "" };
}

async function resetTokenFor(user: TestUser) {
  const token = `reset_${crypto.randomUUID()}`;
  const now = new Date();
  await env.DB.prepare(
    `INSERT INTO password_reset_tokens
       (id, user_id, token_hash, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  )
    .bind(
      `prt_${crypto.randomUUID()}`,
      user.id,
      await hashToken(token),
      now.toISOString(),
      new Date(now.getTime() + 60000).toISOString()
    )
    .run();
  return token;
}

async function insertPurchase(userId: string, bookId = "through", formats = ["epub", "pdf"]) {
  await ensureSeedBooks(env);
  const purchaseId = `pur_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO purchases
         (id, user_id, order_id, pending_email_normalized, stripe_customer_id,
          stripe_checkout_session_id, stripe_payment_intent_id, stripe_event_id,
          amount_paid, currency, purchased_at, payment_status,
          entitlement_status, refund_status, revoked_at, revocation_reason,
          created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'cus_test', ?, ?, ?, 499, 'usd', ?, 'paid',
               'active', 'none', NULL, '', ?, ?)`
    ).bind(
      purchaseId,
      userId,
      `cs_test_${crypto.randomUUID().replaceAll("-", "")}`,
      `pi_${crypto.randomUUID()}`,
      `evt_${crypto.randomUUID()}`,
      now,
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO purchase_items
         (id, purchase_id, book_id, stripe_price_id, quantity, unit_amount,
          currency, formats_json, created_at)
       VALUES (?, ?, ?, 'price_test', 1, 499, 'usd', ?, ?)`
    ).bind(`pit_${crypto.randomUUID()}`, purchaseId, bookId, JSON.stringify(formats), now),
    env.DB.prepare(
      `INSERT INTO entitlements
         (id, user_id, purchase_id, book_id, formats_json, status,
          granted_at, revoked_at, revocation_reason)
       VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, '')`
    ).bind(
      `ent_${crypto.randomUUID()}`,
      userId,
      purchaseId,
      bookId,
      JSON.stringify(formats),
      now
    ),
  ]);
  return purchaseId;
}

describe("customer authentication", () => {
  it.each([
    ["null body", null],
    ["array body", []],
    ["object email", { email: { value: "reader@example.com" }, password: GOOD_PASSWORD }],
    ["object password", { email: "reader@example.com", password: { value: GOOD_PASSWORD } }],
  ])("rejects malformed registration data: %s", async (_label, body) => {
    const response = await workerRequest("/api/account/register", { method: "POST", body });
    expect(response.status).toBe(400);
    const count = required(await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<CountRow>());
    expect(count.count).toBe(0);
  });

  it("hashes passwords with PBKDF2 and enforces strong passwords", async () => {
    const encoded = await hashPassword(GOOD_PASSWORD, 1000);
    expect(encoded).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(encoded).not.toContain(GOOD_PASSWORD);
    expect(await verifyPassword(GOOD_PASSWORD, encoded)).toBe(true);
    expect(await verifyPassword("wrong-password", encoded)).toBe(false);
    expect(() => validatePassword("short", "reader@example.com")).toThrow();
    expect(passwordIterations({})).toBe(100000);
    expect(passwordIterations({ PASSWORD_HASH_ITERATIONS: "100001" })).toBe(100000);
  });

  it("registers once, prevents duplicates, and returns generic invalid login errors", async () => {
    const first = await workerRequest("/api/account/register", {
      method: "POST",
      body: { email: "Reader@Example.com", password: GOOD_PASSWORD, displayName: "Reader" },
    });
    expect(first.status).toBe(201);
    const stored = required(await env.DB.prepare("SELECT * FROM users WHERE email_normalized = ?")
      .bind("reader@example.com")
      .first<UserRow>());
    expect(stored).toBeTruthy();
    expect(stored.password_hash).not.toContain(GOOD_PASSWORD);

    const duplicate = await workerRequest("/api/account/register", {
      method: "POST",
      body: { email: "reader@example.com", password: GOOD_PASSWORD, displayName: "Other" },
    });
    expect(duplicate.status).toBe(202);
    const count = required(await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<CountRow>());
    expect(Number(count.count)).toBe(1);

    const invalid = await workerRequest("/api/account/login", {
      method: "POST",
      body: { email: "unknown@example.com", password: GOOD_PASSWORD },
    });
    expect(invalid.status).toBe(401);
    expect((await json(invalid, z.object({ error: z.string() }))).error).toBe("Invalid email or password.");
  });

  it("delivers an account-confirmation email and completes the verification flow", async () => {
    const sent: Array<EmailMessage & { dedupeKey: string }> = [];
    const request = new Request(`${ORIGIN}/api/account/register`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        email: "confirm@example.com",
        password: GOOD_PASSWORD,
        displayName: "Confirmed Reader",
      }),
    });
    const response = required(await handleAccountRequest(
      request,
      {
        ...env,
        EMAIL_SENDER: {
          async send(message) {
            sent.push(message);
            return { id: "ses_message_test" };
          },
        },
      },
      new URL(request.url),
      (incoming) => incoming.json()
    ));
    expect(response.status).toBe(201);
    expect((await json(response, messageResponseSchema)).emailSent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(required(sent[0]).subject).toMatch(/verify/i);

    const verificationUrl = required(sent[0]).text.match(/https:\/\/\S+/)?.[0];
    const token = new URL(required(verificationUrl)).hash.replace(/^#token=/, "");
    const verified = await workerRequest("/api/account/verify-email", {
      method: "POST",
      body: { token: decodeURIComponent(token) },
    });
    expect(verified.status).toBe(200);

    const login = await workerRequest("/api/account/login", {
      method: "POST",
      body: { email: "confirm@example.com", password: GOOD_PASSWORD },
    });
    expect(login.status).toBe(200);
    expect((await json(login, accountResponseSchema)).user.emailVerified).toBe(true);
  });

  it("maps transactional messages to the AWS SES v2 format", () => {
    const input = createAwsSesInput(
      {
        EMAIL_FROM: "S.E. Centers <books@tartarianchronicles.com>",
        EMAIL_REPLY_TO: "author@tartarianchronicles.com",
        AWS_SES_CONFIGURATION_SET: "tartarian-transactional",
      },
      {
        to: "reader@example.com",
        subject: "Verify your account",
        html: "<p>Verify</p>",
        text: "Verify",
      }
    );
    expect(input).toEqual({
      FromEmailAddress: "S.E. Centers <books@tartarianchronicles.com>",
      Destination: { ToAddresses: ["reader@example.com"] },
      Content: {
        Simple: {
          Subject: { Charset: "UTF-8", Data: "Verify your account" },
          Body: {
            Html: { Charset: "UTF-8", Data: "<p>Verify</p>" },
            Text: { Charset: "UTF-8", Data: "Verify" },
          },
        },
      },
      ReplyToAddresses: ["author@tartarianchronicles.com"],
      ConfigurationSetName: "tartarian-transactional",
    });
  });

  it("verifies email with a hashed, expiring, single-use token", async () => {
    const user = await insertUser("verify@example.com", { verified: false });
    const rawToken = "verification-token-that-is-long-enough-1234567890";
    const now = new Date();
    await env.DB.prepare(
      `INSERT INTO email_verification_tokens
         (id, user_id, token_hash, created_at, expires_at, used_at)
       VALUES ('evt_test', ?, ?, ?, ?, NULL)`
    )
      .bind(
        user.id,
        await hashToken(rawToken),
        now.toISOString(),
        new Date(now.getTime() + 60000).toISOString()
      )
      .run();
    const expiredRaw = "expired-verification-token-that-is-long-enough-99999";
    await env.DB.prepare(
      `INSERT INTO email_verification_tokens
         (id, user_id, token_hash, created_at, expires_at, used_at)
       VALUES ('evt_expired', ?, ?, ?, ?, NULL)`
    )
      .bind(
        user.id,
        await hashToken(expiredRaw),
        now.toISOString(),
        new Date(now.getTime() - 1000).toISOString()
      )
      .run();
    expect(
      (
        await workerRequest("/api/account/verify-email", {
          method: "POST",
          body: { token: expiredRaw },
        })
      ).status
    ).toBe(400);
    const verified = await workerRequest("/api/account/verify-email", {
      method: "POST",
      body: { token: rawToken },
    });
    expect(verified.status).toBe(200);
    const row = required(await env.DB.prepare("SELECT email_verified_at FROM users WHERE id = ?")
      .bind(user.id)
      .first<Pick<UserRow, "email_verified_at">>());
    expect(row.email_verified_at).toBeTruthy();
    const reused = await workerRequest("/api/account/verify-email", {
      method: "POST",
      body: { token: rawToken },
    });
    expect(reused.status).toBe(400);
  });

  it("expires reset links, uses valid links once, and revokes active sessions", async () => {
    const user = await insertUser("reset@example.com");
    const active = await sessionFor(user);
    const expiredToken = "expired-password-token-that-is-long-enough-000000";
    const validToken = "valid-password-token-that-is-long-enough-11111111";
    const now = new Date();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO password_reset_tokens VALUES
         ('prt_expired', ?, ?, ?, ?, NULL)`
      ).bind(
        user.id,
        await hashToken(expiredToken),
        now.toISOString(),
        new Date(now.getTime() - 1000).toISOString()
      ),
      env.DB.prepare(
        `INSERT INTO password_reset_tokens VALUES
         ('prt_valid', ?, ?, ?, ?, NULL)`
      ).bind(
        user.id,
        await hashToken(validToken),
        now.toISOString(),
        new Date(now.getTime() + 60000).toISOString()
      ),
    ]);
    expect(
      (
        await workerRequest("/api/account/reset-password", {
          method: "POST",
          body: { token: expiredToken, password: "New!ReaderPass456" },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await workerRequest("/api/account/reset-password", {
          method: "POST",
          body: { token: validToken, password: "New!ReaderPass456" },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await workerRequest("/api/account/reset-password", {
          method: "POST",
          body: { token: validToken, password: "Another!Pass789" },
        })
      ).status
    ).toBe(400);
    const me = await workerRequest("/api/account/me", { cookie: active.cookie });
    expect(me.status).toBe(401);
  });

  it.each<[string, { newPassword?: string; email?: string }]>([
    ["password", { newPassword: "Changed!SecurePass456" }],
    ["email", { email: "changed-reader@example.com" }],
    ["password and email", { newPassword: "Changed!SecurePass456", email: "changed-reader@example.com" }],
  ])("invalidates outstanding reset links after changing %s", async (_label, changes) => {
    const user = await insertUser("reader@example.com");
    const session = await sessionFor(user);
    const otherSession = await sessionFor(user);
    const oldTokens = [await resetTokenFor(user), await resetTokenFor(user)];
    const otherUser = await insertUser("other-reader@example.com");
    const otherToken = await resetTokenFor(otherUser);

    const updated = await workerRequest("/api/account", {
      method: "PATCH",
      cookie: session.cookie,
      csrf: session.csrfToken,
      body: { currentPassword: GOOD_PASSWORD, ...changes },
    });
    expect(updated.status).toBe(200);

    for (const token of oldTokens) {
      const reset = await workerRequest("/api/account/reset-password", {
        method: "POST",
        body: { token, password: "Stale!Password789" },
      });
      expect(reset.status).toBe(400);
    }
    const login = await workerRequest("/api/account/login", {
      method: "POST",
      body: {
        email: changes.email || user.email,
        password: changes.newPassword || GOOD_PASSWORD,
      },
    });
    expect(login.status).toBe(200);
    expect((await workerRequest("/api/account/me", { cookie: session.cookie })).status).toBe(200);
    expect((await workerRequest("/api/account/me", { cookie: otherSession.cookie })).status)
      .toBe(changes.newPassword ? 401 : 200);

    const otherReset = await workerRequest("/api/account/reset-password", {
      method: "POST",
      body: { token: otherToken, password: "Unrelated!Pass789" },
    });
    expect(otherReset.status).toBe(200);
    const freshReset = await workerRequest("/api/account/reset-password", {
      method: "POST",
      body: { token: await resetTokenFor(user), password: "Fresh!SecurePass789" },
    });
    expect(freshReset.status).toBe(200);
  });

  it.each([
    ["profile update", { displayName: "Updated Reader" }, 200],
    ["rejected password change", { currentPassword: "incorrect", newPassword: "Changed!SecurePass456" }, 400],
  ])("preserves reset links after a %s", async (_label, changes, expectedStatus) => {
    const user = await insertUser("reader@example.com");
    const session = await sessionFor(user);
    const token = await resetTokenFor(user);
    const updated = await workerRequest("/api/account", {
      method: "PATCH",
      cookie: session.cookie,
      csrf: session.csrfToken,
      body: changes,
    });
    expect(updated.status).toBe(expectedStatus);
    const reset = await workerRequest("/api/account/reset-password", {
      method: "POST",
      body: { token, password: "Fresh!SecurePass789" },
    });
    expect(reset.status).toBe(200);
  });

  it("creates, protects, expires, and revokes sessions on logout", async () => {
    const user = await insertUser("session@example.com");
    const expiredSession = await sessionFor(user);
    const me = await workerRequest("/api/account/me", { cookie: expiredSession.cookie });
    expect(me.status).toBe(200);
    expect((await json(me, accountResponseSchema)).user.email).toBe(user.email);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), expiredSession.id)
      .run();
    expect((await workerRequest("/api/account/me", { cookie: expiredSession.cookie })).status).toBe(401);
    const session = await sessionFor(user);
    const logout = await workerRequest("/api/account/logout", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrfToken,
      body: {},
    });
    expect(logout.status).toBe(200);
    expect((await workerRequest("/api/account/me", { cookie: session.cookie })).status).toBe(401);
  });
});

describe("checkout and Stripe fulfillment", () => {
  it("uses server catalog pricing and rejects browser-controlled price fields", async () => {
    await ensureSeedBooks(env);
    const books = await listBooks(env);
    expect(() =>
      normalizeCheckoutItems([{ bookId: "through", quantity: 1, price: 1 }], books)
    ).toThrow(/unsupported/i);

    const user = await insertUser("buyer@example.com");
    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    const stripe = mockStripe({
      create: async (params) => {
        captured = params;
        return { id: "cs_test_checkoutcreation123", url: "https://checkout.stripe.test/session", line_items: { data: dynamicLines(params) } };
      },
    });
    const result = await createCheckout(
      new Request(`${ORIGIN}/api/checkout/session`),
      { ...env, STRIPE_CLIENT: stripe },
      [{ bookId: "through", quantity: 1, includePdf: true }],
      { userId: user.id, email: user.email, displayName: "Buyer" }
    );
    expect(result.url).toContain("checkout.stripe.test");
    expect(required(required(required(captured).line_items)[0]).price_data?.unit_amount).toBe(499);
    expect(required(captured).metadata?.userId).toBe(user.id);
    expect(required(captured).success_url).toContain("#session_id=");
  });

  it("rejects invalid webhook signatures", async () => {
    const response = await workerRequest("/api/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": "t=1,v1=invalid" },
      body: { id: "evt_invalid" },
    });
    expect(response.status).toBe(400);
  });

  it("creates one purchase, entitlement, and confirmation record idempotently", async () => {
    const user = await insertUser("paid@example.com");
    let checkoutParams: Stripe.Checkout.SessionCreateParams | undefined;
    const createdSession: StripeSession = { id: "cs_test_paidcheckout12345", url: "https://checkout.stripe.test/paid", line_items: { data: [] } };
    const stripe = mockStripe({
      create: async (params) => {
        checkoutParams = params;
        createdSession.line_items = { data: dynamicLines(params, "price_paid_dynamic") };
        return createdSession;
      },
      retrieve: async () => paidSession,
    });
    const testEnv = { ...env, STRIPE_CLIENT: stripe };
    const checkout = await createCheckout(
      new Request(`${ORIGIN}/api/checkout/session`),
      testEnv,
      [{ bookId: "through", quantity: 1, includePdf: true }],
      { userId: user.id, email: user.email, displayName: "Paid Reader" }
    );
    const order = required(await findOrderById(env, checkout.orderId));
    const paidSession: StripeSession = {
      id: createdSession.id,
      payment_status: "paid",
      status: "complete",
      metadata: z.record(z.string(), z.string()).parse(required(checkoutParams).metadata),
      client_reference_id: order.id,
      amount_subtotal: 499,
      amount_total: 499,
      currency: "usd",
      customer: "cus_paid",
      customer_details: { email: user.email, name: "Paid Reader", address: null },
      payment_intent: {
        id: "pi_paid",
        latest_charge: { id: "ch_paid", receipt_url: "https://stripe.test/receipt" },
      },
      line_items: {
        data: [
          {
            quantity: 1,
            price: {
              id: "price_paid_dynamic_0",
              unit_amount: 499,
              currency: "usd",
              product: { metadata: { bookId: "through", format: "epub_pdf" } },
            },
          },
        ],
      },
    };
    const event = {
      id: "evt_paid",
      type: "checkout.session.completed",
      data: { object: { id: paidSession.id } },
    };
    const request = new Request(`${ORIGIN}/api/stripe/webhook`);
    await processStripeEvent(request, testEnv, event);
    await processStripeEvent(request, testEnv, event);
    const purchase = required(await env.DB.prepare(
      "SELECT id FROM purchases WHERE stripe_checkout_session_id = ?"
    ).bind(paidSession.id).first<{ id: string }>());
    const counts = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM purchases WHERE id = ?").bind(purchase.id).first<CountRow>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM purchase_items WHERE purchase_id = ?").bind(purchase.id).first<CountRow>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE purchase_id = ?").bind(purchase.id).first<CountRow>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM email_deliveries WHERE purchase_id = ?").bind(purchase.id).first<CountRow>(),
    ]);
    expect(counts.map((row) => Number(required(row).count))).toEqual([1, 1, 1, 1]);
    const entitlement = required(await env.DB.prepare("SELECT formats_json FROM entitlements").first<{ formats_json: string }>());
    expect(parseFormats(entitlement.formats_json)).toEqual(["epub", "pdf"]);
  });

  it("revokes access after a full refund and preserves purchase history", async () => {
    const user = await insertUser("refund@example.com");
    const purchaseId = await insertPurchase(user.id);
    const purchase = required(await env.DB.prepare("SELECT * FROM purchases WHERE id = ?")
      .bind(purchaseId)
      .first<PurchaseRow>());
    await processStripeEvent(new Request(`${ORIGIN}/api/stripe/webhook`), env, {
      id: "evt_refund",
      type: "charge.refunded",
      data: {
        object: {
          payment_intent: purchase.stripe_payment_intent_id,
          amount: purchase.amount_paid,
          amount_refunded: purchase.amount_paid,
        },
      },
    });
    const updated = required(await env.DB.prepare("SELECT * FROM purchases WHERE id = ?")
      .bind(purchaseId)
      .first<PurchaseRow>());
    expect(updated.refund_status).toBe("full");
    expect(updated.entitlement_status).toBe("revoked");
    expect(await env.DB.prepare("SELECT * FROM entitlements WHERE purchase_id = ?").bind(purchaseId).first())
      .toMatchObject({ status: "revoked" });
  });
});

describe("private library, downloads, and guest claims", () => {
  it.each<[string, Array<[string, Record<string, unknown>]>, number]>([
    ["full refund", [["charge.refunded", { amount: 399, amount_refunded: 399 }]], 409],
    ["open dispute", [["charge.dispute.created", {}]], 409],
    ["partial refund", [["charge.refunded", { amount: 399, amount_refunded: 100 }]], 200],
    ["won dispute", [["charge.dispute.created", {}], ["charge.dispute.closed", { status: "won" }]], 200],
  ])("preserves purchase restrictions when claiming after a %s", async (_label, events, expectedStatus) => {
    await ensureSeedBooks(env);
    const user = await insertUser("guest@example.com");
    const session = await sessionFor(user);
    const token = "guest-claim-policy-token-that-is-long-enough-12345";
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO purchases
           (id, pending_email_normalized, stripe_checkout_session_id,
            stripe_payment_intent_id, stripe_event_id, amount_paid, currency,
            purchased_at, payment_status, entitlement_status, created_at, updated_at)
         VALUES ('pur_claim_policy', ?, 'cs_test_claimpolicy12345',
                 'pi_claim_policy', 'evt_claim_policy', 399, 'usd', ?, 'paid',
                 'pending_claim', ?, ?)`
      ).bind(user.email, now, now, now),
      env.DB.prepare(
        `INSERT INTO purchase_items
           (id, purchase_id, book_id, stripe_price_id, quantity, unit_amount,
            currency, formats_json, created_at)
         VALUES ('pit_claim_policy', 'pur_claim_policy', 'through', 'price_claim_policy',
                 1, 399, 'usd', '["epub"]', ?)`
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO purchase_claim_tokens
           (id, purchase_id, email_normalized, token_hash, created_at, expires_at)
         VALUES ('pct_claim_policy', 'pur_claim_policy', ?, ?, ?, ?)`
      ).bind(user.email, await hashToken(token), now, new Date(Date.now() + 60000).toISOString()),
    ]);
    for (const [type, object] of events) {
      await processStripeEvent(new Request(`${ORIGIN}/api/stripe/webhook`), env, {
        id: `evt_${crypto.randomUUID()}`,
        type,
        data: { object: { payment_intent: "pi_claim_policy", ...object } },
      });
    }
    const before = required(await env.DB.prepare("SELECT * FROM purchases WHERE id = 'pur_claim_policy'")
      .first<PurchaseRow>());
    const claimed = await workerRequest("/api/account/claim-purchase", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrfToken,
      body: { token },
    });
    expect(claimed.status).toBe(expectedStatus);
    const after = required(await env.DB.prepare("SELECT * FROM purchases WHERE id = 'pur_claim_policy'")
      .first<PurchaseRow>());
    const claim = required(await env.DB.prepare(
      "SELECT used_at, claimed_by_user_id FROM purchase_claim_tokens WHERE id = 'pct_claim_policy'"
    ).first<Record<string, unknown>>());
    const library = await workerRequest("/api/library", { cookie: session.cookie });
    const books = (await json(library, libraryResponseSchema)).books;
    const grant = await workerRequest("/api/library/through/download", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrfToken,
      body: { format: "epub" },
    });
    if (expectedStatus === 409) {
      expect(after).toEqual(before);
      expect(claim).toEqual({ used_at: null, claimed_by_user_id: null });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements").first())
        .toEqual({ count: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM email_deliveries").first())
        .toEqual({ count: 0 });
      expect(books).toHaveLength(0);
      expect(grant.status).toBe(403);
    } else {
      expect(after).toMatchObject({
        user_id: user.id,
        payment_status: before.payment_status,
        refund_status: before.refund_status,
        entitlement_status: "active",
      });
      expect(claim.used_at).toBeTruthy();
      expect(claim.claimed_by_user_id).toBe(user.id);
      expect(books.map((book) => book.id)).toEqual(["through"]);
      expect(grant.status).toBe(200);
    }
  });

  it("isolates libraries and protects EPUB/PDF downloads with expiring one-use grants", async () => {
    const owner = await insertUser("owner@example.com");
    const stranger = await insertUser("stranger@example.com");
    await insertPurchase(owner.id, "through", ["epub", "pdf"]);
    const ownerSession = await sessionFor(owner);
    const strangerSession = await sessionFor(stranger);
    await env.BOOK_FILES.put("books/through/through-the-veil.epub", "epub bytes");
    await env.BOOK_FILES.put("books/through/through-the-veil.pdf", "pdf bytes");

    expect((await workerRequest("/api/library")).status).toBe(401);
    const library = await workerRequest("/api/library", { cookie: ownerSession.cookie });
    expect(library.status).toBe(200);
    expect((await json(library, libraryResponseSchema)).books).toHaveLength(1);
    const isolated = await workerRequest("/api/library", { cookie: strangerSession.cookie });
    expect((await json(isolated, libraryResponseSchema)).books).toHaveLength(0);

    const arbitrary = await workerRequest("/api/library/through/download", {
      method: "POST",
      cookie: ownerSession.cookie,
      csrf: ownerSession.csrfToken,
      body: { format: "epub", objectKey: "private/other.epub" },
    });
    expect(arbitrary.status).toBe(400);
    const unauthorized = await workerRequest("/api/library/through/download", {
      method: "POST",
      cookie: strangerSession.cookie,
      csrf: strangerSession.csrfToken,
      body: { format: "epub" },
    });
    expect(unauthorized.status).toBe(403);

    for (const [format, contentType] of [
      ["epub", "application/epub+zip"],
      ["pdf", "application/pdf"],
    ]) {
      const grantResponse = await workerRequest("/api/library/through/download", {
        method: "POST",
        cookie: ownerSession.cookie,
        csrf: ownerSession.csrfToken,
        body: { format },
      });
      expect(grantResponse.status).toBe(200);
      const grant = await json(grantResponse, downloadResponseSchema);
      const download = await workerRequest(grant.url, { cookie: ownerSession.cookie });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe(contentType);
      expect(download.headers.get("cache-control")).toContain("no-store");
      expect((await workerRequest(grant.url, { cookie: ownerSession.cookie })).status).toBe(404);
    }

    const expiredResponse = await workerRequest("/api/library/through/download", {
      method: "POST",
      cookie: ownerSession.cookie,
      csrf: ownerSession.csrfToken,
      body: { format: "epub" },
    });
    const expired = await json(expiredResponse, downloadResponseSchema);
    await env.DB.prepare("UPDATE download_grants SET expires_at = ? WHERE used_at IS NULL")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await workerRequest(expired.url, { cookie: ownerSession.cookie })).status).toBe(404);

    await env.BOOK_FILES.delete("books/through/through-the-veil.epub");
    const missingResponse = await workerRequest("/api/library/through/download", {
      method: "POST",
      cookie: ownerSession.cookie,
      csrf: ownerSession.csrfToken,
      body: { format: "epub" },
    });
    const missing = await json(missingResponse, downloadResponseSchema);
    expect((await workerRequest(missing.url, { cookie: ownerSession.cookie })).status).toBe(404);
  });

  it("claims a guest purchase once and only for the matching verified email", async () => {
    await ensureSeedBooks(env);
    const user = await insertUser("guest@example.com");
    const session = await sessionFor(user);
    const wrongUser = await insertUser("someone-else@example.com");
    const wrongSession = await sessionFor(wrongUser);
    const purchaseId = `pur_${crypto.randomUUID()}`;
    const rawToken = "guest-purchase-claim-token-that-is-long-enough-12345";
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO purchases
           (id, user_id, order_id, pending_email_normalized, stripe_customer_id,
            stripe_checkout_session_id, stripe_payment_intent_id, stripe_event_id,
            amount_paid, currency, purchased_at, payment_status, entitlement_status,
            refund_status, revoked_at, revocation_reason, created_at, updated_at)
         VALUES (?, NULL, NULL, 'guest@example.com', 'cus_guest', 'cs_test_guest12345',
                 'pi_guest', 'evt_guest', 399, 'usd', ?, 'paid', 'pending_claim',
                 'none', NULL, '', ?, ?)`
      ).bind(purchaseId, now, now, now),
      env.DB.prepare(
        `INSERT INTO purchase_items
           (id, purchase_id, book_id, stripe_price_id, quantity, unit_amount,
            currency, formats_json, created_at)
         VALUES ('pit_guest', ?, 'through', 'price_guest', 1, 399, 'usd',
                 '["epub"]', ?)`
      ).bind(purchaseId, now),
      env.DB.prepare(
        `INSERT INTO purchase_claim_tokens
           (id, purchase_id, email_normalized, token_hash, created_at, expires_at,
            used_at, claimed_by_user_id)
         VALUES ('pct_guest', ?, 'guest@example.com', ?, ?, ?, NULL, NULL)`
      ).bind(
        purchaseId,
        await hashToken(rawToken),
        now,
        new Date(Date.now() + 60000).toISOString()
      ),
    ]);
    const wrongClaim = await workerRequest("/api/account/claim-purchase", {
      method: "POST",
      cookie: wrongSession.cookie,
      csrf: wrongSession.csrfToken,
      body: { token: rawToken },
    });
    expect(wrongClaim.status).toBe(400);
    const claimed = await workerRequest("/api/account/claim-purchase", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrfToken,
      body: { token: rawToken },
    });
    expect(claimed.status).toBe(200);
    const purchase = required(await env.DB.prepare("SELECT * FROM purchases WHERE id = ?")
      .bind(purchaseId)
      .first<PurchaseRow>());
    expect(purchase.user_id).toBe(user.id);
    expect(await env.DB.prepare("SELECT * FROM entitlements WHERE purchase_id = ?").bind(purchaseId).first())
      .toBeTruthy();
    const duplicate = await workerRequest("/api/account/claim-purchase", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrfToken,
      body: { token: rawToken },
    });
    expect(duplicate.status).toBe(400);
  });
});
