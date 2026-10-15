const SESSION_COOKIE = "tc_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
// Cloudflare Workers' Web Crypto implementation rejects PBKDF2 iteration
// counts above 100,000. Keep both generated and accepted hashes within the
// runtime's supported range so registration cannot fail at the edge.
const MAX_PBKDF2_ITERATIONS = 100000;
const DEFAULT_PBKDF2_ITERATIONS = MAX_PBKDF2_ITERATIONS;
const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

function constantTimeEqual(left, right) {
  const a = left instanceof Uint8Array ? left : new Uint8Array(left);
  const b = right instanceof Uint8Array ? right : new Uint8Array(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function hashToken(value) {
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value))))
  );
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))
  );
}

async function derivePassword(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations,
      },
      material,
      256
    )
  );
}

export async function hashPassword(password, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const result = await derivePassword(String(password), salt, iterations);
  return `pbkdf2-sha256$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(result)}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [algorithm, count, saltValue, hashValue] = String(encoded || "").split("$");
    const iterations = Number(count);
    if (
      algorithm !== "pbkdf2-sha256" ||
      !Number.isSafeInteger(iterations) ||
      iterations < 1000 ||
      iterations > MAX_PBKDF2_ITERATIONS
    ) {
      return false;
    }
    const expected = base64UrlToBytes(hashValue);
    const actual = await derivePassword(String(password), base64UrlToBytes(saltValue), iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function passwordIterations(env) {
  const configured = Number(env.PASSWORD_HASH_ITERATIONS || DEFAULT_PBKDF2_ITERATIONS);
  return Number.isSafeInteger(configured) && configured >= 1000 && configured <= MAX_PBKDF2_ITERATIONS
    ? configured
    : DEFAULT_PBKDF2_ITERATIONS;
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().normalize("NFKC").toLowerCase();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)
  ) {
    const error = new Error("Enter a valid email address.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return email;
}

export function validatePassword(password, email = "") {
  const value = String(password || "");
  const localPart = String(email || "").split("@")[0].toLowerCase();
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(value)
  ).length;
  if (
    value.length < 12 ||
    value.length > 128 ||
    classes < 3 ||
    (localPart.length >= 4 && value.toLowerCase().includes(localPart))
  ) {
    const error = new Error(
      "Use 12–128 characters with at least three of: lowercase, uppercase, number, and symbol. Do not include your email name."
    );
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return value;
}

export function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    try {
      const key = decodeURIComponent(part.slice(0, separator).trim());
      if (key === name) return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookies instead of failing the entire request.
    }
  }
  return "";
}

function cookieSecurity(request) {
  const secure = new URL(request.url).protocol === "https:";
  return secure ? "; Secure" : "";
}

export function clearCustomerCookie(request) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(request)}`;
}

function customerCookie(request, token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieSecurity(request)}`;
}

function publicUser(row) {
  return {
    id: row.user_id || row.id,
    email: row.email,
    displayName: row.display_name || "",
    emailVerified: Boolean(row.email_verified_at),
    createdAt: row.user_created_at || row.created_at,
    lastLoginAt: row.last_login_at || null,
    status: row.status,
  };
}

async function fingerprint(request, env, type) {
  const source =
    type === "ip"
      ? request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "local"
      : request.headers.get("user-agent") || "unknown";
  return hashToken(`${env.SESSION_SECRET}:${type}:${source}`);
}

export async function createCustomerSession(request, env, userId) {
  if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) {
    const error = new Error("Customer sessions are not configured.");
    error.status = 503;
    throw error;
  }

  const existingToken = getCookie(request, SESSION_COOKIE);
  if (existingToken) {
    await env.DB.prepare(
      "UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?"
    )
      .bind(new Date().toISOString(), await hashToken(existingToken))
      .run();
  }

  const token = randomToken(32);
  const csrfToken = await hmac(token, env.SESSION_SECRET);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const id = `ses_${crypto.randomUUID()}`;
  const [tokenHash, csrfHash, userAgentHash, ipHash] = await Promise.all([
    hashToken(token),
    hashToken(csrfToken),
    fingerprint(request, env, "user-agent"),
    fingerprint(request, env, "ip"),
  ]);
  await env.DB.prepare(
    `INSERT INTO sessions
       (id, user_id, token_hash, csrf_token_hash, created_at, expires_at,
        last_seen_at, revoked_at, user_agent_hash, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(
      id,
      userId,
      tokenHash,
      csrfHash,
      now.toISOString(),
      expiresAt.toISOString(),
      now.toISOString(),
      userAgentHash,
      ipHash
    )
    .run();
  return {
    id,
    token,
    csrfToken,
    expiresAt: expiresAt.toISOString(),
    cookie: customerCookie(request, token, Math.floor(SESSION_TTL_MS / 1000)),
  };
}

export async function getCustomerSession(request, env, { touch = true } = {}) {
  if (!env.SESSION_SECRET || !env.DB) return null;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id, s.csrf_token_hash, s.expires_at,
            s.last_seen_at, u.email, u.display_name, u.email_verified_at,
            u.created_at AS user_created_at, u.last_login_at, u.status,
            u.stripe_customer_id
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
       AND u.status = 'active'`
  )
    .bind(await hashToken(token), new Date().toISOString())
    .first();
  if (!row) return null;

  const csrfToken = await hmac(token, env.SESSION_SECRET);
  const csrfHash = await hashToken(csrfToken);
  if (!constantTimeEqual(encoder.encode(csrfHash), encoder.encode(row.csrf_token_hash))) {
    return null;
  }

  if (touch && Date.now() - Date.parse(row.last_seen_at) > 5 * 60 * 1000) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), row.session_id)
      .run();
  }
  return {
    id: row.session_id,
    userId: row.user_id,
    csrfToken,
    expiresAt: row.expires_at,
    stripeCustomerId: row.stripe_customer_id || null,
    user: publicUser(row),
  };
}

export async function revokeCustomerSession(env, sessionId) {
  await env.DB.prepare(
    "UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?"
  )
    .bind(new Date().toISOString(), sessionId)
    .run();
}

export function hasValidOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

export async function requireCsrf(request, session) {
  if (!hasValidOrigin(request)) {
    const error = new Error("Invalid request origin.");
    error.status = 403;
    error.expose = true;
    throw error;
  }
  const supplied = request.headers.get("x-csrf-token") || "";
  if (
    !supplied ||
    !constantTimeEqual(encoder.encode(supplied), encoder.encode(session.csrfToken))
  ) {
    const error = new Error("This form expired. Refresh the page and try again.");
    error.status = 403;
    error.expose = true;
    throw error;
  }
}

export function safeReturnPath(value, fallback = "/library.html") {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return fallback;
  }
  try {
    const parsed = new URL(raw, "https://local.invalid");
    return parsed.origin === "https://local.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

export async function enforceRateLimit(
  request,
  env,
  action,
  discriminator = "",
  { limit = 5, windowMs = 15 * 60 * 1000, lockMs = windowMs } = {}
) {
  const address =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "local";
  const bucketKey = await hashToken(
    `${env.SESSION_SECRET}:${action}:${address}:${String(discriminator).toLowerCase()}`
  );
  const now = Date.now();
  const existing = await env.DB.prepare(
    `SELECT attempt_count, window_started_at, blocked_until
     FROM auth_rate_limits WHERE bucket_key = ? AND action = ?`
  )
    .bind(bucketKey, action)
    .first();
  if (Number(existing?.blocked_until || 0) > now) {
    const error = new Error("Too many attempts. Try again later.");
    error.status = 429;
    error.expose = true;
    error.retryAfter = Math.max(1, Math.ceil((Number(existing.blocked_until) - now) / 1000));
    throw error;
  }

  const windowExpired =
    !existing || now - Number(existing.window_started_at || 0) >= windowMs;
  const attemptCount = windowExpired ? 1 : Number(existing.attempt_count || 0) + 1;
  const windowStartedAt = windowExpired ? now : Number(existing.window_started_at);
  const blockedUntil = attemptCount > limit ? now + lockMs : 0;
  await env.DB.prepare(
    `INSERT INTO auth_rate_limits
       (bucket_key, action, attempt_count, window_started_at, blocked_until, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket_key, action) DO UPDATE SET
       attempt_count = excluded.attempt_count,
       window_started_at = excluded.window_started_at,
       blocked_until = excluded.blocked_until,
       updated_at = excluded.updated_at`
  )
    .bind(bucketKey, action, attemptCount, windowStartedAt, blockedUntil, now)
    .run();
  if (blockedUntil) {
    const error = new Error("Too many attempts. Try again later.");
    error.status = 429;
    error.expose = true;
    error.retryAfter = Math.ceil(lockMs / 1000);
    throw error;
  }
}

export function accountUser(row) {
  return publicUser(row);
}
