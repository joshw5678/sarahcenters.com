PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'locked', 'disabled')),
  stripe_customer_id TEXT UNIQUE
);

CREATE INDEX users_status_created_at
  ON users (status, created_at DESC);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent_hash TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX sessions_user_active
  ON sessions (user_id, revoked_at, expires_at);

CREATE INDEX sessions_expiration
  ON sessions (expires_at);

CREATE TABLE email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX email_verification_user_active
  ON email_verification_tokens (user_id, used_at, expires_at);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX password_reset_user_active
  ON password_reset_tokens (user_id, used_at, expires_at);

CREATE TABLE auth_rate_limits (
  bucket_key TEXT NOT NULL,
  action TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bucket_key, action)
);

CREATE INDEX auth_rate_limits_cleanup
  ON auth_rate_limits (updated_at);

ALTER TABLE books ADD COLUMN stripe_epub_price_id TEXT;
ALTER TABLE books ADD COLUMN stripe_epub_pdf_price_id TEXT;
ALTER TABLE books ADD COLUMN epub_r2_key TEXT;
ALTER TABLE books ADD COLUMN pdf_r2_key TEXT;

UPDATE books SET
  epub_r2_key = 'books/through/through-the-veil.epub',
  pdf_r2_key = 'books/through/through-the-veil.pdf'
WHERE id = 'through';
UPDATE books SET
  epub_r2_key = 'books/refuge/the-refuge.epub',
  pdf_r2_key = 'books/refuge/the-refuge.pdf'
WHERE id = 'refuge';
UPDATE books SET
  epub_r2_key = 'books/darkness/out-of-darkness.epub',
  pdf_r2_key = 'books/darkness/out-of-darkness.pdf'
WHERE id = 'darkness';
UPDATE books SET
  epub_r2_key = 'books/brotherhood/brotherhood.epub',
  pdf_r2_key = 'books/brotherhood/brotherhood.pdf'
WHERE id = 'brotherhood';
UPDATE books SET
  epub_r2_key = 'books/silver/silver-light.epub',
  pdf_r2_key = 'books/silver/silver-light.pdf'
WHERE id = 'silver';

ALTER TABLE orders ADD COLUMN user_id TEXT REFERENCES users(id);

CREATE INDEX orders_user_created_at
  ON orders (user_id, created_at DESC);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  order_id TEXT REFERENCES orders(id),
  pending_email_normalized TEXT,
  stripe_customer_id TEXT,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_event_id TEXT NOT NULL,
  amount_paid INTEGER NOT NULL CHECK (amount_paid >= 0),
  currency TEXT NOT NULL,
  purchased_at TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  entitlement_status TEXT NOT NULL DEFAULT 'active'
    CHECK (entitlement_status IN ('pending_claim', 'active', 'revoked', 'review')),
  refund_status TEXT NOT NULL DEFAULT 'none'
    CHECK (refund_status IN ('none', 'partial', 'full', 'disputed', 'resolved')),
  revoked_at TEXT,
  revocation_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX purchases_user_date
  ON purchases (user_id, purchased_at DESC);
CREATE INDEX purchases_pending_email
  ON purchases (pending_email_normalized, user_id);
CREATE INDEX purchases_payment_intent
  ON purchases (stripe_payment_intent_id);

CREATE TABLE purchase_items (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id),
  stripe_price_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_amount INTEGER NOT NULL CHECK (unit_amount >= 0),
  currency TEXT NOT NULL,
  formats_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (purchase_id, book_id)
);

CREATE INDEX purchase_items_book
  ON purchase_items (book_id, purchase_id);

CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  book_id TEXT NOT NULL REFERENCES books(id),
  formats_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'review')),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, purchase_id, book_id)
);

CREATE INDEX entitlements_library
  ON entitlements (user_id, status, granted_at DESC);
CREATE INDEX entitlements_purchase
  ON entitlements (purchase_id, status);

CREATE TABLE purchase_claim_tokens (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  claimed_by_user_id TEXT REFERENCES users(id)
);

CREATE INDEX purchase_claim_active
  ON purchase_claim_tokens (email_normalized, used_at, expires_at);

CREATE TABLE download_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id),
  format TEXT NOT NULL CHECK (format IN ('epub', 'pdf')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX download_grants_active
  ON download_grants (token_hash, used_at, expires_at);

CREATE TABLE email_deliveries (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  purchase_id TEXT REFERENCES purchases(id),
  recipient_normalized TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX email_deliveries_status
  ON email_deliveries (status, updated_at);
