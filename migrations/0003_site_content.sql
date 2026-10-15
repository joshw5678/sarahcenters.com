-- Editable site copy (hero CTAs, section headings, cart/footer text, SEO).
-- Keyed by the same dotted identifiers used by [data-content] hooks in the
-- static HTML. Missing keys fall back to the built-in defaults in code.
CREATE TABLE IF NOT EXISTS site_content (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
