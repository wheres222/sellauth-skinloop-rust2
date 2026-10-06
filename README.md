# SellAuth → Skinloop Rust Cloudflare Worker

Standalone merchant-owned template. It accepts only `GET /pay?invoice={id}`
with a numeric SellAuth invoice ID and creates an immutable USD/Rust-only
Skinloop checkout. The browser return is never proof of payment. Delivery is
allowed only after a signed Skinloop `completed` event and fresh reads of both
APIs.

SellAuth API schemas and authentication are deliberately not inferred. The
official API base including `/v1` is preconfigured; provide a shop-scoped
Bearer key. The Worker
accepts only a documented invoice object with `id`, `status` (`pending` or
`confirming`), `price`, `paid` (`0.00`), `currency`, and a buyer `email`;
any other response fails closed. The invoice email is passed as the required
`customerEmail` when creating the Skinloop checkout.
Processing uses the official GET
`/v1/shops/{shop_id}/invoices/{id}/process?mark_as_paid=true` operation and
requires a subsequent authoritative `completed` read with `paid` equal to
`price`.

The webhook verifies raw bytes with current/previous HMAC secrets and a five
minute replay window. Duplicate IDs are idempotent; mismatches are rejected.
Completed events queue durable D1 outbox work. Pending events never deliver and
reverted events cannot deliver. Queue retries and the declared DLQ handle
transient failures.

## Merchant setup

For the hosted setup, use the Deploy to Cloudflare button in the Skinloop
SellAuth guide. Cloudflare
provisions the declared D1 database and Queues from `wrangler.toml`; the
`deploy` script applies D1 migrations by binding before deploying. The three
service URLs are preconfigured. Enter only the shop ID and two API keys
(encrypted secrets) when prompted. Add the Skinloop webhook secret after the
Worker has a URL.

The commands below are for merchants who prefer to deploy manually.

The template provisions resources in the merchant's Cloudflare account. It does
not connect to or deploy any Skinloop or SellAuth service. Log in with the
merchant's Cloudflare identity before running the scripts.

```sh
npm install
bash scripts/provision.sh
# Set SELLAUTH_SHOP_ID in wrangler.toml.
```

`provision.sh` is repeatable: it creates (or reuses) the declared D1 database,
fulfillment Queue, and dead-letter Queue, writes the D1 ID into `wrangler.toml`,
and applies the checked-in migrations remotely. It never handles secrets.

Before deployment, set `SELLAUTH_SHOP_ID` to the merchant's shop ID (not a
product ID) in `wrangler.toml`. The Skinloop API, Skinloop checkout, and
SellAuth API URLs are already set there.

Store only API credentials as Cloudflare encrypted secrets before deployment:

```sh
wrangler secret put SKINLOOP_API_KEY
wrangler secret put SELLAUTH_API_KEY
bash scripts/deploy.sh
```

After deployment, register the reported `/webhook/skinloop` endpoint in
Skinloop, save its one-time signing secret, and then run:

```sh
wrangler secret put SKINLOOP_WEBHOOK_SECRET_CURRENT
```

The webhook secret is intentionally never requested by the deploy button or
initial setup. During rotation, put the old value in
`SKINLOOP_WEBHOOK_SECRET_PREVIOUS`. Until the current secret exists, only the
root setup/status response is exposed.

In SellAuth, configure a manual **Redirect** payment method to the full Worker
URL followed by `/pay?invoice={id}`. Keep `{id}` numeric and unchanged; do not
use `{unique_id}`. Register only the assigned Worker origin in Skinloop checkout
redirect origins, not a path.