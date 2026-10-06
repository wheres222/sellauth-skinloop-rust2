# Deployment runbook

1. From this directory, authenticate as the merchant with `wrangler login`.
2. Run `bash scripts/provision.sh`. It creates or reuses the declared D1,
   fulfillment Queue, and DLQ, updates the D1 ID, and applies remote migrations.
   It does not deploy and is safe to repeat.
3. Set the merchant's `SELLAUTH_SHOP_ID` in `wrangler.toml`. The Skinloop API,
   hosted checkout, and SellAuth API URLs are already preconfigured there.
4. Add only these pre-deployment encrypted secrets:

   ```sh
   wrangler secret put SKINLOOP_API_KEY
   wrangler secret put SELLAUTH_API_KEY
   ```

   Skinloop's key must be Rust-restricted and have `checkout:create` and
   `checkout:read` scopes. SellAuth's key must be scoped to this shop.
5. Run `bash scripts/deploy.sh`. It applies any pending D1 migrations and then
   deploys the Worker. The Worker itself rejects missing configuration and
   stays locked until the webhook signing secret is added.
6. Register the exact assigned Worker origin in Skinloop checkout redirect
   origins (origin only, with no `/pay`, `/return`, `/cancel`, or webhook path).
   Register the Worker `/webhook/skinloop` endpoint for pending, completed, and
   reverted events.
7. Store the one-time webhook secret only after deployment:

   ```sh
   wrangler secret put SKINLOOP_WEBHOOK_SECRET_CURRENT
   ```

   Until it exists, payment and delivery routes fail closed. Use
   `SKINLOOP_WEBHOOK_SECRET_PREVIOUS` only during rotation.
8. In SellAuth, add a manual Redirect payment method using the full Worker URL
   plus `/pay?invoice={id}`. Use numeric `{id}` exactly; never use
   `{unique_id}`. The processing call is the official SellAuth GET
   `/v1/shops/{shop_id}/invoices/{id}/process?mark_as_paid=true`.

Never commit API keys, webhook secrets, `.env` files, or customer data.