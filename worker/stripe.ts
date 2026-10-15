import { scalarText } from "../shared/contracts.js";

import { parseFormats } from "../shared/contracts.js";
import type { Book, BookFormat, Order, OrderItem } from "../shared/contracts.js";
import type { StripeGateway, StripeLine, StripeSession, UserRow, PurchaseRow } from "./types.js";
type CheckoutItem = OrderItem & { format: "epub" | "epub_pdf"; formats: BookFormat[]; basePriceCents: number; pdfAddonCents: number; formatLabel: string };
interface CheckoutAccount { userId: string; email: string; displayName?: string; stripeCustomerId?: string | null }
import { eventSchema } from "../shared/contracts.js";
import type { PaymentEvent, PaymentEventObject } from "../shared/contracts.js";
import { AppError, errorMessage, isRecord } from "../shared/contracts.js";
import type { WorkerEnv } from "./types.js";
import Stripe from "stripe";
import {
  beginStripeEvent,
  findBook,
  findOrderById,
  findOrderBySession,
  insertOrder,
  listBooks,
  releaseStripeEvent,
  saveOrder,
} from "./db.js";
import { hashToken, normalizeEmail, randomToken } from "./customer-auth.js";
import { sendClaimEmail, sendPurchaseConfirmation } from "./email.js";

const PDF_ADDON_CENTS = 100;

function stripeClient(env: WorkerEnv): StripeGateway | null {
  if (env.STRIPE_CLIENT) return env.STRIPE_CLIENT;
  if (!env.STRIPE_SECRET_KEY) return null;
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function publicOrigin(request: Request, env: WorkerEnv) {
  const requestUrl = new URL(request.url);
  if (["localhost", "127.0.0.1", "::1"].includes(requestUrl.hostname)) {
    return requestUrl.origin;
  }
  return scalarText(env.PUBLIC_URL || requestUrl.origin).replace(/\/$/, "");
}

function stripeObjectId(value: string | { id?: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id || null;
}

export function normalizeCheckoutItems(rawItems: unknown, books: Book[]): CheckoutItem[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 25) {
    const error = new AppError("Add between 1 and 25 books to checkout.");
    error.status = 400;
    error.expose = true;
    throw error;
  }

  const available = new Map(
    books.filter((book) => book.active).map((book) => [book.id, book])
  );
  const quantities = new Map<string, { bookId: string; includePdf: boolean; quantity: number }>();
  const requestedItems: unknown[] = rawItems;
  for (const rawItem of requestedItems) {
    if (!isRecord(rawItem)) {
      const error = new AppError("A checkout item is invalid.");
      error.status = 400;
      error.expose = true;
      throw error;
    }
    const allowedKeys = ["bookId", "id", "quantity", "includePdf", "format", "formats"];
    if (Object.keys(rawItem).some((key) => !allowedKeys.includes(key))) {
      const error = new AppError("Checkout items contain unsupported fields.");
      error.status = 400;
      error.expose = true;
      throw error;
    }
    const bookId = scalarText(rawItem.bookId || rawItem.id || "").trim();
    const requestedQuantity = Number(rawItem.quantity ?? 1);
    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 20) {
      const error = new AppError("Book quantity must be between 1 and 20.");
      error.status = 400;
      error.expose = true;
      throw error;
    }
    const includePdf =
      rawItem.includePdf === true ||
      rawItem.format === "epub_pdf" ||
      rawItem.formats === "epub_pdf" ||
      (Array.isArray(rawItem.formats) && rawItem.formats.includes("pdf"));
    const book = available.get(bookId);
    if (!book) {
      const error = new AppError("One of the selected books is unavailable.");
      error.status = 400;
      error.expose = true;
      throw error;
    }
    const prior = quantities.get(bookId);
    if (prior && prior.includePdf !== includePdf) {
      prior.includePdf = prior.includePdf || includePdf;
    }
    if (prior) {
      prior.quantity = Math.min(20, prior.quantity + requestedQuantity);
    } else {
      quantities.set(bookId, { bookId, includePdf, quantity: requestedQuantity });
    }
  }

  const items: CheckoutItem[] = [...quantities.values()].map((entry) => {
    const book = available.get(entry.bookId);
    if (!book) throw new AppError("A selected book is unavailable.", 400);
    const pdfAddonCents = entry.includePdf ? PDF_ADDON_CENTS : 0;
    return {
      bookId: entry.bookId,
      title: book.title,
      number: book.number,
      image: book.image,
      quantity: entry.quantity,
      unitAmountCents: book.priceCents + pdfAddonCents,
      basePriceCents: book.priceCents,
      pdfAddonCents,
      currency: book.currency,
      format: entry.includePdf ? "epub_pdf" : "epub",
      formats: entry.includePdf ? ["epub", "pdf"] : ["epub"],
      formatLabel: entry.includePdf ? "EPUB + PDF" : "EPUB",
      stripePriceId: entry.includePdf
        ? book.stripeEpubPdfPriceId || null
        : book.stripeEpubPriceId || null,
    };
  });
  const currency = items[0]?.currency;
  if (!currency) throw new AppError("Add at least one book to checkout.", 400);
  if (!items.every((item) => item.currency === currency)) {
    const error = new AppError("All items in one checkout must use the same currency.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return items;
}

async function checkoutLine(stripe: StripeGateway, item: CheckoutItem, origin: string): Promise<Stripe.Checkout.SessionCreateParams.LineItem> {
  if (item.stripePriceId) {
    const price = await stripe.prices.retrieve(item.stripePriceId);
    if (
      !price.active ||
      price.type !== "one_time" ||
      price.currency !== item.currency ||
      Number(price.unit_amount) !== item.unitAmountCents
    ) {
      const error = new AppError(`The configured Stripe price for ${item.title} is invalid.`);
      error.status = 503;
      throw error;
    }
    return { price: item.stripePriceId, quantity: item.quantity };
  }
  return {
    quantity: item.quantity,
    price_data: {
      currency: item.currency,
      unit_amount: item.unitAmountCents,
      product_data: {
        name: item.number
          ? `Book ${item.number}: ${item.title} (${item.formatLabel})`
          : `${item.title} (${item.formatLabel})`,
        images: [new URL(item.image, `${origin}/`).toString()],
        metadata: { bookId: item.bookId, format: item.format },
      },
    },
  };
}

export async function createCheckout(request: Request, env: WorkerEnv, rawItems: unknown, account: CheckoutAccount) {
  const stripe = stripeClient(env);
  if (!stripe) {
    const error = new AppError("Stripe checkout is not configured yet.");
    error.status = 503;
    error.expose = true;
    throw error;
  }
  if (!account?.userId || !account?.email) {
    const error = new AppError("Please log in before checkout.");
    error.status = 401;
    error.expose = true;
    throw error;
  }

  const books = await listBooks(env, false);
  const items = normalizeCheckoutItems(rawItems, books);
  const currency = items[0]?.currency;
  if (!currency) throw new AppError("Add at least one book to checkout.", 400);
  const subtotalCents = items.reduce(
    (sum, item) => sum + item.unitAmountCents * item.quantity,
    0
  );
  const createdAt = new Date().toISOString();
  const order: Order = {
    id: `ord_${crypto.randomUUID()}`,
    userId: account.userId,
    status: "pending",
    fulfillmentStatus: "unpaid",
    paymentStatus: "unpaid",
    receiptUrl: null,
    stripeSessionId: null,
    stripePaymentIntentId: null,
    customer: {
      name: account.displayName || "",
      email: account.email,
      phone: "",
      address: null,
    },
    items,
    subtotalCents,
    shippingCents: 0,
    totalCents: subtotalCents,
    currency,
    createdAt,
    updatedAt: createdAt,
    paidAt: null,
    ownerNotes: "",
    trackingNumber: "",
    lastPaymentError: "",
  };
  await insertOrder(env, order);

  try {
    const origin = publicOrigin(request, env);
    const lineItems = await Promise.all(
      items.map((item) => checkoutLine(stripe, item, origin))
    );
    const metadata = {
      orderId: order.id,
      userId: account.userId,
      bookIds: items.map((item) => item.bookId).join(",").slice(0, 500),
    };
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: lineItems,
      client_reference_id: order.id,
      metadata,
      payment_intent_data: {
        description: `Tartarian Chronicles order ${order.id}`,
        metadata,
      },
      phone_number_collection: { enabled: false },
      billing_address_collection: "auto",
      success_url: `${origin}/success.html#session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
      expand: ["line_items.data.price.product"],
    };
    if (account.stripeCustomerId) {
      params.customer = account.stripeCustomerId;
      params.customer_update = { name: "auto", address: "auto" };
    } else {
      params.customer_email = account.email;
      params.customer_creation = "always";
    }
    if (scalarText(env.STRIPE_AUTOMATIC_TAX).toLowerCase() === "true") {
      params.automatic_tax = { enabled: true };
    }
    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: order.id,
    });
    const createdLines = session.line_items?.data || [];
    order.items = order.items.map((item, index) => ({
      ...item,
      stripePriceId: stripeObjectId(createdLines[index]?.price) || item.stripePriceId,
    }));
    order.stripeSessionId = session.id;
    order.updatedAt = new Date().toISOString();
    await saveOrder(env, order);
    if (!session.url) throw new AppError("Stripe did not return a checkout URL.");
    return { url: session.url, orderId: order.id };
  } catch (error) {
    order.status = "failed";
    order.paymentStatus = "failed";
    order.lastPaymentError = errorMessage(error, "Unable to start checkout.").slice(0, 300);
    order.updatedAt = new Date().toISOString();
    await saveOrder(env, order);
    throw error;
  }
}

function checkoutAddress(session: StripeSession) {
  return session.customer_details?.address || null;
}

function linePrice(line: StripeLine) {
  return line?.price && typeof line.price === "object" ? line.price : null;
}

function lineProduct(line: StripeLine) {
  const price = linePrice(line);
  return price?.product && typeof price.product === "object" ? price.product : null;
}

async function validatePaidSession(env: WorkerEnv, session: StripeSession, order: Order) {
  if (session.payment_status !== "paid") {
    const error = new AppError("Stripe has not confirmed this payment.");
    error.status = 409;
    throw error;
  }
  const metadataOrderId = session.metadata?.orderId || session.client_reference_id;
  if (!metadataOrderId || metadataOrderId !== order.id) {
    throw new AppError("Stripe Checkout order metadata did not match.");
  }
  if (order.userId && session.metadata?.userId !== order.userId) {
    throw new AppError("Stripe Checkout account metadata did not match.");
  }
  const expectedBookIds = order.items.map((item) => item.bookId).join(",");
  if (session.metadata?.bookIds && session.metadata.bookIds !== expectedBookIds) {
    throw new AppError("Stripe Checkout book metadata did not match.");
  }

  const expectedSubtotal = order.items.reduce(
    (total, item) => total + Number(item.unitAmountCents) * Number(item.quantity),
    0
  );
  if (Number(session.amount_subtotal) !== expectedSubtotal) {
    throw new AppError("Stripe Checkout subtotal did not match the trusted catalog.");
  }
  const lines = session.line_items?.data || [];
  if (lines.length !== order.items.length) {
    throw new AppError("Stripe Checkout line items did not match the order.");
  }

  const matched = [];
  const remaining = [...lines];
  for (const item of order.items) {
    const book = await findBook(env, item.bookId);
    if (!book) throw new AppError("A purchased book no longer exists in the catalog.");
    const configuredPriceId = item.stripePriceId ||
      (item.format === "epub_pdf" ? book.stripeEpubPdfPriceId : book.stripeEpubPriceId);
    const index = remaining.findIndex((line) => {
      const price = linePrice(line);
      const product = lineProduct(line);
      const metadataMatches =
        product?.metadata?.bookId === item.bookId &&
        product?.metadata?.format === item.format;
      const priceMatches = configuredPriceId && price?.id === configuredPriceId;
      return Boolean(priceMatches || metadataMatches);
    });
    if (index < 0) throw new AppError("A Stripe line item did not match the trusted book catalog.");
    const [line] = remaining.splice(index, 1);
    if (!line) throw new AppError("A Stripe line item was missing.");
    const price = linePrice(line);
    if (
      !price ||
      Number(price.unit_amount) !== Number(item.unitAmountCents) ||
      price?.currency !== item.currency ||
      Number(line.quantity) !== Number(item.quantity)
    ) {
      throw new AppError("Stripe line-item pricing did not match the trusted order.");
    }
    matched.push({ item, line, price });
  }
  return matched;
}

async function paidSession(stripe: StripeGateway, sessionId: string) {
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items.data.price.product", "payment_intent.latest_charge"],
  });
}

async function fulfillPaidSession(request: Request, env: WorkerEnv, event: { id: string }, sessionId: string) {
  const stripe = stripeClient(env);
  if (!stripe) throw new AppError("Stripe checkout is not configured.", 503);
  const session = await paidSession(stripe, sessionId);
  const orderId = session.metadata?.orderId || session.client_reference_id;
  const order = orderId ? await findOrderById(env, orderId) : null;
  if (!order) throw new AppError("Paid Stripe Checkout Session has no matching order.");
  if (session.payment_status !== "paid") {
    order.paymentStatus = session.payment_status || order.paymentStatus;
    order.updatedAt = new Date().toISOString();
    await saveOrder(env, order);
    return null;
  }

  const existing = await env.DB.prepare(
    "SELECT * FROM purchases WHERE stripe_checkout_session_id = ?"
  )
    .bind(session.id)
    .first<PurchaseRow>();
  if (existing) return existing;
  const matched = await validatePaidSession(env, session, order);
  const paymentIntent =
    session.payment_intent && typeof session.payment_intent === "object"
      ? session.payment_intent
      : null;
  const latestCharge =
    paymentIntent?.latest_charge && typeof paymentIntent.latest_charge === "object"
      ? paymentIntent.latest_charge
      : null;
  const customerId = stripeObjectId(session.customer);
  const now = new Date().toISOString();
  let pendingEmail = null;
  if (!order.userId) {
    try {
      pendingEmail = normalizeEmail(session.customer_details?.email);
    } catch {
      pendingEmail = null;
    }
  }
  const purchase = {
    id: `pur_${crypto.randomUUID()}`,
    userId: order.userId || null,
    pendingEmail,
    customerId,
    sessionId: session.id,
    paymentIntentId: stripeObjectId(session.payment_intent),
    amountPaid: Number(session.amount_total ?? order.totalCents),
    currency: session.currency || order.currency,
    entitlementStatus: order.userId ? "active" : pendingEmail ? "pending_claim" : "review",
  };
  const statements = [
    env.DB.prepare(
      `INSERT INTO purchases
         (id, user_id, order_id, pending_email_normalized, stripe_customer_id,
          stripe_checkout_session_id, stripe_payment_intent_id, stripe_event_id,
          amount_paid, currency, purchased_at, payment_status,
          entitlement_status, refund_status, revoked_at, revocation_reason,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, 'none', NULL, '', ?, ?)`
    ).bind(
      purchase.id,
      purchase.userId,
      order.id,
      pendingEmail,
      customerId,
      session.id,
      purchase.paymentIntentId,
      event.id,
      purchase.amountPaid,
      purchase.currency,
      now,
      purchase.entitlementStatus,
      now,
      now
    ),
  ];
  matched.forEach(({ item, price }) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO purchase_items
           (id, purchase_id, book_id, stripe_price_id, quantity, unit_amount,
            currency, formats_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        `pit_${crypto.randomUUID()}`,
        purchase.id,
        item.bookId,
        price.id,
        item.quantity,
        item.unitAmountCents,
        item.currency,
        JSON.stringify(parseFormats(item.formats)),
        now
      )
    );
    if (purchase.userId) {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO entitlements
             (id, user_id, purchase_id, book_id, formats_json, status,
              granted_at, revoked_at, revocation_reason)
           VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, '')`
        ).bind(
          `ent_${crypto.randomUUID()}`,
          purchase.userId,
          purchase.id,
          item.bookId,
          JSON.stringify(parseFormats(item.formats)),
          now
        )
      );
    }
  });

  let claimToken = null;
  let claimTokenId = null;
  if (!purchase.userId && pendingEmail) {
    claimToken = randomToken(32);
    claimTokenId = `pct_${crypto.randomUUID()}`;
    statements.push(
      env.DB.prepare(
        `INSERT INTO purchase_claim_tokens
           (id, purchase_id, email_normalized, token_hash, created_at,
            expires_at, used_at, claimed_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
      ).bind(
        claimTokenId,
        purchase.id,
        pendingEmail,
        await hashToken(claimToken),
        now,
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      )
    );
  }
  if (purchase.userId && customerId) {
    statements.push(
      env.DB.prepare(
        `UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?),
           updated_at = ? WHERE id = ?`
      ).bind(customerId, now, purchase.userId)
    );
  }
  await env.DB.batch(statements);

  order.status = "paid";
  order.fulfillmentStatus = purchase.userId ? "delivered" : "pending_claim";
  order.paymentStatus = "paid";
  order.stripeSessionId = session.id;
  order.stripePaymentIntentId = purchase.paymentIntentId;
  order.receiptUrl = latestCharge?.receipt_url || order.receiptUrl || null;
  order.totalCents = purchase.amountPaid;
  order.subtotalCents = Number(session.amount_subtotal ?? order.subtotalCents);
  order.customer = {
    name: session.customer_details?.name || order.customer.name || "",
    email: session.customer_details?.email || order.customer.email || "",
    phone: session.customer_details?.phone || order.customer.phone || "",
    address: checkoutAddress(session) || order.customer.address || null,
  };
  order.paidAt ||= now;
  order.updatedAt = now;
  await saveOrder(env, order);

  const titles = matched.map(({ item }) => item.title);
  if (purchase.userId) {
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(purchase.userId)
      .first<UserRow>();
    if (user) {
      await sendPurchaseConfirmation(
        request,
        env,
        { id: user.id, email: user.email, displayName: user.display_name },
        purchase,
        titles,
        [...new Set(matched.flatMap(({ item }) => parseFormats(item.formats)))]
      );
    }
  } else if (claimToken && claimTokenId && pendingEmail) {
    await sendClaimEmail(
      request,
      env,
      { id: purchase.id, pendingEmail },
      claimToken,
      claimTokenId,
      titles
    );
  }
  return purchase;
}

async function updateFailedOrder(env: WorkerEnv, object: PaymentEventObject) {
  const orderId = object.metadata?.orderId || object.client_reference_id;
  const order = orderId ? await findOrderById(env, orderId) : null;
  if (!order) return;
  order.status = "failed";
  order.paymentStatus = "failed";
  order.fulfillmentStatus = "unpaid";
  order.lastPaymentError = scalarText(
    object.last_payment_error?.message || "Payment failed."
  ).slice(0, 300);
  order.updatedAt = new Date().toISOString();
  await saveOrder(env, order);
}

async function updateRefundOrDispute(env: WorkerEnv, event: PaymentEvent) {
  const object = event.data.object;
  const paymentIntentId = stripeObjectId(object.payment_intent);
  if (!paymentIntentId) return;
  const purchase = await env.DB.prepare(
    "SELECT * FROM purchases WHERE stripe_payment_intent_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(paymentIntentId)
    .first<PurchaseRow>();
  if (!purchase) return;
  const now = new Date().toISOString();

  if (event.type === "charge.refunded" || event.type === "refund.created") {
    const fullyRefunded =
      event.type === "charge.refunded"
        ? Number(object.amount_refunded || 0) >= Number(object.amount || purchase.amount_paid)
        : Number(object.amount || 0) >= Number(purchase.amount_paid);
    if (!fullyRefunded) {
      await env.DB.prepare(
        "UPDATE purchases SET refund_status = 'partial', updated_at = ? WHERE id = ?"
      )
        .bind(now, purchase.id)
        .run();
      return;
    }
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE purchases SET payment_status = 'refunded', refund_status = 'full',
           entitlement_status = 'revoked', revoked_at = ?,
           revocation_reason = 'full_refund', updated_at = ? WHERE id = ?`
      ).bind(now, now, purchase.id),
      env.DB.prepare(
        `UPDATE entitlements SET status = 'revoked', revoked_at = ?,
           revocation_reason = 'full_refund' WHERE purchase_id = ?`
      ).bind(now, purchase.id),
    ]);
    return;
  }

  if (event.type === "charge.dispute.created") {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE purchases SET refund_status = 'disputed', entitlement_status = 'review',
           revoked_at = ?, revocation_reason = 'payment_dispute', updated_at = ?
         WHERE id = ?`
      ).bind(now, now, purchase.id),
      env.DB.prepare(
        `UPDATE entitlements SET status = 'review', revoked_at = ?,
           revocation_reason = 'payment_dispute' WHERE purchase_id = ?`
      ).bind(now, purchase.id),
    ]);
    return;
  }

  if (event.type === "charge.dispute.closed" && object.status === "won") {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE purchases SET refund_status = 'resolved', entitlement_status = 'active',
           revoked_at = NULL, revocation_reason = '', updated_at = ? WHERE id = ?`
      ).bind(now, purchase.id),
      env.DB.prepare(
        `UPDATE entitlements SET status = 'active', revoked_at = NULL,
           revocation_reason = '' WHERE purchase_id = ?`
      ).bind(purchase.id),
    ]);
  }
}

export async function processStripeEvent(request: Request, env: WorkerEnv, rawEvent: unknown) {
  const event = eventSchema.parse(rawEvent);
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const sessionId = event.data.object.id;
    if (!sessionId) throw new AppError("Stripe event is missing a Checkout Session ID.");
    return fulfillPaidSession(request, env, event, sessionId);
  }
  if (event.type === "checkout.session.expired") {
    const session = event.data.object;
    const orderId = session.metadata?.orderId || session.client_reference_id;
    const order = orderId ? await findOrderById(env, orderId) : null;
    if (order && order.status === "pending") {
      order.status = "canceled";
      order.fulfillmentStatus = "canceled";
      order.updatedAt = new Date().toISOString();
      await saveOrder(env, order);
    }
    return null;
  }
  if (
    event.type === "payment_intent.payment_failed" ||
    event.type === "checkout.session.async_payment_failed"
  ) {
    await updateFailedOrder(env, event.data.object);
    return null;
  }
  if (
    event.type === "charge.refunded" ||
    event.type === "refund.created" ||
    event.type === "charge.dispute.created" ||
    event.type === "charge.dispute.closed"
  ) {
    await updateRefundOrDispute(env, event);
  }
  return null;
}

export async function handleWebhook(request: Request, env: WorkerEnv) {
  const stripe = stripeClient(env);
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
    const error = new AppError("Stripe webhook verification is not configured.");
    error.status = 503;
    throw error;
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    const error = new AppError("Missing Stripe signature.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const rawBody = await request.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider()
    );
  } catch {
    const error = new AppError("Invalid Stripe webhook signature.");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const isNew = await beginStripeEvent(env, event);
  if (!isNew) return { received: true, duplicate: true };
  try {
    await processStripeEvent(request, env, event);
    return { received: true };
  } catch (error) {
    await releaseStripeEvent(env, event.id);
    throw error;
  }
}

export async function checkoutStatus(env: WorkerEnv, sessionId: string, userId: string) {
  const order = await findOrderBySession(env, sessionId);
  if (!order || order.userId !== userId) return null;
  const purchase = await env.DB.prepare(
    `SELECT id, entitlement_status, payment_status, purchased_at
     FROM purchases WHERE stripe_checkout_session_id = ? AND user_id = ?`
  )
    .bind(sessionId, userId)
    .first<Pick<PurchaseRow, "id" | "entitlement_status" | "payment_status" | "purchased_at">>();
  if (!purchase || purchase.entitlement_status !== "active") {
    return { status: "processing", orderId: order.id, books: [] };
  }
  const result = await env.DB.prepare(
    `SELECT b.id, b.number, b.title, b.image_url, pi.formats_json
     FROM purchase_items pi JOIN books b ON b.id = pi.book_id
     WHERE pi.purchase_id = ? ORDER BY b.title`
  )
    .bind(purchase.id)
    .all<{ id: string; number: string; title: string; image_url: string; formats_json: string }>();
  return {
    status: "ready",
    orderId: order.id,
    purchaseDate: purchase.purchased_at,
    books: (result.results || []).map((row) => ({
      id: row.id,
      number: row.number,
      title: row.title,
      image: row.image_url,
      formats: parseFormats(row.formats_json),
    })),
  };
}
