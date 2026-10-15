# Tartarian Chronicles storefront

This project serves the S.E. Centers storefront from a Cloudflare Worker. It uses Cloudflare D1 for catalog, order, customer, session, purchase, and entitlement data; private R2 buckets for covers and book files; Stripe Checkout for payments; and a configurable HTTP email adapter for transactional mail.

## Manual launch checklist

Complete these steps outside the repository before deploying:

1. Use Node.js 22.13+ or Node.js 24+ and run `npm install`.
2. Create a private R2 bucket named `tartarian-book-files`. Do not enable its public development URL or attach a public custom domain.
3. Upload every EPUB and PDF at the exact object keys listed under [Book-to-file mapping](#book-to-file-mapping).
4. Apply D1 migrations with `npm run db:migrate:remote`.
5. Configure the Worker secrets listed under [Bindings and secrets](#bindings-and-secrets).
6. Complete the [AWS SES setup](#aws-ses-setup), then send a test account-verification email.
7. Create the Stripe webhook endpoint `https://tartarianchronicles.com/api/stripe/webhook`, select the events listed below, then save its signing secret as `STRIPE_WEBHOOK_SECRET`.
8. Optionally create stable Stripe one-time Price objects and map their IDs in D1. If they are not mapped, the Worker creates trusted one-time `price_data` from the server-side catalog.
9. Test account creation, email verification, a Stripe test-mode purchase, both file formats, a refund, and a guest claim before switching Stripe to live mode.
10. Confirm `tartarianchronicles.com` and `www.tartarianchronicles.com` are active Cloudflare custom domains. No additional DNS record is required if Workers Custom Domains manages them.

## Architecture and security

### Customer authentication

- Email addresses are normalized with Unicode NFKC, whitespace trimming, lowercase comparison, length checks, and an ASCII mailbox/domain validation rule. `users.email_normalized` is unique.
- Passwords are stored as salted PBKDF2-SHA-256 hashes. Production uses Cloudflare Workers' supported maximum of 100,000 iterations by default. `PASSWORD_HASH_ITERATIONS` exists primarily to lower test cost and should not be reduced in production.
- Passwords must contain 12–128 characters and at least three character classes. A password cannot contain a four-or-more-character email local part.
- Sessions use 256-bit opaque random tokens. D1 stores only SHA-256 token hashes. The `tc_session` cookie is HTTP-only, `SameSite=Lax`, and `Secure` on HTTPS. The 30-day server expiration and revocation state are authoritative.
- A login always replaces and revokes the cookie's prior session, preventing session fixation. Password resets revoke every session; password changes revoke all other sessions; logout revokes the current session.
- Each session has a deterministic HMAC CSRF token whose hash is stored in D1. Protected mutations require the token in `X-CSRF-Token` plus a same-origin request.
- Registration, login, password-reset requests, and verification resends use D1-backed IP-and-identity rate-limit buckets. Bucket keys are hashed; raw IP addresses and emails are not stored in the rate-limit table.
- Registration duplicates and password-reset requests return generic responses. Invalid login responses do not reveal whether an email is registered.
- Verification, password-reset, purchase-claim, and download tokens are cryptographically random. Only token hashes are stored. Email tokens are placed after `#` in links so they are not sent to the server, browser history request logs, or referrers; page JavaScript submits them in a same-origin JSON body and immediately clears the fragment.

### Checkout and payment fulfillment

- New Checkout Sessions require an authenticated, verified customer session and valid CSRF token.
- The browser sends only a catalog book ID, quantity, and PDF selection. The Worker looks up the active book, currency, amount, file formats, optional Stripe Price ID, and internal account ID on the server.
- The Checkout Session receives trusted `orderId`, `userId`, and `bookIds` metadata and an internal `client_reference_id`. The verified account email is supplied through `customer_email` or an existing Stripe Customer.
- The success URL stores the Checkout Session ID in the URL fragment. The page sends it to an authenticated status endpoint after removing the fragment.
- The success page never fulfills an order. It displays `processing` until a verified Stripe webhook creates the purchase and entitlement.
- The webhook verifies Stripe's signature against the unmodified raw request body, retrieves the Checkout Session and expanded line items, requires `payment_status=paid`, and validates metadata, book IDs, Price IDs or product metadata, amounts, currencies, quantities, and subtotal against D1.
- `stripe_events`, unique Checkout Session IDs, unique purchase items, unique entitlements, and email `dedupe_key` values make retries idempotent. Transactional email requests also receive provider idempotency metadata where supported.

### Guest purchase migration

Checkouts created by the old storefront can complete without `userId` metadata. The webhook preserves those paid orders as `pending_claim`, normalizes the Stripe customer email, creates a seven-day single-use claim token, and sends a claim email. The customer must create or log into an account with the same email and verify it before claiming. No password or account is created automatically. A conditional D1 update prevents two accounts from claiming the same purchase.

### Private digital delivery

- `BOOK_FILES` is a private R2 binding. R2 object keys are stored only in D1 and Worker code; public catalog and library responses never include them.
- The library user comes exclusively from the server-side session. A browser-supplied user ID is never accepted.
- A download button requests a two-minute opaque grant for one owned book and format. D1 stores only its hash. The GET endpoint requires the same authenticated user, an active entitlement, a non-expired unused grant, and an existing approved R2 object.
- Grants are single-use and are consumed before R2 streaming. Every download rechecks current entitlement state, so a refund or dispute invalidates outstanding grants.
- EPUB responses use `application/epub+zip`; PDF responses use `application/pdf`. Both use attachment filenames and `private, no-store` caching.

## D1 migrations

The D1 binding is `DB`, currently pointed at `tartarian-orders`.

```sh
npm run db:migrate:local
npm run db:migrate:remote
```

`migrations/0001_initial.sql` contains the catalog, legacy order, Stripe event, and owner-login schema. `migrations/0002_customer_accounts_and_delivery.sql` adds:

- `users`, `sessions`, verification/reset tokens, and rate-limit buckets;
- trusted Stripe and R2 fields on `books`;
- account ownership on `orders`;
- `purchases`, `purchase_items`, and `entitlements`;
- purchase-claim tokens, download grants, and deduplicated email delivery records.

Migrations should be applied before deploying code that queries the new columns.

## Book-to-file mapping

The default private R2 keys are:

| Book ID | EPUB key | PDF key |
| --- | --- | --- |
| `through` | `books/through/through-the-veil.epub` | `books/through/through-the-veil.pdf` |
| `refuge` | `books/refuge/the-refuge.epub` | `books/refuge/the-refuge.pdf` |
| `darkness` | `books/darkness/out-of-darkness.epub` | `books/darkness/out-of-darkness.pdf` |
| `brotherhood` | `books/brotherhood/brotherhood.epub` | `books/brotherhood/brotherhood.pdf` |
| `silver` | `books/silver/silver-light.epub` | `books/silver/silver-light.pdf` |

Upload examples:

```sh
npx wrangler r2 object put tartarian-book-files/books/through/through-the-veil.epub --file ./files/through-the-veil.epub --content-type application/epub+zip
npx wrangler r2 object put tartarian-book-files/books/through/through-the-veil.pdf --file ./files/through-the-veil.pdf --content-type application/pdf
```

Owner-created catalog books automatically receive conventional keys `books/<book-id>/<slug>.epub` and `books/<book-id>/<slug>.pdf`. Upload the files there, or update the mapping directly:

```sh
npx wrangler d1 execute tartarian-orders --remote --command "UPDATE books SET epub_r2_key='books/example/book.epub', pdf_r2_key='books/example/book.pdf' WHERE id='book_example'"
```

Never return these values from a public API or add them to frontend code.

## Stripe configuration

The checkout integration supports two trusted pricing modes:

1. With `stripe_epub_price_id` and `stripe_epub_pdf_price_id` populated, the Worker retrieves each Price before Checkout and requires an active, one-time Price with the exact D1 currency and amount.
2. With those columns empty, the Worker supplies server-created `price_data` using the D1 catalog amount. The resulting Stripe Price ID is recorded on the purchase item.

The current PDF bundle amount is the catalog EPUB price plus 100 cents. If stable Stripe Prices are created, configure both amounts for each book:

```sh
npx wrangler d1 execute tartarian-orders --remote --command "UPDATE books SET stripe_epub_price_id='price_epub', stripe_epub_pdf_price_id='price_bundle' WHERE id='through'"
```

Subscribe the webhook endpoint to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `payment_intent.payment_failed`
- `charge.refunded`
- `refund.created`
- `charge.dispute.created`
- `charge.dispute.closed`

The selected policy is: partial refunds preserve access but mark the purchase `partial`; full refunds revoke the purchase entitlements; a new dispute moves access to `review` and blocks downloads; a dispute won by the seller restores access. Purchase history is never deleted.

## AWS SES setup

The Worker sends account verification, password reset, guest purchase claim, and purchase confirmation messages through the AWS SES v2 API. Failed sends are recorded in `email_deliveries` without rolling back an already-created account or completed purchase.

`wrangler.toml` selects `aws-ses` in `us-east-1`. Keep the SES identity, production-access request, IAM policy, and `AWS_REGION` in the same region. To use another region, change `AWS_REGION` before creating the identity and policy.

1. In Amazon SES in `us-east-1`, create a **domain identity** for `tartarianchronicles.com` with Easy DKIM enabled.
2. Add the DKIM CNAME records SES provides to the domain's Cloudflare DNS, then wait for the SES identity status to become **Verified**. DNS-only records should not be proxied.
3. Request SES **production access** for transactional email. While the account is in the SES sandbox, messages can only go to verified recipients.
4. Add a DMARC TXT record for `_dmarc.tartarianchronicles.com`. Start with a monitoring policy such as `v=DMARC1; p=none; rua=mailto:dmarc@tartarianchronicles.com`, using a real mailbox for the report address. Tighten the policy after reviewing reports.
5. Create a dedicated IAM user for this Worker with no console password. Attach this least-privilege policy, replacing `YOUR_AWS_ACCOUNT_ID`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendTartarianTransactionalEmail",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:us-east-1:YOUR_AWS_ACCOUNT_ID:identity/tartarianchronicles.com",
      "Condition": {
        "StringEquals": {
          "ses:FromAddress": "books@tartarianchronicles.com"
        }
      }
    }
  ]
}
```

6. Create one access key for that IAM user. Save it when AWS displays it; the secret cannot be retrieved again. Never use root-user credentials.
7. From a terminal authenticated to the Cloudflare account that owns this Worker, set:

```sh
npx wrangler secret put SESSION_SECRET
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put EMAIL_FROM
```

Use at least 32 random bytes for `SESSION_SECRET`. Set `EMAIL_FROM` to `S.E. Centers <books@tartarianchronicles.com>` so it matches both the verified domain and IAM condition. If replies should go to a monitored mailbox, add `EMAIL_REPLY_TO` as a non-secret Worker variable or secret. Temporary AWS credentials are also supported through the optional `AWS_SESSION_TOKEN`, but they must be rotated before they expire.

Optional `AWS_SES_CONFIGURATION_SET` support is included for SES delivery, bounce, and complaint event publishing. The existing Resend, Postmark, and SendGrid adapters remain available by changing `EMAIL_PROVIDER` and setting `EMAIL_API_KEY`.

## Bindings and secrets

Non-secret bindings and variables are declared in `wrangler.toml`:

- `ASSETS`: generated static `dist` directory
- `DB`: D1 database
- `BOOK_COVERS`: R2 cover-image bucket
- `BOOK_FILES`: private EPUB/PDF bucket
- `PUBLIC_URL`
- `STRIPE_AUTOMATIC_TAX`
- `EMAIL_PROVIDER`
- `AWS_REGION`

Set production secrets with Wrangler; never put their values in `wrangler.toml` or Git:

```sh
npx wrangler secret put SESSION_SECRET
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put EMAIL_FROM
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ADMIN_SESSION_SECRET
```

Generate the two session secrets independently with at least 32 random bytes. No download-signing secret is needed because download grants are random, database-backed, hashed, short-lived, single-use, and reauthorized at download time.

Optional values:

- `EMAIL_API_URL`
- `EMAIL_MESSAGE_STREAM` for Postmark
- `EMAIL_API_KEY` for Resend, Postmark, or SendGrid
- `EMAIL_REPLY_TO`
- `AWS_SESSION_TOKEN` for temporary AWS credentials
- `AWS_SES_CONFIGURATION_SET`
- `PASSWORD_HASH_ITERATIONS` (leave unset in production to use 100,000, the Cloudflare Workers maximum)

For local development, place secrets in ignored `.dev.vars`:

```dotenv
SESSION_SECRET=replace-with-at-least-32-random-bytes
EMAIL_PROVIDER=aws-ses
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
EMAIL_FROM="S.E. Centers <books@tartarianchronicles.com>"
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
ADMIN_PASSWORD=...
ADMIN_SESSION_SECRET=replace-with-another-random-secret
```

## TypeScript and runtime validation

All application code, the Node development server, build scripts, and tests are TypeScript. The browser, Cloudflare Worker, and Node tools have separate configurations extending `tsconfig.json`. Strict checks include unchecked array/index access, exact optional properties, unknown catch variables, and unused code. JavaScript source files are not accepted by the compiler.

`npm run check` runs all three compiler projects and type-aware ESLint rules. Application code cannot use explicit `any`, non-null assertions, TypeScript suppression comments, or unsafe assignments and calls. Third-party generated Cloudflare declarations are excluded from linting and library checking.

Shared Zod contracts validate API responses, persisted JSON, and webhook data. Request bodies remain `unknown` until validated; DOM helpers check that required elements exist and have the expected runtime type.

`npm run build` type-checks first, then bundles the browser entry points to the existing `dist/src/*.js` URLs. Raw TypeScript source is not copied into the public asset directory. Wrangler compiles `worker/index.ts`; `npm run dev:node` builds the browser assets and runs `server.ts` through `tsx`.

Cloudflare runtime declarations are generated for the compatibility date and flags in `wrangler.toml`. Regenerate them with `npm run typegen` after changing that configuration, and verify them with `npm run typegen:check`.

## Local development and tests

Use Node.js 22.13+ or Node.js 24+.

```sh
npm install
npm run db:migrate:local
npm run dev
```

Run Stripe CLI in another terminal for local webhook testing:

```sh
stripe listen --forward-to http://localhost:8787/api/stripe/webhook
```

Copy the CLI's `whsec_...` value into `.dev.vars`, then complete a Stripe test-mode checkout.

The automated suite uses Cloudflare's Workers Vitest pool with isolated D1 and R2 storage:

```sh
npm test
npm run check
npm run build
```

The tests cover registration, duplicate prevention, password hashing and login failures, verification, reset expiration and single-use behavior, session logout/revocation, protected routes, trusted Checkout pricing, webhook signatures and idempotency, purchase/entitlement creation, confirmation deduplication, user isolation, EPUB/PDF streaming, arbitrary-key rejection, expired/used grants, missing files, guest claims, duplicate claims, and refund revocation.

## Deployment

After completing the manual checklist:

```sh
npm run db:migrate:remote
npm run deploy
```

After deployment, make a real request to each account page, verify security headers, create a test account, and complete a Stripe test purchase before enabling live Stripe keys.

## Operations

### Secret rotation

- Rotate `SESSION_SECRET` by setting a new value and deploying. Existing customer sessions will fail CSRF validation and must log in again. Delete old expired session rows after the rollout.
- Rotate `ADMIN_SESSION_SECRET` separately; existing owner sessions become invalid.
- Rotate Stripe and email keys in their provider dashboards, update the Worker secret, deploy/test, then revoke the old key.
- Stripe webhook secret rotation requires updating the endpoint secret and Worker secret together. Stripe may temporarily expose both old and new secrets during a roll procedure; deploy within that overlap.

### Revoke sessions

Users can revoke every other session in Account Settings. To revoke every session for one account manually:

```sql
UPDATE sessions
SET revoked_at = datetime('now')
WHERE user_id = 'usr_...' AND revoked_at IS NULL;
```

### Revoke or restore book access

Preserve purchase history and change the entitlement status:

```sql
UPDATE entitlements
SET status = 'revoked', revoked_at = datetime('now'), revocation_reason = 'manual_policy_review'
WHERE user_id = 'usr_...' AND book_id = 'through' AND status = 'active';

UPDATE entitlements
SET status = 'active', revoked_at = NULL, revocation_reason = ''
WHERE user_id = 'usr_...' AND book_id = 'through';
```

If the entire purchase must be revoked, update `purchases.entitlement_status` as well. Library and download authorization require both the purchase and entitlement to be active.
