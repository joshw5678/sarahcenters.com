require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const Stripe = require("stripe");

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const BOOK_UPLOADS_DIR = path.join(UPLOADS_DIR, "books");
const STORE_PATH = process.env.STORE_PATH || path.join(DATA_DIR, "store.json");
const PORT = Number(process.env.PORT || 4242);
const ADMIN_COOKIE = "tc_admin";
const ADMIN_SESSION_MS = 1000 * 60 * 60 * 12;
const SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET ||
  process.env.STRIPE_SECRET_KEY ||
  crypto.randomBytes(32).toString("hex");

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;
const PDF_ADDON_CENTS = 100;

const DEFAULT_BOOKS = [
  {
    id: "through",
    slug: "through",
    number: "1",
    title: "Through the Veil",
    tagline: "The hidden past will not stay buried.",
    desc: "Step into Chris and Tina's shoes as they uncover secrets of their ancestors, discover a hidden realm, face ghosts of the past and confront demons of the present.",
    image: "/images/opt/through-thumb.jpg",
    priceCents: 399,
    currency: "usd",
    active: true,
  },
  {
    id: "refuge",
    slug: "refuge",
    number: "2",
    title: "The Refuge",
    tagline: "Some secrets are worth fighting for.",
    desc: "Aric and his allies find shelter in a hidden stronghold, but safety comes at a cost. As old enemies close in and buried truths rise to the surface, the fight for freedom becomes more dangerous than ever.",
    image: "/images/opt/refuge-thumb.jpg",
    priceCents: 399,
    currency: "usd",
    active: true,
  },
  {
    id: "darkness",
    slug: "darkness",
    number: "3",
    title: "Out of Darkness",
    tagline: "Some secrets are meant to stay buried.",
    desc: "As the shadows of the past rise, the truth becomes more dangerous than the lies. He was never meant to lead. Now he must. The fight for freedom begins where the light ends.",
    image: "/images/opt/darkness-thumb.jpg",
    priceCents: 499,
    currency: "usd",
    active: true,
  },
  {
    id: "brotherhood",
    slug: "brotherhood",
    number: "4",
    title: "Brotherhood",
    tagline: "Bonds forged in truth. Loyalties tested by fire.",
    desc: "In a world where ancient power stirs and empires collide, loyalty is the sharpest weapon-and brotherhood is the only thing worth fighting for.",
    image: "/images/opt/brotherhood-thumb.jpg",
    priceCents: 599,
    currency: "usd",
    active: true,
  },
  {
    id: "silver",
    slug: "silver",
    number: "5",
    title: "Silver Light",
    tagline: "The light remembers. The future answers.",
    desc: "A long-hidden truth comes to light. As ancient forces awaken, hope becomes the final key to a future worth fighting for.",
    image: "/images/opt/silver-thumb.jpg",
    priceCents: 599,
    currency: "usd",
    active: true,
  },
];

// Editable site copy. Keys map to [data-content] / [data-content-placeholder]
// hooks in index.html; the public /api/content endpoint hydrates them at load.
const DEFAULT_CONTENT = {
  "site.title": "S.E. Centers — Author of the Tartarian Chronicles",
  "site.description":
    "S.E. Centers, author of the Tartarian Chronicles — ebook editions of an epic saga of buried truths, ancient power, and the fight for freedom.",
  "brand.name": "S.E. Centers",
  "nav.books": "Books",
  "nav.reviews": "Reviews",
  "nav.login": "Log In",
  "header.orderNow": "Order Now",
  "hero.orderNow": "Order Now",
  "hero.learnMore": "Learn More",
  "series.title": "The Tartarian Chronicles",
  "quote.text":
    "A sweeping, intelligent epic with heart, mystery, and a world you’ll never want to leave.",
  "quote.attribution": "Early Reader",
  "newsletter.heading": "Stay in the Know",
  "newsletter.body":
    "Get news, exclusive content, and early updates from the world of the Tartarian Chronicles.",
  "newsletter.placeholder": "Enter your email",
  "newsletter.button": "Join the Journey",
  "newsletter.confirm": "Welcome to the journey — you’re on the list.",
  "cart.eyebrow": "Secure Checkout",
  "cart.title": "Your Cart",
  "cart.empty": "Your cart is empty.",
  "cart.note": "EPUB is included. Add the PDF version for $1 per book before checkout.",
  "cart.checkout": "Checkout Securely",
  "footer.series": "The Series",
  "footer.books": "Books",
  "footer.extras": "Extras",
  "footer.reviews": "Reviews",
  "footer.library": "My Library",
  "footer.legal": "© 2026 S.E. Centers. All rights reserved.",
};

const CONTENT_MAX_LENGTH = 2000;

let storeCache = null;
let initPromise = null;
let writeChain = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function seedStore() {
  const seededAt = nowIso();
  return {
    version: 1,
    books: DEFAULT_BOOKS.map((book) => ({
      ...book,
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
    content: { ...DEFAULT_CONTENT },
    orders: [],
  };
}

async function saveStore(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmpPath = `${STORE_PATH}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, STORE_PATH);
}

async function ensureStore() {
  if (!initPromise) {
    initPromise = (async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.mkdir(BOOK_UPLOADS_DIR, { recursive: true });

      try {
        const raw = await fs.readFile(STORE_PATH, "utf8");
        storeCache = JSON.parse(raw);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        storeCache = seedStore();
        await saveStore(storeCache);
      }

      if (!Array.isArray(storeCache.books)) storeCache.books = [];
      if (!Array.isArray(storeCache.orders)) storeCache.orders = [];

      let dirty = false;
      if (storeCache.books.length === 0) {
        storeCache.books = seedStore().books;
        dirty = true;
      }
      if (!storeCache.content || typeof storeCache.content !== "object") {
        storeCache.content = {};
      }
      for (const [key, value] of Object.entries(DEFAULT_CONTENT)) {
        if (typeof storeCache.content[key] !== "string") {
          storeCache.content[key] = value;
          dirty = true;
        }
      }
      if (dirty) await saveStore(storeCache);
    })();
  }
  return initPromise;
}

async function readStore() {
  await ensureStore();
  return clone(storeCache);
}

async function mutateStore(mutator) {
  const run = writeChain.then(async () => {
    await ensureStore();
    const result = await mutator(storeCache);
    await saveStore(storeCache);
    return clone(result);
  });
  writeChain = run.catch(() => {});
  return run;
}

function sortBooks(books) {
  return [...books].sort((a, b) => {
    const an = Number(a.number);
    const bn = Number(b.number);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
}

function sortOrders(orders) {
  return [...orders].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
}

function publicBook(book) {
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

function publicContent(content) {
  const merged = {};
  for (const key of Object.keys(DEFAULT_CONTENT)) {
    const value = content && typeof content[key] === "string" && content[key].length
      ? content[key]
      : DEFAULT_CONTENT[key];
    merged[key] = value;
  }
  return merged;
}

function publicOrder(order) {
  return {
    id: order.id,
    status: order.status,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentStatus: order.paymentStatus,
    receiptUrl: order.receiptUrl,
    items: order.items,
    subtotalCents: order.subtotalCents,
    shippingCents: order.shippingCents,
    totalCents: order.totalCents,
    currency: order.currency,
    customer: order.customer,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [
          decodeURIComponent(part.slice(0, index)),
          decodeURIComponent(part.slice(index + 1)),
        ];
      })
  );
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createAdminToken() {
  const payload = base64Url(
    JSON.stringify({ sub: "owner", exp: Date.now() + ADMIN_SESSION_MS })
  );
  return `${payload}.${signPayload(payload)}`;
}

function verifyAdminToken(token) {
  if (!token || !token.includes(".")) return false;
  const [payload, signature] = token.split(".");
  const expected = signPayload(payload);
  if (!constantTimeEqual(signature, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.sub === "owner" && Number(parsed.exp) > Date.now();
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "Owner admin is not configured. Set ADMIN_PASSWORD in your environment.",
    });
  }

  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!verifyAdminToken(token)) {
    return res.status(401).json({ error: "Owner login required." });
  }
  return next();
}

function requiredString(value, label, maxLength = 400) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) throw new Error(`${label} is too long.`);
  return text;
}

function optionalString(value, maxLength = 1000) {
  const text = String(value || "").trim();
  return text.slice(0, maxLength);
}

function parsePriceCents(value) {
  const number = Number(String(value || "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) throw new Error("A valid price is required.");
  const cents = Math.round(number * 100);
  if (cents < 50) throw new Error("Stripe requires a minimum charge of at least $0.50 USD.");
  return cents;
}

function normalizeCurrency(value) {
  const currency = String(value || "usd").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new Error("Currency must be a 3-letter code.");
  return currency;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function sanitizeFilename(value) {
  const ext = path.extname(value).toLowerCase();
  const name = path
    .basename(value, ext)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${name || "cover"}${ext || ".jpg"}`;
}

function getOrigin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function absoluteImageUrl(req, imagePath) {
  if (/^https?:\/\//i.test(imagePath)) return imagePath;
  return new URL(imagePath, `${getOrigin(req)}/`).toString();
}

function normalizeCheckoutItems(rawItems, books) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("Add at least one book to checkout.");
  }

  const booksById = new Map(books.filter((book) => book.active).map((book) => [book.id, book]));
  const merged = new Map();

  rawItems.forEach((item) => {
    const bookId = String(item.bookId || item.id || "").trim();
    const includePdf =
      item.includePdf === true ||
      item.format === "epub_pdf" ||
      item.formats === "epub_pdf" ||
      (Array.isArray(item.formats) && item.formats.includes("pdf"));
    const quantity = Math.max(1, Math.min(99, Math.floor(Number(item.quantity || 1))));
    if (!bookId || !booksById.has(bookId)) throw new Error("One of the selected books is unavailable.");
    const key = `${bookId}:${includePdf ? "epub_pdf" : "epub"}`;
    merged.set(key, {
      bookId,
      includePdf,
      quantity: Math.min(99, (merged.get(key)?.quantity || 0) + quantity),
    });
  });

  const normalized = [...merged.values()].map((entry) => {
    const book = booksById.get(entry.bookId);
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
    };
  });

  const currency = normalized[0].currency;
  if (!normalized.every((item) => item.currency === currency)) {
    throw new Error("All items in one checkout must use the same currency.");
  }

  return normalized;
}

async function syncSessionToOrder(sessionOrId) {
  if (!stripe) return null;

  const sessionId = typeof sessionOrId === "string" ? sessionOrId : sessionOrId.id;
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent.latest_charge"],
  });

  const paymentIntent =
    session.payment_intent && typeof session.payment_intent === "object"
      ? session.payment_intent
      : null;
  const latestCharge =
    paymentIntent &&
    paymentIntent.latest_charge &&
    typeof paymentIntent.latest_charge === "object"
      ? paymentIntent.latest_charge
      : null;
  const orderId = session.metadata?.orderId || session.client_reference_id;
  if (!orderId) return null;

  return mutateStore((data) => {
    const order = data.orders.find((item) => item.id === orderId);
    if (!order) return null;

    const paid = session.payment_status === "paid";
    order.status = paid ? "paid" : session.status === "expired" ? "canceled" : order.status;
    order.paymentStatus = session.payment_status || order.paymentStatus;
    order.fulfillmentStatus =
      paid && order.fulfillmentStatus === "unpaid" ? "new" : order.fulfillmentStatus;
    order.stripeSessionId = session.id;
    order.stripePaymentIntentId = paymentIntent?.id || order.stripePaymentIntentId;
    order.receiptUrl = latestCharge?.receipt_url || order.receiptUrl || null;
    order.totalCents = session.amount_total ?? order.totalCents;
    order.subtotalCents = session.amount_subtotal ?? order.subtotalCents;
    order.shippingCents = 0;
    order.customer = {
      name: session.customer_details?.name || order.customer?.name || "",
      email: session.customer_details?.email || order.customer?.email || "",
      phone: session.customer_details?.phone || order.customer?.phone || "",
      address: session.customer_details?.address || order.customer?.address || null,
    };
    if (paid && !order.paidAt) order.paidAt = nowIso();
    order.updatedAt = nowIso();
    return order;
  });
}

async function handleStripeEvent(event) {
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    await syncSessionToOrder(event.data.object.id);
  }

  if (event.type === "checkout.session.expired") {
    const session = event.data.object;
    const orderId = session.metadata?.orderId || session.client_reference_id;
    if (orderId) {
      await mutateStore((data) => {
        const order = data.orders.find((item) => item.id === orderId);
        if (order && order.status === "pending") {
          order.status = "canceled";
          order.fulfillmentStatus = "canceled";
          order.updatedAt = nowIso();
        }
        return order || null;
      });
    }
  }

  if (
    event.type === "payment_intent.payment_failed" ||
    event.type === "checkout.session.async_payment_failed"
  ) {
    const paymentIntent = event.data.object;
    const orderId = paymentIntent.metadata?.orderId || paymentIntent.client_reference_id;
    if (orderId) {
      await mutateStore((data) => {
        const order = data.orders.find((item) => item.id === orderId);
        if (order) {
          order.status = "failed";
          order.paymentStatus = "failed";
          order.fulfillmentStatus = "unpaid";
          order.lastPaymentError = paymentIntent.last_payment_error?.message || "";
          order.updatedAt = nowIso();
        }
        return order || null;
      });
    }
  }
}

const app = express();
app.set("trust proxy", true);

fsSync.mkdirSync(BOOK_UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, BOOK_UPLOADS_DIR),
    filename: (_req, file, callback) => {
      callback(null, `${Date.now()}-${crypto.randomUUID()}-${sanitizeFilename(file.originalname)}`);
    },
  }),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) callback(null, true);
    else callback(new Error("Book cover must be a PNG, JPG, or WebP image."));
  },
});

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(503).send("Stripe is not configured.");

  let event;
  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } else {
      event = JSON.parse(req.body.toString("utf8"));
    }
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    await handleStripeEvent(event);
    return res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook handler failed:", error);
    return res.status(500).send("Webhook handler failed.");
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/api/books", async (_req, res) => {
  const data = await readStore();
  res.json({ books: sortBooks(data.books).filter((book) => book.active).map(publicBook) });
});

app.get("/api/content", async (_req, res) => {
  const data = await readStore();
  res.json({ content: publicContent(data.content) });
});

app.post("/api/checkout/session", async (req, res) => {
  if (!stripe) {
    return res.status(503).json({
      error: "Stripe checkout is not configured. Set STRIPE_SECRET_KEY first.",
    });
  }

  let pendingOrderId = null;
  try {
    const data = await readStore();
    const items = normalizeCheckoutItems(req.body.items, data.books);
    const currency = items[0].currency;
    const subtotalCents = items.reduce(
      (sum, item) => sum + item.unitAmountCents * item.quantity,
      0
    );
    const createdAt = nowIso();
    const order = {
      id: `ord_${crypto.randomUUID()}`,
      status: "pending",
      fulfillmentStatus: "unpaid",
      paymentStatus: "unpaid",
      receiptUrl: null,
      stripeSessionId: null,
      stripePaymentIntentId: null,
      customer: { name: "", email: "", phone: "", address: null },
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
    };

    await mutateStore((store) => {
      store.orders.push(order);
      return order;
    });
    pendingOrderId = order.id;

    const origin = getOrigin(req);
    const sessionParams = {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: items.map((item) => ({
        quantity: item.quantity,
        price_data: {
          currency: item.currency,
          unit_amount: item.unitAmountCents,
          product_data: {
            name: item.number
              ? `Book ${item.number}: ${item.title} (${item.formatLabel})`
              : `${item.title} (${item.formatLabel})`,
            images: [absoluteImageUrl(req, item.image)],
            metadata: { bookId: item.bookId, format: item.format },
          },
        },
      })),
      client_reference_id: order.id,
      metadata: { orderId: order.id },
      payment_intent_data: { metadata: { orderId: order.id } },
      customer_creation: "always",
      phone_number_collection: { enabled: false },
      billing_address_collection: "auto",
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
    };

    if (process.env.STRIPE_AUTOMATIC_TAX === "true") {
      sessionParams.automatic_tax = { enabled: true };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    await mutateStore((store) => {
      const stored = store.orders.find((item) => item.id === order.id);
      stored.stripeSessionId = session.id;
      stored.updatedAt = nowIso();
      return stored;
    });

    return res.json({ url: session.url, orderId: order.id });
  } catch (error) {
    console.error("Checkout session creation failed:", error);
    if (pendingOrderId) {
      await mutateStore((store) => {
        const stored = store.orders.find((item) => item.id === pendingOrderId);
        if (stored) {
          stored.status = "failed";
          stored.paymentStatus = "failed";
          stored.lastPaymentError = error.message || "Unable to start checkout.";
          stored.updatedAt = nowIso();
        }
        return stored || null;
      }).catch((storeError) => {
        console.error("Unable to mark failed checkout order:", storeError);
      });
    }
    return res.status(400).json({ error: error.message || "Unable to start checkout." });
  }
});

app.get("/api/checkout/receipt", async (req, res) => {
  const sessionId = String(req.query.session_id || "").trim();
  if (!sessionId) return res.status(400).json({ error: "Missing checkout session." });

  try {
    let data = await readStore();
    let order = data.orders.find((item) => item.stripeSessionId === sessionId);

    if (stripe && order && order.status !== "paid") {
      order = await syncSessionToOrder(sessionId);
      data = await readStore();
      order = data.orders.find((item) => item.stripeSessionId === sessionId) || order;
    }

    if (!order) return res.status(404).json({ error: "Order not found." });
    return res.json({ order: publicOrder(order) });
  } catch (error) {
    console.error("Receipt lookup failed:", error);
    return res.status(500).json({ error: "Unable to load receipt." });
  }
});

app.post("/api/admin/login", (req, res) => {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "Owner admin is not configured. Set ADMIN_PASSWORD in your environment.",
    });
  }

  const password = String(req.body.password || "");
  if (!constantTimeEqual(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Incorrect owner password." });
  }

  res.cookie(ADMIN_COOKIE, createAdminToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ADMIN_SESSION_MS,
  });
  return res.json({ ok: true });
});

app.post("/api/admin/logout", (_req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

app.get("/api/admin/me", requireAdmin, (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/admin/books", requireAdmin, async (_req, res) => {
  const data = await readStore();
  res.json({ books: sortBooks(data.books) });
});

app.get("/api/admin/content", requireAdmin, async (_req, res) => {
  const data = await readStore();
  res.json({ content: publicContent(data.content) });
});

app.patch("/api/admin/content", requireAdmin, async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const updates =
      body.content && typeof body.content === "object" ? body.content : body;

    const updated = await mutateStore((data) => {
      if (!data.content || typeof data.content !== "object") data.content = {};
      for (const key of Object.keys(DEFAULT_CONTENT)) {
        if (updates[key] === undefined) continue;
        // Blank a field to reset it back to the built-in default.
        const value = optionalString(updates[key], CONTENT_MAX_LENGTH);
        data.content[key] = value || DEFAULT_CONTENT[key];
      }
      data.contentUpdatedAt = nowIso();
      return data.content;
    });
    return res.json({ content: publicContent(updated) });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Unable to update site text." });
  }
});

app.post("/api/admin/books", requireAdmin, upload.single("cover"), async (req, res) => {
  try {
    const title = requiredString(req.body.title, "Title", 160);
    const createdAt = nowIso();
    const book = {
      id: `book_${crypto.randomUUID()}`,
      slug: slugify(title),
      number: optionalString(req.body.number, 24),
      title,
      tagline: optionalString(req.body.tagline, 240),
      desc: optionalString(req.body.desc, 1200),
      image: req.file ? `/uploads/books/${req.file.filename}` : "",
      priceCents: parsePriceCents(req.body.price),
      currency: normalizeCurrency(req.body.currency),
      active: req.body.active !== "false",
      createdAt,
      updatedAt: createdAt,
    };

    if (!book.image) throw new Error("A book cover image is required.");

    const stored = await mutateStore((data) => {
      data.books.push(book);
      return book;
    });
    return res.status(201).json({ book: stored });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Unable to add book." });
  }
});

app.patch("/api/admin/books/:id", requireAdmin, async (req, res) => {
  try {
    const updated = await mutateStore((data) => {
      const book = data.books.find((item) => item.id === req.params.id);
      if (!book) throw new Error("Book not found.");

      if (req.body.title !== undefined) {
        book.title = requiredString(req.body.title, "Title", 160);
        book.slug = slugify(book.title);
      }
      if (req.body.number !== undefined) book.number = optionalString(req.body.number, 24);
      if (req.body.tagline !== undefined) book.tagline = optionalString(req.body.tagline, 240);
      if (req.body.desc !== undefined) book.desc = optionalString(req.body.desc, 1200);
      if (req.body.price !== undefined) book.priceCents = parsePriceCents(req.body.price);
      if (req.body.currency !== undefined) book.currency = normalizeCurrency(req.body.currency);
      if (req.body.active !== undefined) book.active = Boolean(req.body.active);
      book.updatedAt = nowIso();
      return book;
    });
    return res.json({ book: updated });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Unable to update book." });
  }
});

app.delete("/api/admin/books/:id", requireAdmin, async (req, res) => {
  try {
    const updated = await mutateStore((data) => {
      const book = data.books.find((item) => item.id === req.params.id);
      if (!book) throw new Error("Book not found.");
      book.active = false;
      book.updatedAt = nowIso();
      return book;
    });
    return res.json({ book: updated });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Unable to archive book." });
  }
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const data = await readStore();
  let orders = sortOrders(data.orders);
  const status = String(req.query.status || "").trim();
  if (status) orders = orders.filter((order) => order.status === status);
  res.json({ orders });
});

app.get("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const data = await readStore();
  const order = data.orders.find((item) => item.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  return res.json({ order });
});

app.patch("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const allowed = new Set(["unpaid", "new", "delivered", "packing", "shipped", "complete", "canceled"]);
  try {
    const updated = await mutateStore((data) => {
      const order = data.orders.find((item) => item.id === req.params.id);
      if (!order) throw new Error("Order not found.");

      if (req.body.fulfillmentStatus !== undefined) {
        const status = String(req.body.fulfillmentStatus || "").trim();
        if (!allowed.has(status)) throw new Error("Unknown fulfillment status.");
        order.fulfillmentStatus = status;
      }
      if (req.body.ownerNotes !== undefined) {
        order.ownerNotes = optionalString(req.body.ownerNotes, 1200);
      }
      if (req.body.trackingNumber !== undefined) {
        order.trackingNumber = optionalString(req.body.trackingNumber, 160);
      }
      order.updatedAt = nowIso();
      return order;
    });
    return res.json({ order: updated });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Unable to update order." });
  }
});

app.use("/src", express.static(path.join(ROOT_DIR, "src")));
app.use("/images", express.static(path.join(ROOT_DIR, "images")));
app.use("/assets", express.static(path.join(ROOT_DIR, "assets")));
app.use("/uploads", express.static(UPLOADS_DIR));
app.get("/favicon.png", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "favicon.png"));
});

app.get(["/", "/index.html"], (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

app.get("/success.html", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "success.html"));
});

app.get("/admin.html", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "admin.html"));
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Server error." });
});

ensureStore()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Tartarian site running at http://localhost:${PORT}`);
      if (!process.env.STRIPE_SECRET_KEY) {
        console.warn("Stripe checkout is disabled until STRIPE_SECRET_KEY is set.");
      }
      if (!process.env.ADMIN_PASSWORD) {
        console.warn("Owner admin login is disabled until ADMIN_PASSWORD is set.");
      }
    });
  })
  .catch((error) => {
    console.error("Unable to start server:", error);
    process.exit(1);
  });
