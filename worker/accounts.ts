import { scalarText } from "../shared/contracts.js";
import type { UserRow, EmailRecipient } from "./types.js";
import { AppError, errorMessage, requireRecord } from "../shared/contracts.js";
import type { WorkerEnv, ReadJson } from "./types.js";
import {
  accountUser,
  clearCustomerCookie,
  createCustomerSession,
  enforceRateLimit,
  getCustomerSession,
  hasValidOrigin,
  hashPassword,
  hashToken,
  normalizeEmail,
  passwordIterations,
  randomToken,
  requireCsrf,
  revokeCustomerSession,
  validatePassword,
  verifyPassword,
} from "./customer-auth.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "./email.js";

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function requireObject(body: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new AppError("Request body must be a JSON object.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const unknown = Object.keys(body).filter((key) => !allowedKeys.includes(key));
  if (unknown.length) {
    const error = new AppError("Request body contains unsupported fields.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return requireRecord(body);
}

function displayName(value: unknown) {
  const name = scalarText(value || "").trim().replace(/\s+/g, " ");
  if (name.length > 100) {
    const error = new AppError("Name must be 100 characters or fewer.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return name;
}

function tokenFromBody(body: Record<string, unknown>) {
  const token = scalarText(body.token || "").trim();
  if (token.length < 32 || token.length > 200) {
    const error = new AppError("This link is invalid or has expired.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return token;
}

function requireSameOrigin(request: Request) {
  if (!hasValidOrigin(request)) {
    const error = new AppError("Invalid request origin.");
    error.status = 403;
    error.expose = true;
    throw error;
  }
}

async function findUserByEmail(env: WorkerEnv, normalized: string) {
  return env.DB.prepare("SELECT * FROM users WHERE email_normalized = ?")
    .bind(normalized)
    .first<UserRow>();
}

async function findUserById(env: WorkerEnv, id: string) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

async function issueVerification(request: Request, env: WorkerEnv, user: EmailRecipient) {
  const token = randomToken(32);
  const tokenId = `evt_${crypto.randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_verification_tokens SET used_at = ?
       WHERE user_id = ? AND used_at IS NULL`
    ).bind(now.toISOString(), user.id),
    env.DB.prepare(
      `INSERT INTO email_verification_tokens
         (id, user_id, token_hash, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`
    ).bind(tokenId, user.id, await hashToken(token), now.toISOString(), expiresAt),
  ]);
  return sendVerificationEmail(request, env, user, token, tokenId);
}

async function issuePasswordReset(request: Request, env: WorkerEnv, user: EmailRecipient) {
  const token = randomToken(32);
  const tokenId = `prt_${crypto.randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE password_reset_tokens SET used_at = ?
       WHERE user_id = ? AND used_at IS NULL`
    ).bind(now.toISOString(), user.id),
    env.DB.prepare(
      `INSERT INTO password_reset_tokens
         (id, user_id, token_hash, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`
    ).bind(tokenId, user.id, await hashToken(token), now.toISOString(), expiresAt),
  ]);
  return sendPasswordResetEmail(request, env, user, token, tokenId);
}

async function requireSession(request: Request, env: WorkerEnv) {
  const session = await getCustomerSession(request, env);
  if (!session) {
    const error = new AppError("Please log in to continue.");
    error.status = 401;
    error.expose = true;
    throw error;
  }
  return session;
}

async function register(request: Request, env: WorkerEnv, readJson: ReadJson) {
  requireSameOrigin(request);
  const body = requireObject(await readJson(request), ["email", "password", "displayName"]);
  const normalized = normalizeEmail(body.email);
  await enforceRateLimit(request, env, "register", normalized, {
    limit: 5,
    windowMs: 60 * 60 * 1000,
    lockMs: 60 * 60 * 1000,
  });
  const password = validatePassword(body.password, normalized);
  const name = displayName(body.displayName);
  const existing = await findUserByEmail(env, normalized);
  if (existing) {
    return json(
      {
        ok: true,
        message:
          "If this email can be registered, we sent instructions. Otherwise, sign in or reset the password.",
      },
      202
    );
  }

  const now = new Date().toISOString();
  const user = {
    id: `usr_${crypto.randomUUID()}`,
    email: scalarText(body.email).trim(),
    displayName: name,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO users
         (id, email, email_normalized, password_hash, display_name,
          email_verified_at, created_at, updated_at, last_login_at, status)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, 'active')`
    )
      .bind(
        user.id,
        user.email,
        normalized,
        await hashPassword(password, passwordIterations(env)),
        name,
        now,
        now
      )
      .run();
  } catch (error) {
    if (errorMessage(error, "").toLowerCase().includes("unique")) {
      return json(
        {
          ok: true,
          message:
            "If this email can be registered, we sent instructions. Otherwise, sign in or reset the password.",
        },
        202
      );
    }
    throw error;
  }

  const session = await createCustomerSession(request, env, user.id);
  const emailResult = await issueVerification(request, env, user);
  return json(
    {
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: name,
        emailVerified: false,
        createdAt: now,
        lastLoginAt: null,
        status: "active",
      },
      csrfToken: session.csrfToken,
      emailSent: emailResult.sent,
      message: emailResult.sent
        ? "Account created. Check your email to verify the address."
        : "Account created, but the verification email could not be sent. Request a new link from the verification page.",
    },
    201,
    { "Set-Cookie": session.cookie }
  );
}

async function login(request: Request, env: WorkerEnv, readJson: ReadJson) {
  requireSameOrigin(request);
  const body = requireObject(await readJson(request), ["email", "password"]);
  let normalized;
  try {
    normalized = normalizeEmail(body.email);
  } catch {
    normalized = scalarText(body.email || "").trim().toLowerCase().slice(0, 254);
  }
  await enforceRateLimit(request, env, "login", normalized, {
    limit: 10,
    windowMs: 15 * 60 * 1000,
    lockMs: 15 * 60 * 1000,
  });
  const user = normalized.includes("@") ? await findUserByEmail(env, normalized) : null;
  const passwordValid = user
    ? await verifyPassword(scalarText(body.password || ""), user.password_hash)
    : Boolean(await hashPassword(scalarText(body.password || ""), passwordIterations(env))) && false;
  if (!user || !passwordValid || user.status !== "active") {
    const error = new AppError("Invalid email or password.");
    error.status = 401;
    error.expose = true;
    throw error;
  }

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
    .bind(now, now, user.id)
    .run();
  user.last_login_at = now;
  const session = await createCustomerSession(request, env, user.id);
  return json(
    {
      ok: true,
      user: accountUser(user),
      csrfToken: session.csrfToken,
      message: user.email_verified_at
        ? "You are logged in."
        : "You are logged in. Verify your email before purchasing or downloading books.",
    },
    200,
    { "Set-Cookie": session.cookie }
  );
}

async function logout(request: Request, env: WorkerEnv) {
  const session = await requireSession(request, env);
  await requireCsrf(request, session);
  await revokeCustomerSession(env, session.id);
  return json({ ok: true }, 200, { "Set-Cookie": clearCustomerCookie(request) });
}

async function forgotPassword(request: Request, env: WorkerEnv, readJson: ReadJson) {
  requireSameOrigin(request);
  const body = requireObject(await readJson(request), ["email"]);
  let normalized = scalarText(body.email || "").trim().toLowerCase().slice(0, 254);
  try {
    normalized = normalizeEmail(body.email);
  } catch {
    // Keep the response generic for malformed and unknown addresses.
  }
  await enforceRateLimit(request, env, "password_reset", normalized, {
    limit: 5,
    windowMs: 60 * 60 * 1000,
    lockMs: 60 * 60 * 1000,
  });
  const user = normalized.includes("@") ? await findUserByEmail(env, normalized) : null;
  if (user?.status === "active") {
    await issuePasswordReset(request, env, {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    });
  }
  return json({
    ok: true,
    message: "If an account matches that email, a password-reset link is on its way.",
  });
}

async function resetPassword(request: Request, env: WorkerEnv, readJson: ReadJson) {
  requireSameOrigin(request);
  const body = requireObject(await readJson(request), ["token", "password"]);
  const token = tokenFromBody(body);
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();
  const record = await env.DB.prepare(
    `SELECT t.user_id, u.email_normalized
     FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ?
       AND u.status = 'active'`
  )
    .bind(tokenHash, now)
    .first<{ user_id: string; email_normalized: string }>();
  if (!record) {
    const error = new AppError("This password-reset link is invalid, expired, or already used.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const password = validatePassword(body.password, record.email_normalized);
  const passwordHash = await hashPassword(password, passwordIterations(env));
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET password_hash = ?, updated_at = ?
       WHERE id = (
         SELECT user_id FROM password_reset_tokens
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
       )`
    ).bind(passwordHash, now, tokenHash, now),
    env.DB.prepare(
      `UPDATE password_reset_tokens SET used_at = ?
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
    ).bind(now, tokenHash, now),
  ]);
  if (Number(results[0]?.meta?.changes || 0) !== 1) {
    const error = new AppError("This password-reset link is invalid, expired, or already used.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?)
     WHERE user_id = ?`
  )
    .bind(now, record.user_id)
    .run();
  return json(
    { ok: true, message: "Password updated. Please log in with the new password." },
    200,
    { "Set-Cookie": clearCustomerCookie(request) }
  );
}

async function verifyEmail(request: Request, env: WorkerEnv, readJson: ReadJson) {
  requireSameOrigin(request);
  const body = requireObject(await readJson(request), ["token"]);
  const tokenHash = await hashToken(tokenFromBody(body));
  const now = new Date().toISOString();
  const record = await env.DB.prepare(
    `SELECT user_id FROM email_verification_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
  )
    .bind(tokenHash, now)
    .first<{ user_id: string }>();
  if (!record) {
    const error = new AppError("This verification link is invalid, expired, or already used.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
       WHERE id = (
         SELECT user_id FROM email_verification_tokens
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
       )`
    ).bind(now, now, tokenHash, now),
    env.DB.prepare(
      `UPDATE email_verification_tokens SET used_at = ?
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
    ).bind(now, tokenHash, now),
  ]);
  if (Number(results[0]?.meta?.changes || 0) !== 1) {
    const error = new AppError("This verification link is invalid, expired, or already used.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return json({ ok: true, message: "Email verified. Your account is ready." });
}

async function resendVerification(request: Request, env: WorkerEnv) {
  const session = await requireSession(request, env);
  await requireCsrf(request, session);
  if (session.user.emailVerified) {
    return json({ ok: true, message: "Your email is already verified." });
  }
  await enforceRateLimit(request, env, "email_verification", session.userId, {
    limit: 5,
    windowMs: 60 * 60 * 1000,
    lockMs: 60 * 60 * 1000,
  });
  const result = await issueVerification(request, env, {
    id: session.userId,
    email: session.user.email,
    displayName: session.user.displayName,
  });
  return json({
    ok: true,
    emailSent: result.sent,
    message: result.sent
      ? "A new verification link was sent."
      : "The verification email could not be sent. Please try again later.",
  });
}

async function updateAccount(request: Request, env: WorkerEnv, readJson: ReadJson) {
  const session = await requireSession(request, env);
  await requireCsrf(request, session);
  const body = requireObject(await readJson(request), [
    "displayName",
    "email",
    "currentPassword",
    "newPassword",
  ]);
  if (!Object.keys(body).length) {
    const error = new AppError("Provide at least one account change.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const user = await findUserById(env, session.userId);
  if (!user) throw new AppError("Account not found.", 404);
  const name = body.displayName === undefined ? user.display_name : displayName(body.displayName);
  const normalized =
    body.email === undefined ? user.email_normalized : normalizeEmail(body.email);
  const emailChanged = normalized !== user.email_normalized;
  const passwordChanged = body.newPassword !== undefined && scalarText(body.newPassword).length > 0;
  if (emailChanged || passwordChanged) {
    const valid = await verifyPassword(scalarText(body.currentPassword || ""), user.password_hash);
    if (!valid) {
      const error = new AppError("Your current password is incorrect.");
      error.status = 400;
      error.expose = true;
      throw error;
    }
  }
  if (emailChanged && (await findUserByEmail(env, normalized))) {
    const error = new AppError("The account could not be updated with that email address.");
    error.status = 409;
    error.expose = true;
    throw error;
  }
  const passwordHash = passwordChanged
    ? await hashPassword(
        validatePassword(body.newPassword, normalized),
        passwordIterations(env)
      )
    : user.password_hash;
  const now = new Date().toISOString();
  const email = emailChanged ? scalarText(body.email).trim() : user.email;
  const statements = [
    env.DB.prepare(
      `UPDATE users SET email = ?, email_normalized = ?, password_hash = ?,
         display_name = ?, email_verified_at = ?, updated_at = ? WHERE id = ?`
    ).bind(
      email,
      normalized,
      passwordHash,
      name,
      emailChanged ? null : user.email_verified_at,
      now,
      user.id
    ),
  ];
  if (emailChanged || passwordChanged) {
    statements.push(
      env.DB.prepare(
        `UPDATE password_reset_tokens SET used_at = ?
         WHERE user_id = ? AND used_at IS NULL`
      ).bind(now, user.id)
    );
  }
  if (passwordChanged) {
    statements.push(
      env.DB.prepare(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?)
         WHERE user_id = ? AND id <> ?`
      ).bind(now, user.id, session.id)
    );
  }
  await env.DB.batch(statements);
  let emailSent = null;
  if (emailChanged) {
    const result = await issueVerification(request, env, {
      id: user.id,
      email,
      displayName: name,
    });
    emailSent = result.sent;
  }
  const updated = await findUserById(env, user.id);
  if (!updated) throw new AppError("Account not found.", 404);
  return json({
    ok: true,
    user: accountUser(updated),
    csrfToken: session.csrfToken,
    emailSent,
    message: emailChanged
      ? "Account updated. Verify the new email address before purchasing or downloading."
      : "Account updated.",
  });
}

async function revokeOtherSessions(request: Request, env: WorkerEnv) {
  const session = await requireSession(request, env);
  await requireCsrf(request, session);
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?)
     WHERE user_id = ? AND id <> ?`
  )
    .bind(new Date().toISOString(), session.userId, session.id)
    .run();
  return json({ ok: true, message: "Other signed-in sessions were revoked." });
}

export async function handleAccountRequest(request: Request, env: WorkerEnv, url: URL, readJson: ReadJson) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/api/account/register" && method === "POST") {
    return register(request, env, readJson);
  }
  if (pathname === "/api/account/login" && method === "POST") {
    return login(request, env, readJson);
  }
  if (pathname === "/api/account/logout" && method === "POST") {
    return logout(request, env);
  }
  if (pathname === "/api/account/forgot-password" && method === "POST") {
    return forgotPassword(request, env, readJson);
  }
  if (pathname === "/api/account/reset-password" && method === "POST") {
    return resetPassword(request, env, readJson);
  }
  if (pathname === "/api/account/verify-email" && method === "POST") {
    return verifyEmail(request, env, readJson);
  }
  if (pathname === "/api/account/resend-verification" && method === "POST") {
    return resendVerification(request, env);
  }
  if (pathname === "/api/account/sessions/revoke-others" && method === "POST") {
    return revokeOtherSessions(request, env);
  }
  if (pathname === "/api/account/me" && method === "GET") {
    const session = await requireSession(request, env);
    return json({
      user: session.user,
      csrfToken: session.csrfToken,
      sessionExpiresAt: session.expiresAt,
    });
  }
  if (pathname === "/api/account" && method === "PATCH") {
    return updateAccount(request, env, readJson);
  }
  return null;
}
