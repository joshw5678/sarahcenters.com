import { scalarText } from "../shared/contracts.js";
import { parseFormats } from "../shared/contracts.js";
import type { LibraryBook } from "../shared/contracts.js";
interface LibraryRow { book_id: string; formats_json: string; granted_at: string; purchased_at: string; slug: string; number: string; title: string; description: string; image_url: string; epub_r2_key: string | null; pdf_r2_key: string | null }
import { AppError, requireRecord } from "../shared/contracts.js";
import type { WorkerEnv, ReadJson } from "./types.js";
import {
  getCustomerSession,
  hashToken,
  normalizeEmail,
  randomToken,
  requireCsrf,
} from "./customer-auth.js";
import { sendPurchaseConfirmation } from "./email.js";

const DOWNLOAD_TTL_MS = 2 * 60 * 1000;

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

function requireObject(body: unknown, allowedKeys: readonly string[]) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new AppError("Request body must be a JSON object.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    const error = new AppError("Request body contains unsupported fields.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return requireRecord(body);
}

async function requireVerifiedSession(request: Request, env: WorkerEnv) {
  const session = await getCustomerSession(request, env);
  if (!session) {
    const error = new AppError("Please log in to continue.");
    error.status = 401;
    error.expose = true;
    throw error;
  }
  if (!session.user.emailVerified) {
    const error = new AppError("Verify your email address to access purchased files.");
    error.status = 403;
    error.code = "EMAIL_VERIFICATION_REQUIRED";
    error.expose = true;
    throw error;
  }
  return session;
}

export async function listCustomerLibrary(env: WorkerEnv, userId: string) {
  const result = await env.DB.prepare(
    `SELECT e.book_id, e.formats_json, e.granted_at, p.purchased_at,
            b.slug, b.number, b.title, b.description, b.image_url,
            b.epub_r2_key, b.pdf_r2_key
     FROM entitlements e
     JOIN purchases p ON p.id = e.purchase_id
     JOIN books b ON b.id = e.book_id
     WHERE e.user_id = ? AND e.status = 'active'
       AND p.entitlement_status = 'active'
     ORDER BY p.purchased_at DESC, b.title`
  )
    .bind(userId)
    .all<LibraryRow>();
  const byBook = new Map<string, LibraryBook>();
  for (const row of result.results || []) {
    const current = byBook.get(row.book_id);
    const allowed = parseFormats(row.formats_json).filter((format) =>
      format === "epub" ? Boolean(row.epub_r2_key) : Boolean(row.pdf_r2_key)
    );
    if (current) {
      current.formats = [...new Set([...current.formats, ...allowed])];
      if (row.purchased_at < current.firstPurchasedAt) current.firstPurchasedAt = row.purchased_at;
      continue;
    }
    byBook.set(row.book_id, {
      id: row.book_id,
      slug: row.slug,
      number: row.number,
      title: row.title,
      description: row.description,
      image: row.image_url,
      purchaseDate: row.purchased_at,
      firstPurchasedAt: row.purchased_at,
      formats: allowed,
    });
  }
  return [...byBook.values()];
}

async function createDownloadGrant(request: Request, env: WorkerEnv, bookId: string, body: unknown) {
  const session = await requireVerifiedSession(request, env);
  await requireCsrf(request, session);
  const fields = requireObject(body, ["format"]);
  const format = scalarText(fields.format || "").toLowerCase();
  if (format !== "epub" && format !== "pdf") {
    const error = new AppError("Choose EPUB or PDF.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const entitlementResult = await env.DB.prepare(
    `SELECT e.formats_json,
            CASE WHEN ? = 'epub' THEN b.epub_r2_key ELSE b.pdf_r2_key END AS object_key
     FROM entitlements e
     JOIN purchases p ON p.id = e.purchase_id
     JOIN books b ON b.id = e.book_id
     WHERE e.user_id = ? AND e.book_id = ? AND e.status = 'active'
       AND p.entitlement_status = 'active'
     ORDER BY e.granted_at DESC`
  )
    .bind(format, session.userId, bookId)
    .all<{ formats_json: string; object_key: string | null }>();
  const entitlementRows = entitlementResult.results || [];
  const allowedFormats = new Set(
    entitlementRows.flatMap((row) => parseFormats(row.formats_json))
  );
  if (
    !entitlementRows.length ||
    !allowedFormats.has(format) ||
    !entitlementRows[0]?.object_key
  ) {
    const error = new AppError("This book format is not available in your library.");
    error.status = 403;
    error.expose = true;
    throw error;
  }

  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DOWNLOAD_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO download_grants
       (id, user_id, book_id, format, token_hash, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
  )
    .bind(
      `dgr_${crypto.randomUUID()}`,
      session.userId,
      bookId,
      format,
      await hashToken(token),
      now.toISOString(),
      expiresAt
    )
    .run();
  return json({
    url: `/api/download?token=${encodeURIComponent(token)}`,
    expiresAt,
  });
}

function safeFilename(title: string, format: string) {
  const base = scalarText(title || "book")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "book";
  return `${base}.${format}`;
}

async function streamDownload(request: Request, env: WorkerEnv, url: URL) {
  const session = await requireVerifiedSession(request, env);
  const token = scalarText(url.searchParams.get("token") || "").trim();
  if (token.length < 32 || token.length > 200) {
    return json({ error: "This download link is invalid or expired." }, 404);
  }
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();
  const grant = await env.DB.prepare(
    `SELECT g.id, g.user_id, g.book_id, g.format,
            b.title, b.epub_r2_key, b.pdf_r2_key
     FROM download_grants g
     JOIN books b ON b.id = g.book_id
     WHERE g.token_hash = ? AND g.used_at IS NULL AND g.expires_at > ?
       AND g.user_id = ? LIMIT 1`
  )
    .bind(tokenHash, now, session.userId)
    .first<{ id: string; user_id: string; book_id: string; format: "epub" | "pdf"; title: string; epub_r2_key: string | null; pdf_r2_key: string | null }>();
  if (!grant) {
    return json({ error: "This download link is invalid or expired." }, 404);
  }
  const entitlementResult = await env.DB.prepare(
    `SELECT e.formats_json
     FROM entitlements e JOIN purchases p ON p.id = e.purchase_id
     WHERE e.user_id = ? AND e.book_id = ? AND e.status = 'active'
       AND p.entitlement_status = 'active'`
  )
    .bind(session.userId, grant.book_id)
    .all<{ formats_json: string }>();
  const activeFormats = new Set(
    (entitlementResult.results || []).flatMap((row) => parseFormats(row.formats_json))
  );
  if (!activeFormats.has(grant.format)) {
    return json({ error: "This download link is invalid or expired." }, 404);
  }
  const consumed = await env.DB.prepare(
    `UPDATE download_grants SET used_at = ?
     WHERE id = ? AND used_at IS NULL AND expires_at > ?`
  )
    .bind(now, grant.id, now)
    .run();
  if (Number(consumed.meta?.changes || 0) !== 1) {
    return json({ error: "This download link is invalid or expired." }, 404);
  }

  if (!env.BOOK_FILES) {
    return json({ error: "Book delivery is not configured." }, 503);
  }
  const objectKey = grant.format === "epub" ? grant.epub_r2_key : grant.pdf_r2_key;
  if (!objectKey) return json({ error: "This book file is not available." }, 404);
  const object = await env.BOOK_FILES.get(objectKey);
  if (!object) return json({ error: "This book file is temporarily unavailable." }, 404);

  const filename = safeFilename(grant.title, grant.format);
  const headers = new Headers();
  headers.set(
    "Content-Type",
    grant.format === "epub" ? "application/epub+zip" : "application/pdf"
  );
  headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("X-Content-Type-Options", "nosniff");
  if (object.size !== undefined) headers.set("Content-Length", scalarText(object.size));
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { status: 200, headers });
}

async function claimPurchase(request: Request, env: WorkerEnv, body: unknown) {
  const session = await requireVerifiedSession(request, env);
  await requireCsrf(request, session);
  const fields = requireObject(body, ["token"]);
  const token = scalarText(fields.token || "").trim();
  if (token.length < 32 || token.length > 200) {
    const error = new AppError("This claim link is invalid or expired.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();
  const claim = await env.DB.prepare(
    `SELECT c.id, c.purchase_id, c.email_normalized, p.user_id
     FROM purchase_claim_tokens c JOIN purchases p ON p.id = c.purchase_id
     WHERE c.token_hash = ? AND c.used_at IS NULL AND c.expires_at > ?`
  )
    .bind(tokenHash, now)
    .first<{ id: string; purchase_id: string; email_normalized: string; user_id: string | null }>();
  if (
    !claim ||
    claim.user_id ||
    normalizeEmail(session.user.email) !== claim.email_normalized
  ) {
    const error = new AppError(
      "This claim link is invalid, expired, already used, or belongs to another email address."
    );
    error.status = 400;
    error.expose = true;
    throw error;
  }

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE purchases
       SET user_id = ?, pending_email_normalized = NULL,
           entitlement_status = 'active', updated_at = ?
       WHERE id = ? AND user_id IS NULL
         AND payment_status = 'paid'
         AND entitlement_status IN ('pending_claim', 'active')
         AND refund_status IN ('none', 'partial', 'resolved')
         AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM purchase_claim_tokens
           WHERE id = ? AND used_at IS NULL AND expires_at > ?
         )`
    ).bind(session.userId, now, claim.purchase_id, claim.id, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO entitlements
         (id, user_id, purchase_id, book_id, formats_json, status,
          granted_at, revoked_at, revocation_reason)
       SELECT 'ent_' || pi.purchase_id || '_' || pi.book_id,
              ?, pi.purchase_id, pi.book_id, pi.formats_json,
              'active', ?, NULL, ''
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       WHERE pi.purchase_id = ? AND p.user_id = ?
         AND p.payment_status = 'paid' AND p.entitlement_status = 'active'
         AND p.refund_status IN ('none', 'partial', 'resolved')
         AND p.revoked_at IS NULL`
    ).bind(session.userId, now, claim.purchase_id, session.userId),
    env.DB.prepare(
      `UPDATE purchase_claim_tokens
       SET used_at = ?, claimed_by_user_id = ?
       WHERE id = ? AND used_at IS NULL AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM purchases p
           WHERE p.id = purchase_claim_tokens.purchase_id AND p.user_id = ?
             AND p.payment_status = 'paid' AND p.entitlement_status = 'active'
             AND p.refund_status IN ('none', 'partial', 'resolved')
             AND p.revoked_at IS NULL
         )`
    ).bind(now, session.userId, claim.id, now, session.userId),
  ]);
  if (Number(results[0]?.meta?.changes || 0) !== 1) {
    const error = new AppError("This purchase is no longer available to claim.");
    error.status = 409;
    error.expose = true;
    throw error;
  }

  const items = await env.DB.prepare(
    `SELECT b.title, pi.formats_json
     FROM purchase_items pi JOIN books b ON b.id = pi.book_id
     WHERE pi.purchase_id = ? ORDER BY b.title`
  )
    .bind(claim.purchase_id)
    .all<{ title: string; formats_json: string }>();
  const allFormats = [
    ...new Set((items.results || []).flatMap((item) => parseFormats(item.formats_json))),
  ];
  await sendPurchaseConfirmation(
    request,
    env,
    {
      id: session.userId,
      email: session.user.email,
      displayName: session.user.displayName,
    },
    { id: claim.purchase_id },
    (items.results || []).map((item) => item.title),
    allFormats
  );
  return json({ ok: true, message: "Purchase claimed. Your books are now in My Library." });
}

export async function handleLibraryRequest(request: Request, env: WorkerEnv, url: URL, readJson: ReadJson) {
  if (url.pathname === "/api/library" && request.method === "GET") {
    const session = await requireVerifiedSession(request, env);
    return json({ books: await listCustomerLibrary(env, session.userId) });
  }
  const grantMatch = url.pathname.match(/^\/api\/library\/([^/]+)\/download$/);
  if (grantMatch && request.method === "POST") {
    let bookId;
    try {
      bookId = decodeURIComponent(grantMatch[1] ?? "");
    } catch {
      return json({ error: "Invalid book identifier." }, 400);
    }
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(bookId)) {
      return json({ error: "Invalid book identifier." }, 400);
    }
    return createDownloadGrant(request, env, bookId, await readJson(request));
  }
  if (url.pathname === "/api/download" && request.method === "GET") {
    return streamDownload(request, env, url);
  }
  if (url.pathname === "/api/account/claim-purchase" && request.method === "POST") {
    return claimPurchase(request, env, await readJson(request));
  }
  return null;
}
