import { CONTENT_MAX_LENGTH, DEFAULT_BOOKS, DEFAULT_CONTENT } from "./catalog.js";

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function rowToBook(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    number: row.number,
    title: row.title,
    tagline: row.tagline,
    desc: row.description,
    image: row.image_url,
    priceCents: row.price_cents,
    currency: row.currency,
    active: Boolean(row.active),
    stripeEpubPriceId: row.stripe_epub_price_id || null,
    stripeEpubPdfPriceId: row.stripe_epub_pdf_price_id || null,
    epubKey: row.epub_r2_key || null,
    pdfKey: row.pdf_r2_key || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    fulfillmentStatus: row.fulfillment_status,
    paymentStatus: row.payment_status,
    receiptUrl: row.receipt_url || null,
    stripeSessionId: row.stripe_session_id || null,
    stripePaymentIntentId: row.stripe_payment_intent_id || null,
    userId: row.user_id || null,
    customer: {
      name: row.customer_name || "",
      email: row.customer_email || "",
      phone: row.customer_phone || "",
      address: parseJson(row.customer_address_json, null),
    },
    items: parseJson(row.items_json, []),
    subtotalCents: row.subtotal_cents,
    shippingCents: row.shipping_cents,
    totalCents: row.total_cents,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at || null,
    ownerNotes: row.owner_notes || "",
    trackingNumber: row.tracking_number || "",
    lastPaymentError: row.last_payment_error || "",
  };
}

export async function ensureSeedBooks(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM books").first();
  if (Number(row?.count || 0) > 0) return;

  const timestamp = new Date().toISOString();
  const statements = DEFAULT_BOOKS.map((book) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO books
       (id, slug, number, title, tagline, description, image_url, price_cents,
        currency, active, stripe_epub_price_id, stripe_epub_pdf_price_id,
        epub_r2_key, pdf_r2_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      book.id,
      book.slug,
      book.number,
      book.title,
      book.tagline,
      book.desc,
      book.image,
      book.priceCents,
      book.currency,
      book.active ? 1 : 0,
      book.stripeEpubPriceId || null,
      book.stripeEpubPdfPriceId || null,
      book.epubKey,
      book.pdfKey,
      timestamp,
      timestamp
    )
  );
  await env.DB.batch(statements);
}

export async function listBooks(env, includeInactive = false) {
  await ensureSeedBooks(env);
  const where = includeInactive ? "" : "WHERE active = 1";
  const result = await env.DB.prepare(
    `SELECT * FROM books ${where}
     ORDER BY CAST(number AS INTEGER), created_at, title`
  ).all();
  return result.results.map(rowToBook);
}

export async function findBook(env, id) {
  return rowToBook(
    await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(id).first()
  );
}

export async function insertBook(env, book) {
  await env.DB.prepare(
    `INSERT INTO books
     (id, slug, number, title, tagline, description, image_url, price_cents,
      currency, active, stripe_epub_price_id, stripe_epub_pdf_price_id,
      epub_r2_key, pdf_r2_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      book.id,
      book.slug,
      book.number,
      book.title,
      book.tagline,
      book.desc,
      book.image,
      book.priceCents,
      book.currency,
      book.active ? 1 : 0,
      book.stripeEpubPriceId || null,
      book.stripeEpubPdfPriceId || null,
      book.epubKey || null,
      book.pdfKey || null,
      book.createdAt,
      book.updatedAt
    )
    .run();
  return findBook(env, book.id);
}

export async function updateBook(env, book) {
  await env.DB.prepare(
    `UPDATE books SET
      slug = ?, number = ?, title = ?, tagline = ?, description = ?,
      image_url = ?, price_cents = ?, currency = ?, active = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      book.slug,
      book.number,
      book.title,
      book.tagline,
      book.desc,
      book.image,
      book.priceCents,
      book.currency,
      book.active ? 1 : 0,
      book.updatedAt,
      book.id
    )
    .run();
  return findBook(env, book.id);
}

function orderBindings(order) {
  return [
    order.status,
    order.fulfillmentStatus,
    order.paymentStatus,
    order.receiptUrl,
    order.stripeSessionId,
    order.stripePaymentIntentId,
    order.userId || null,
    order.customer?.name || "",
    order.customer?.email || "",
    order.customer?.phone || "",
    order.customer?.address ? JSON.stringify(order.customer.address) : null,
    JSON.stringify(order.items || []),
    order.subtotalCents,
    order.shippingCents,
    order.totalCents,
    order.currency,
    order.createdAt,
    order.updatedAt,
    order.paidAt,
    order.ownerNotes || "",
    order.trackingNumber || "",
    order.lastPaymentError || "",
  ];
}

export async function insertOrder(env, order) {
  await env.DB.prepare(
    `INSERT INTO orders
     (status, fulfillment_status, payment_status, receipt_url,
      stripe_session_id, stripe_payment_intent_id, user_id, customer_name, customer_email,
      customer_phone, customer_address_json, items_json, subtotal_cents,
      shipping_cents, total_cents, currency, created_at, updated_at, paid_at,
      owner_notes, tracking_number, last_payment_error, id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(...orderBindings(order), order.id)
    .run();
  return order;
}

export async function saveOrder(env, order) {
  await env.DB.prepare(
    `UPDATE orders SET
      status = ?, fulfillment_status = ?, payment_status = ?, receipt_url = ?,
      stripe_session_id = ?, stripe_payment_intent_id = ?, user_id = ?, customer_name = ?,
      customer_email = ?, customer_phone = ?, customer_address_json = ?,
      items_json = ?, subtotal_cents = ?, shipping_cents = ?, total_cents = ?,
      currency = ?, created_at = ?, updated_at = ?, paid_at = ?, owner_notes = ?,
      tracking_number = ?, last_payment_error = ?
     WHERE id = ?`
  )
    .bind(...orderBindings(order), order.id)
    .run();
  return order;
}

export async function findOrderById(env, id) {
  return rowToOrder(
    await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first()
  );
}

export async function findOrderBySession(env, sessionId) {
  return rowToOrder(
    await env.DB.prepare("SELECT * FROM orders WHERE stripe_session_id = ?")
      .bind(sessionId)
      .first()
  );
}

export async function listOrders(env, status = "") {
  const statement = status
    ? env.DB.prepare(
        "SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT 500"
      ).bind(status)
    : env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500");
  const result = await statement.all();
  return result.results.map(rowToOrder);
}

function normalizeContentValue(value, fallback) {
  const text = String(value ?? "").trim().slice(0, CONTENT_MAX_LENGTH);
  return text || fallback;
}

export async function getContentMap(env) {
  const merged = { ...DEFAULT_CONTENT };
  try {
    const result = await env.DB.prepare(
      "SELECT key, value FROM site_content"
    ).all();
    for (const row of result.results || []) {
      if (
        row &&
        Object.prototype.hasOwnProperty.call(merged, row.key) &&
        typeof row.value === "string" &&
        row.value.length
      ) {
        merged[row.key] = row.value;
      }
    }
  } catch {
    // site_content table may not exist yet (migration pending) — use defaults.
  }
  return merged;
}

export async function saveContentMap(env, updates) {
  const timestamp = new Date().toISOString();
  const statements = [];
  for (const key of Object.keys(DEFAULT_CONTENT)) {
    if (updates[key] === undefined) continue;
    // Blank a field to reset it back to the built-in default.
    const value = normalizeContentValue(updates[key], DEFAULT_CONTENT[key]);
    statements.push(
      env.DB.prepare(
        `INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(key, value, timestamp)
    );
  }
  if (statements.length) await env.DB.batch(statements);
  return getContentMap(env);
}

export async function beginStripeEvent(env, event) {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO stripe_events (event_id, event_type, processed_at)
     VALUES (?, ?, ?)`
  )
    .bind(event.id, event.type, new Date().toISOString())
    .run();
  return Number(result.meta?.changes || 0) === 1;
}

export async function releaseStripeEvent(env, eventId) {
  await env.DB.prepare("DELETE FROM stripe_events WHERE event_id = ?")
    .bind(eventId)
    .run();
}
