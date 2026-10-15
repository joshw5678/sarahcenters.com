import { scalarText } from "../shared/contracts.js";
import type { Book } from "../shared/contracts.js";
import { AppError, errorMessage, isRecord, requireRecord, parseJson as parseUnknownJson } from "../shared/contracts.js";
import type { WorkerEnv } from "./types.js";
import {
  findBook,
  findOrderById,
  getContentMap,
  insertBook,
  listBooks,
  listOrders,
  saveContentMap,
  saveOrder,
  updateBook,
} from "./db.js";
import {
  checkLoginAllowed,
  clearAdminCookie,
  clearLoginFailures,
  createAdminCookie,
  hasValidOrigin,
  isAdmin,
  passwordsMatch,
  recordLoginFailure,
} from "./auth.js";
import {
  createCheckout,
  checkoutStatus,
  handleWebhook,
} from "./stripe.js";
import { handleAccountRequest } from "./accounts.js";
import { handleLibraryRequest } from "./library.js";
import {
  getCustomerSession,
  requireCsrf,
  safeReturnPath,
} from "./customer-auth.js";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_COVER_BYTES = 6 * 1024 * 1024;

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

function publicBook(book: Book) {
  return {
    id: book.id,
    slug: book.slug,
    number: book.number,
    title: book.title,
    tagline: book.tagline,
    desc: book.desc,
    image: book.image,
    priceCents: book.priceCents,
    currency: book.currency,
    active: Boolean(book.active),
  };
}



async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_JSON_BYTES) {
    const error = new AppError("Request body is too large.");
    error.status = 413;
    throw error;
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES) {
    const error = new AppError("Request body is too large.");
    error.status = 413;
    throw error;
  }
  try {
    return body ? parseUnknownJson(body) : {};
  } catch {
    const error = new AppError("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function requiredString(value: unknown, label: string, maxLength = 400) {
  const text = scalarText(value || "").trim();
  if (!text) throw new AppError(`${label} is required.`);
  if (text.length > maxLength) throw new AppError(`${label} is too long.`);
  return text;
}

function optionalString(value: unknown, maxLength = 1000) {
  return scalarText(value || "").trim().slice(0, maxLength);
}

function parsePriceCents(value: unknown) {
  const number = Number(scalarText(value || "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) {
    throw new AppError("A valid price is required.");
  }
  const cents = Math.round(number * 100);
  if (cents < 50) {
    throw new AppError("Stripe requires a minimum charge of at least $0.50 USD.");
  }
  return cents;
}

function normalizeCurrency(value: unknown) {
  const currency = scalarText(value || "usd").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new AppError("Currency must be a 3-letter code.");
  }
  return currency;
}

function slugify(value: unknown) {
  return scalarText(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function coverKey(file: File) {
  const mimeExtensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const extension = mimeExtensions[file.type];
  if (!extension) throw new AppError("Book cover must be a PNG, JPG, or WebP image.");
  const name = scalarText(file.name || "cover")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${Date.now()}-${crypto.randomUUID()}-${name || "cover"}.${extension}`;
}

async function adminGuard(request: Request, env: WorkerEnv, mutating = false) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return json({ error: "Owner admin is not configured." }, 503);
  }
  if (mutating && !hasValidOrigin(request)) {
    return json({ error: "Invalid request origin." }, 403);
  }
  if (!(await isAdmin(request, env))) {
    return json({ error: "Owner login required." }, 401);
  }
  return null;
}

async function serveCover(pathname: string, env: WorkerEnv) {
  let key;
  try {
    key = decodeURIComponent(pathname.slice("/uploads/books/".length));
  } catch {
    return json({ error: "Invalid cover path." }, 400);
  }
  if (!key || key.includes("..")) return json({ error: "Not found." }, 404);
  const object = await env.BOOK_COVERS.get(key);
  if (!object) return json({ error: "Not found." }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

async function handleAdmin(request: Request, env: WorkerEnv, url: URL) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/admin/login" && method === "POST") {
    if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
      return json({ error: "Owner admin is not configured." }, 503);
    }
    if (!hasValidOrigin(request)) {
      return json({ error: "Invalid request origin." }, 403);
    }
    const limit = await checkLoginAllowed(request, env);
    if (!limit.allowed) {
      return json(
        { error: "Too many login attempts. Try again shortly." },
        429,
        { "Retry-After": scalarText(limit.retryAfter) }
      );
    }

    const body = requireRecord(await readJson(request));
    if (!(await passwordsMatch(body.password, env.ADMIN_PASSWORD))) {
      await recordLoginFailure(request, env);
      return json({ error: "Incorrect owner password." }, 401);
    }

    await clearLoginFailures(request, env);
    return json(
      { ok: true },
      200,
      { "Set-Cookie": await createAdminCookie(request, env) }
    );
  }

  if (pathname === "/api/admin/logout" && method === "POST") {
    if (!hasValidOrigin(request)) {
      return json({ error: "Invalid request origin." }, 403);
    }
    return json(
      { ok: true },
      200,
      { "Set-Cookie": clearAdminCookie(request) }
    );
  }

  const guard = await adminGuard(
    request,
    env,
    !["GET", "HEAD", "OPTIONS"].includes(method)
  );
  if (guard) return guard;

  if (pathname === "/api/admin/me" && method === "GET") {
    return json({ ok: true });
  }

  if (pathname === "/api/admin/books" && method === "GET") {
    return json({ books: await listBooks(env, true) });
  }

  if (pathname === "/api/admin/content" && method === "GET") {
    return json({ content: await getContentMap(env) });
  }

  if (pathname === "/api/admin/content" && method === "PATCH") {
    const body = requireRecord(await readJson(request));
    const updates =
      body && typeof body.content === "object" && body.content && !Array.isArray(body.content)
        ? body.content
        : body;
    if (!isRecord(updates)) {
      return json({ error: "Invalid site text payload." }, 400);
    }
    return json({ content: await saveContentMap(env, updates) });
  }

  if (pathname === "/api/admin/books" && method === "POST") {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_COVER_BYTES + 100 * 1024) {
      return json({ error: "Book cover must be 6 MB or smaller." }, 413);
    }

    const form = await request.formData();
    const cover = form.get("cover");
    if (!(cover instanceof File)) {
      return json({ error: "A book cover image is required." }, 400);
    }
    if (cover.size > MAX_COVER_BYTES) {
      return json({ error: "Book cover must be 6 MB or smaller." }, 413);
    }

    const key = coverKey(cover);
    const title = requiredString(form.get("title"), "Title", 160);
    const createdAt = new Date().toISOString();
    const bookId = `book_${crypto.randomUUID()}`;
    const bookSlug = slugify(title);
    const book: Book = {
      id: bookId,
      slug: slugify(title),
      number: optionalString(form.get("number"), 24),
      title,
      tagline: optionalString(form.get("tagline"), 240),
      desc: optionalString(form.get("desc"), 1200),
      image: `/uploads/books/${key}`,
      priceCents: parsePriceCents(form.get("price")),
      currency: normalizeCurrency(form.get("currency")),
      active: scalarText(form.get("active")).toLowerCase() !== "false",
      epubKey: `books/${bookId}/${bookSlug}.epub`,
      pdfKey: `books/${bookId}/${bookSlug}.pdf`,
      createdAt,
      updatedAt: createdAt,
    };

    await env.BOOK_COVERS.put(key, await cover.arrayBuffer(), {
      httpMetadata: {
        contentType: cover.type,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    try {
      return json({ book: await insertBook(env, book) }, 201);
    } catch (error) {
      await env.BOOK_COVERS.delete(key);
      throw error;
    }
  }

  const bookMatch = pathname.match(/^\/api\/admin\/books\/([^/]+)$/);
  if (bookMatch && ["PATCH", "DELETE"].includes(method)) {
    const id = decodeURIComponent(bookMatch[1] ?? "");
    const book = await findBook(env, id);
    if (!book) return json({ error: "Book not found." }, 404);

    if (method === "DELETE") {
      book.active = false;
    } else {
      const body = requireRecord(await readJson(request));
      if (body.title !== undefined) {
        book.title = requiredString(body.title, "Title", 160);
        book.slug = slugify(book.title);
      }
      if (body.number !== undefined) book.number = optionalString(body.number, 24);
      if (body.tagline !== undefined) book.tagline = optionalString(body.tagline, 240);
      if (body.desc !== undefined) book.desc = optionalString(body.desc, 1200);
      if (body.price !== undefined) book.priceCents = parsePriceCents(body.price);
      if (body.currency !== undefined) {
        book.currency = normalizeCurrency(body.currency);
      }
      if (body.active !== undefined) book.active = Boolean(body.active);
    }
    book.updatedAt = new Date().toISOString();
    return json({ book: await updateBook(env, book) });
  }

  if (pathname === "/api/admin/orders" && method === "GET") {
    const status = scalarText(url.searchParams.get("status") || "").trim();
    return json({ orders: await listOrders(env, status) });
  }

  const orderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (orderMatch && method === "GET") {
    const order = await findOrderById(env, decodeURIComponent(orderMatch[1] ?? ""));
    return order
      ? json({ order })
      : json({ error: "Order not found." }, 404);
  }

  if (orderMatch && method === "PATCH") {
    const order = await findOrderById(env, decodeURIComponent(orderMatch[1] ?? ""));
    if (!order) return json({ error: "Order not found." }, 404);
    const body = requireRecord(await readJson(request));
    const allowed = new Set([
      "unpaid",
      "new",
      "delivered",
      "complete",
      "canceled",
    ]);
    if (body.fulfillmentStatus !== undefined) {
      const status = scalarText(body.fulfillmentStatus || "").trim();
      if (!allowed.has(status)) {
        return json({ error: "Unknown fulfillment status." }, 400);
      }
      order.fulfillmentStatus = status;
    }
    if (body.ownerNotes !== undefined) {
      order.ownerNotes = optionalString(body.ownerNotes, 1200);
    }
    if (body.trackingNumber !== undefined) {
      order.trackingNumber = optionalString(body.trackingNumber, 160);
    }
    order.updatedAt = new Date().toISOString();
    return json({ order: await saveOrder(env, order) });
  }

  return json({ error: "Not found." }, 404);
}

async function route(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (url.hostname === "www.tartarianchronicles.com") {
    return Response.redirect(
      `https://tartarianchronicles.com${url.pathname}${url.search}`,
      308
    );
  }

  if (pathname.startsWith("/uploads/books/") && request.method === "GET") {
    return serveCover(pathname, env);
  }

  if (pathname === "/api/books" && request.method === "GET") {
    const books = await listBooks(env, false);
    return json({ books: books.map(publicBook) });
  }

  if (pathname === "/api/content" && request.method === "GET") {
    return json({ content: await getContentMap(env) });
  }

  if (pathname === "/api/checkout/session" && request.method === "POST") {
    const session = await getCustomerSession(request, env);
    if (!session) return json({ error: "Please log in before checkout." }, 401);
    if (!session.user.emailVerified) {
      return json(
        {
          error: "Verify your email address before checkout.",
          code: "EMAIL_VERIFICATION_REQUIRED",
        },
        403
      );
    }
    await requireCsrf(request, session);
    const body = requireRecord(await readJson(request));
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "items")) {
      return json({ error: "Invalid checkout request." }, 400);
    }
    return json(
      await createCheckout(request, env, body.items, {
        userId: session.userId,
        email: session.user.email,
        displayName: session.user.displayName,
        stripeCustomerId: session.stripeCustomerId,
      })
    );
  }

  if (pathname === "/api/checkout/status" && request.method === "POST") {
    const session = await getCustomerSession(request, env);
    if (!session) return json({ error: "Please log in to view this purchase." }, 401);
    await requireCsrf(request, session);
    const body = requireRecord(await readJson(request));
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "sessionId")) {
      return json({ error: "Invalid checkout status request." }, 400);
    }
    const sessionId = scalarText(body.sessionId || "").trim();
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]{10,255}$/.test(sessionId)) {
      return json({ error: "Invalid Checkout Session." }, 400);
    }
    const status = await checkoutStatus(env, sessionId, session.userId);
    return status
      ? json(status)
      : json({ error: "This Checkout Session is invalid or belongs to another account." }, 404);
  }

  if (pathname === "/api/stripe/webhook" && request.method === "POST") {
    return json(await handleWebhook(request, env));
  }

  if (pathname.startsWith("/api/account")) {
    const response = await handleAccountRequest(request, env, url, readJson);
    if (response) return response;
  }

  if (
    pathname.startsWith("/api/library") ||
    pathname === "/api/download" ||
    pathname === "/api/account/claim-purchase"
  ) {
    const response = await handleLibraryRequest(request, env, url, readJson);
    if (response) return response;
  }

  if (pathname.startsWith("/api/admin/")) {
    return handleAdmin(request, env, url);
  }

  if (pathname.startsWith("/api/")) {
    return json({ error: "Not found." }, 404);
  }

  if (
    request.method === "GET" &&
    (["/library.html", "/library", "/account.html", "/account"].includes(pathname))
  ) {
    const session = await getCustomerSession(request, env, { touch: false });
    if (!session) {
      const returnTo = safeReturnPath(`${pathname}${url.search}`, "/library.html");
      return Response.redirect(
        `${url.origin}/login.html?return=${encodeURIComponent(returnTo)}`,
        302
      );
    }
  }

  return env.ASSETS.fetch(request);
}

function addSecurityHeaders(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  if ((headers.get("Content-Type") || "").includes("text/html")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
      "script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; " +
      "connect-src 'self'; form-action 'self'"
  );
  if (new URL(request.url).protocol === "https:") {
    headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv) {
    try {
      return addSecurityHeaders(await route(request, env), request);
    } catch (caught) {
      const error = caught instanceof AppError ? caught : new AppError(errorMessage(caught));
      const status = Number(error.status || 500);
      if (status >= 500) {
        console.error("Worker request failed", {
          method: request.method,
          path: new URL(request.url).pathname,
          name: scalarText(error?.name || "Error").slice(0, 80),
          status,
          message: scalarText(error?.message || "Request failed").slice(0, 300),
        });
      }
      const message =
        status < 500 || error.expose
          ? error.message
          : "The server could not complete this request.";
      const headers: Record<string, string> = {};
      if (status === 429 && error.retryAfter) {
        headers["Retry-After"] = scalarText(error.retryAfter);
      }
      if (error.code) headers["X-Error-Code"] = scalarText(error.code);
      return addSecurityHeaders(
        json({ error: message, ...(error.code ? { code: error.code } : {}) }, status, headers),
        request
      );
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
