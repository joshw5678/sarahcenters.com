export interface BookRow {
  id: string; slug: string; number: string; title: string; tagline: string;
  description: string; image_url: string; price_cents: number; currency: string; active: number;
  stripe_epub_price_id: string | null; stripe_epub_pdf_price_id: string | null;
  epub_r2_key: string | null; pdf_r2_key: string | null; created_at: string; updated_at: string;
}
export interface OrderRow {
  id: string; status: string; fulfillment_status: string; payment_status: string;
  receipt_url: string | null; stripe_session_id: string | null; stripe_payment_intent_id: string | null;
  user_id: string | null; customer_name: string; customer_email: string; customer_phone: string;
  customer_address_json: string | null; items_json: string; subtotal_cents: number;
  shipping_cents: number; total_cents: number; currency: string; created_at: string;
  updated_at: string; paid_at: string | null; owner_notes: string; tracking_number: string;
  last_payment_error: string;
}
export interface CountRow { count: number }
export interface ContentRow { key: string; value: string }
export interface DeliveryRow { status: string }
