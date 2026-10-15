import type Stripe from "stripe";
import type { AccountUser } from "../shared/contracts.js";

export interface EmailMessage { to: string; subject: string; html: string; text: string }
export interface EmailRecipient { id: string; email: string; displayName?: string }
export interface StripePrice {
  id: string;
  active?: boolean; type?: string; unit_amount?: number | null; currency?: string;
  product?: string | { id?: string; metadata?: Record<string, string> | null; deleted?: boolean | void };
}
export interface StripeLine { quantity?: number | null; price?: StripePrice | null }
export interface StripeSession {
  id: string; url?: string | null; payment_status?: string; status?: string | null;
  metadata?: Record<string, string> | null; client_reference_id?: string | null;
  amount_subtotal?: number | null; amount_total?: number | null; currency?: string | null;
  customer?: string | { id: string } | null;
  customer_details?: { email?: string | null; name?: string | null; phone?: string | null; address?: Stripe.Address | null } | null;
  payment_intent?: string | { id: string; latest_charge?: string | { id: string; receipt_url?: string | null } | null } | null;
  line_items?: { data: StripeLine[]; has_more?: boolean };
}
export interface StripeGateway {
  prices: { retrieve(id: string): Promise<StripePrice> };
  checkout: { sessions: {
    create(params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions): Promise<StripeSession>;
    retrieve(id: string, params?: Stripe.Checkout.SessionRetrieveParams): Promise<StripeSession>;
  } };
  webhooks: Pick<Stripe.Webhooks, "constructEventAsync">;
}
export interface WorkerEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  BOOK_COVERS: R2Bucket;
  BOOK_FILES: R2Bucket;
  SESSION_SECRET?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_SESSION_SECRET?: string;
  PASSWORD_HASH_ITERATIONS?: string;
  PUBLIC_URL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_AUTOMATIC_TAX?: string;
  STRIPE_CLIENT?: StripeGateway;
  EMAIL_SENDER?: { send(message: EmailMessage & { dedupeKey: string }): Promise<{ id?: string }> };
  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  EMAIL_API_KEY?: string;
  EMAIL_API_URL?: string;
  EMAIL_MESSAGE_STREAM?: string;
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  AWS_SES_CONFIGURATION_SET?: string;
}
export interface UserRow {
  id: string; email: string; email_normalized: string; password_hash: string;
  display_name: string; email_verified_at: string | null; created_at: string;
  updated_at: string; last_login_at: string | null; status: string; stripe_customer_id: string | null;
}
export interface CustomerSession {
  id: string; userId: string; csrfToken: string; expiresAt: string;
  stripeCustomerId: string | null; user: AccountUser;
}
export interface PurchaseRow {
  id: string; user_id: string | null; order_id: string | null;
  pending_email_normalized: string | null; stripe_customer_id: string | null;
  stripe_checkout_session_id: string; stripe_payment_intent_id: string | null;
  stripe_event_id: string; amount_paid: number; currency: string; purchased_at: string;
  payment_status: string; entitlement_status: string; refund_status: string;
  revoked_at: string | null; revocation_reason: string; created_at: string; updated_at: string;
}
export type ReadJson = (request: Request) => Promise<unknown>;
