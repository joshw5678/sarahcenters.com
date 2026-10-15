import * as z from "zod";

export const formatSchema = z.enum(["epub", "pdf"]);
export type BookFormat = z.infer<typeof formatSchema>;
export const formatsSchema = z.array(formatSchema);
export const contentSchema = z.record(z.string(), z.string());
export type SiteContent = z.infer<typeof contentSchema>;

export const bookSchema = z.object({
  id: z.string(), slug: z.string(), number: z.string(), title: z.string(),
  tagline: z.string(), desc: z.string(), image: z.string(),
  priceCents: z.number().int().nonnegative(), currency: z.string(), active: z.boolean(),
  stripeEpubPriceId: z.string().nullable().optional(),
  stripeEpubPdfPriceId: z.string().nullable().optional(),
  epubKey: z.string().nullable().optional(), pdfKey: z.string().nullable().optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
});
export type Book = z.infer<typeof bookSchema>;
export const booksResponseSchema = z.object({ books: z.array(bookSchema) });

export const addressSchema = z.object({
  line1: z.string().nullable().optional(), line2: z.string().nullable().optional(),
  city: z.string().nullable().optional(), state: z.string().nullable().optional(),
  postal_code: z.string().nullable().optional(), country: z.string().nullable().optional(),
});
export type Address = z.infer<typeof addressSchema>;
export const orderItemSchema = z.object({
  bookId: z.string(), title: z.string(), number: z.string(), image: z.string(),
  quantity: z.number().int().positive(), unitAmountCents: z.number().int().nonnegative(),
  basePriceCents: z.number().int().nonnegative().optional(),
  pdfAddonCents: z.number().int().nonnegative().optional(), currency: z.string(),
  format: z.enum(["epub", "epub_pdf"]).optional(),
  formats: formatsSchema.optional(), formatLabel: z.string().optional(),
  stripePriceId: z.string().nullable().optional(),
});
export type OrderItem = z.infer<typeof orderItemSchema>;
export const orderSchema = z.object({
  id: z.string(), status: z.string(), fulfillmentStatus: z.string(), paymentStatus: z.string(),
  receiptUrl: z.string().nullable(), stripeSessionId: z.string().nullable().optional(),
  stripePaymentIntentId: z.string().nullable().optional(), userId: z.string().nullable().optional(),
  customer: z.object({ name: z.string(), email: z.string(), phone: z.string(), address: addressSchema.nullable() }),
  items: z.array(orderItemSchema), subtotalCents: z.number(), shippingCents: z.number(),
  totalCents: z.number(), currency: z.string(), createdAt: z.string(), updatedAt: z.string().optional(),
  paidAt: z.string().nullable(), ownerNotes: z.string().optional(), trackingNumber: z.string().optional(),
  lastPaymentError: z.string().optional(),
});
export type Order = z.infer<typeof orderSchema>;
export const ordersResponseSchema = z.object({ orders: z.array(orderSchema) });
export const userSchema = z.object({
  id: z.string(), email: z.string(), displayName: z.string(), emailVerified: z.boolean(),
  createdAt: z.string(), lastLoginAt: z.string().nullable(), status: z.string(),
});
export type AccountUser = z.infer<typeof userSchema>;
export const accountResponseSchema = z.object({
  user: userSchema, csrfToken: z.string(), sessionExpiresAt: z.string().optional(),
});
export type AccountResponse = z.infer<typeof accountResponseSchema>;
export const messageResponseSchema = z.object({
  ok: z.boolean().optional(), message: z.string().optional(), emailSent: z.boolean().nullable().optional(),
  user: userSchema.optional(), csrfToken: z.string().optional(),
});
export const libraryBookSchema = z.object({
  id: z.string(), slug: z.string(), number: z.string(), title: z.string(), description: z.string(),
  image: z.string(), purchaseDate: z.string(), firstPurchasedAt: z.string(), formats: formatsSchema,
});
export type LibraryBook = z.infer<typeof libraryBookSchema>;
export const libraryResponseSchema = z.object({ books: z.array(libraryBookSchema) });
export const purchaseBookSchema = z.object({
  id: z.string(), number: z.string(), title: z.string(), image: z.string(), formats: formatsSchema,
});
export type PurchaseBook = z.infer<typeof purchaseBookSchema>;
export const checkoutStatusSchema = z.object({
  status: z.enum(["processing", "ready"]), orderId: z.string(),
  purchaseDate: z.string().optional(), books: z.array(purchaseBookSchema),
});
export const checkoutResponseSchema = z.object({ url: z.string(), orderId: z.string() });
export const downloadResponseSchema = z.object({ url: z.string(), expiresAt: z.string() });
export const contentResponseSchema = z.object({ content: contentSchema });
export const cartItemSchema = z.object({
  bookId: z.string(), quantity: z.number().int().min(1).max(99), includePdf: z.boolean(),
});
export type CartItem = z.infer<typeof cartItemSchema>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  throw new AppError("Expected a text value.", 400);
}

export function errorMessage(error: unknown, fallback = "The request could not be completed."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export class AppError extends Error {
  status: number;
  expose: boolean;
  code?: string;
  retryAfter?: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.expose = status < 500;
  }
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new AppError("Request body must be a JSON object.", 400);
  return value;
}

export function parseFormats(value: unknown): BookFormat[] {
  let input: unknown = value;
  if (typeof input === "string") {
    try { input = parseJson(input); } catch { return []; }
  }
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((entry: unknown): entry is BookFormat => entry === "epub" || entry === "pdf"))];
}

export const eventObjectSchema = z.object({
  id: z.string().optional(), metadata: z.record(z.string(), z.string()).nullable().optional(),
  client_reference_id: z.string().nullable().optional(),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullable().optional(),
  last_payment_error: z.object({ message: z.string().optional() }).nullable().optional(),
  amount: z.number().optional(), amount_refunded: z.number().optional(), status: z.string().optional(),
});
export const eventSchema = z.object({ id: z.string(), type: z.string(), data: z.object({ object: eventObjectSchema }) });
export type PaymentEvent = z.infer<typeof eventSchema>;
export type PaymentEventObject = z.infer<typeof eventObjectSchema>;
