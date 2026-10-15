const ADMIN_COOKIE = "tc_admin";
const SESSION_MS = 1000 * 60 * 60 * 12;
const ATTEMPT_WINDOW_MS = 1000 * 60 * 15;
const LOCK_MS = 1000 * 60 * 15;
const MAX_FAILURES = 5;
const encoder = new TextEncoder();

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "="
  );
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left[index] ^ right[index];
  }
  return result === 0;
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (decodeURIComponent(key || "") === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return "";
}

async function clientKey(request, env) {
  const address =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "local";
  return base64Url(await sha256(`${env.ADMIN_SESSION_SECRET}:${address}`));
}

export async function passwordsMatch(candidate, expected) {
  const [candidateHash, expectedHash] = await Promise.all([
    sha256(String(candidate || "")),
    sha256(String(expected || "")),
  ]);
  return constantTimeEqual(candidateHash, expectedHash);
}

export async function createAdminCookie(request, env) {
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({ sub: "owner", exp: Date.now() + SESSION_MS })
    )
  );
  const signature = base64Url(await hmac(payload, env.ADMIN_SESSION_SECRET));
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${
    SESSION_MS / 1000
  }${secure}`;
}

export function clearAdminCookie(request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) return false;
  const token = getCookie(request, ADMIN_COOKIE);
  const separator = token.lastIndexOf(".");
  if (separator < 1) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = base64Url(await hmac(payload, env.ADMIN_SESSION_SECRET));
  if (!constantTimeEqual(encoder.encode(signature), encoder.encode(expected))) {
    return false;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    return parsed.sub === "owner" && Number(parsed.exp) > Date.now();
  } catch {
    return false;
  }
}

export function hasValidOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function checkLoginAllowed(request, env) {
  const key = await clientKey(request, env);
  const row = await env.DB.prepare(
    "SELECT locked_until FROM admin_login_attempts WHERE client_key = ?"
  )
    .bind(key)
    .first();
  const remainingMs = Number(row?.locked_until || 0) - Date.now();
  return {
    allowed: remainingMs <= 0,
    retryAfter: Math.max(1, Math.ceil(remainingMs / 1000)),
  };
}

export async function recordLoginFailure(request, env) {
  const key = await clientKey(request, env);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT failed_count, window_started_at
     FROM admin_login_attempts WHERE client_key = ?`
  )
    .bind(key)
    .first();

  const windowExpired = !row || now - Number(row.window_started_at) > ATTEMPT_WINDOW_MS;
  const failedCount = windowExpired ? 1 : Number(row.failed_count) + 1;
  const windowStartedAt = windowExpired ? now : Number(row.window_started_at);
  const lockedUntil = failedCount >= MAX_FAILURES ? now + LOCK_MS : 0;

  await env.DB.prepare(
    `INSERT INTO admin_login_attempts
       (client_key, failed_count, window_started_at, locked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(client_key) DO UPDATE SET
       failed_count = excluded.failed_count,
       window_started_at = excluded.window_started_at,
       locked_until = excluded.locked_until`
  )
    .bind(key, failedCount, windowStartedAt, lockedUntil)
    .run();
}

export async function clearLoginFailures(request, env) {
  const key = await clientKey(request, env);
  await env.DB.prepare("DELETE FROM admin_login_attempts WHERE client_key = ?")
    .bind(key)
    .run();
}
