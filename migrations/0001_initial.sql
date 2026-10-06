CREATE TABLE IF NOT EXISTS payments (
  invoice_id TEXT PRIMARY KEY, checkout_id TEXT UNIQUE, hosted_url TEXT,
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, external_payment_id TEXT,
  fulfillment_allowed INTEGER NOT NULL DEFAULT 0, delivery_state TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT, lease_until TEXT, delivered_at TEXT, last_error TEXT,
  attempt INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT NOT NULL UNIQUE, checkout_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY, body_digest TEXT NOT NULL, event_type TEXT NOT NULL,
  invoice_id TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  invoice_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
  published_at TEXT, last_error TEXT, lease_until TEXT, created_at TEXT NOT NULL
);