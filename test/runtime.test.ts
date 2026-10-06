import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/worker.ts";

type AnyRow = Record<string, any>;

function d1(db: DatabaseSync) {
  const wrap = (sql: string, args: any[] = []) => {
    const statement = db.prepare(sql);
    const result = args.length ? statement.run(...args) : statement.run();
    return { meta: { changes: Number(result.changes ?? 0) } };
  };
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            run: async () => wrap(sql, args),
            first: async () => (db.prepare(sql).get(...args) as AnyRow | undefined) ?? null,
            all: async () => ({ results: db.prepare(sql).all(...args) as AnyRow[] }),
          };
        },
        run: async () => wrap(sql),
        first: async () => (db.prepare(sql).get() as AnyRow | undefined) ?? null,
        all: async () => ({ results: db.prepare(sql).all() as AnyRow[] }),
      };
    },
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

class FakeQueue {
  messages: any[] = [];
  async send(body: any) { this.messages.push(body); }
}

const secret = "test-webhook-secret";
const now = () => new Date().toISOString();

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  const queue = new FakeQueue();
  let invoiceStatus = "pending";
  let invoicePaid = "0.00";
  let invoiceEmail = "buyer@sellauth.test";
  let checkoutCustomerEmail: string | undefined;
  let processCalls = 0;
  let failProcessing = false;
  let processResponseFailure = false;
  let checkoutStatus = "completed";
  let checkoutPosts = 0;
  let checkoutExpiry: string | undefined;
  let barrierEnabled = false;
  let releaseProcessing: (() => void) | undefined;
  let processingStarted: (() => void) | undefined;
  const processingBarrier = new Promise<void>((resolve) => { releaseProcessing = resolve; });
  const processingStartedPromise = new Promise<void>((resolve) => { processingStarted = resolve; });
  const fetchMock = async (input: Request | string, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const headers = new Headers(init?.headers);
    if (url.hostname === "sellauth.test") {
      const processing = url.pathname.endsWith("/process");
      if (processing) {
        processCalls++;
        if (failProcessing) return new Response("SellAuth unavailable", { status: 503 });
        if (processCalls === 1) {
          invoiceStatus = "completed";
          invoicePaid = "12.34";
          processingStarted?.();
          if (barrierEnabled && releaseProcessing) await processingBarrier;
          if (processResponseFailure) throw new Error("connection reset after remote processing");
          return Response.json({ success: "Invoice processed" });
        }
      }
      return Response.json({ id: "12345", status: invoiceStatus, currency: "USD", price: "12.34", paid: invoicePaid, email: invoiceEmail });
    }
    if (url.pathname === "/v1/merchant-api/checkouts" && init?.method === "POST") {
      checkoutPosts++;
      const body = JSON.parse(String(init.body));
      checkoutCustomerEmail = body.customerEmail;
      if (typeof body.customerEmail !== "string" || !body.customerEmail.includes("@"))
        return Response.json({ error: "invalid", message: "customerEmail must be a valid email address" }, { status: 400 });
      return Response.json({
        id: `checkout-${checkoutPosts}`,
        hostedUrl: "https://checkout.test/session/123",
        expiresAt: checkoutExpiry ?? new Date(Date.now() + 3600000).toISOString(),
        merchantOrderId: String(body.merchantOrderId),
        amount: body.amount,
        allowedGames: ["rust"],
      });
    }
    if (url.pathname.startsWith("/v1/merchant-api/checkouts/checkout-") && url.pathname.endsWith("/status")) {
      return Response.json({
        id: url.pathname.split("/").at(-2), merchantOrderId: "12345", amount: { value: 1234, currency: "USD" },
        status: checkoutStatus, fulfillmentAllowed: checkoutStatus === "completed",
      });
    }
    throw new Error(`unexpected mocked URL: ${url}`);
  };
  const env: any = {
    DB: d1(db), FULFILLMENT_QUEUE: queue,
    SKINLOOP_API_KEY: "skinloop-key", SKINLOOP_API_BASE_URL: "https://skinloop.test",
    SKINLOOP_HOSTED_ORIGIN: "https://checkout.test",
    SKINLOOP_WEBHOOK_SECRET_CURRENT: secret,
    SELLAUTH_API_KEY: "sellauth-key", SELLAUTH_API_BASE_URL: "https://sellauth.test",
    SELLAUTH_SHOP_ID: "shop-1",
  };
  return {
    db, env, queue, fetchMock, get processCalls() { return processCalls; },
    get checkoutCustomerEmail() { return checkoutCustomerEmail; },
    setInvoice(s: string, paid = s === "completed" ? "12.34" : "0.00") { invoiceStatus = s; invoicePaid = paid; },
    setInvoiceEmail(v: string) { invoiceEmail = v; },
    setFailProcessing(v: boolean) { failProcessing = v; },
    setProcessResponseFailure(v: boolean) { processResponseFailure = v; },
    expireNextCheckout() { checkoutExpiry = new Date(Date.now() - 1000).toISOString(); },
    setCheckoutStatus(s: string) { checkoutStatus = s; },
    get checkoutPosts() { return checkoutPosts; },
    processingStarted: processingStartedPromise,
    releaseProcessing() { releaseProcessing?.(); },
    setProcessingBarrier(v: boolean) { barrierEnabled = v; },
  };
}

async function signedEvent(type: string, data: AnyRow, eventId = `evt-${type}`) {
  eventId = eventId.replace(/[^A-Za-z0-9_-]/g, "-");
  const body = JSON.stringify({ version: "1", id: eventId, type, data: { ...data, status: data.status ?? type.split(".")[1] } });
  const timestamp = String(Math.floor(Date.now() / 1000) - 60);
  const message = new TextEncoder().encode(`${eventId}.${timestamp}.${body}`);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, message))]
    .map((x) => x.toString(16).padStart(2, "0")).join("");
  return new Request("https://merchant.test/webhook/skinloop", {
    method: "POST", body, headers: {
      "Skinloop-Event-Id": eventId, "Skinloop-Timestamp": timestamp,
      "Skinloop-Signature": `v1=${signature}`, "content-type": "application/json",
    },
  });
}

function eventData(overrides: AnyRow = {}) {
  return {
    externalPaymentId: "payment-123", merchantOrderId: "12345", game: "rust",
    currency: "USD", amount: "12.34", requiredAmount: "12.34", overpaymentAmount: "0.00",
    fulfillmentAllowed: true, reservationRequired: false, ...overrides,
  };
}

test("runtime uses real migration and fails closed before payment routes", async () => {
  const f = fixture();
  const bootstrapEnv = { ...f.env, SKINLOOP_WEBHOOK_SECRET_CURRENT: undefined };
  const response = await worker.fetch(new Request("https://merchant.test/"), bootstrapEnv);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).setupRequired, true);
  const locked = await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), bootstrapEnv);
  assert.equal(locked.status, 500);
  f.db.close();
});

test("numeric unpaid checkout is created and second visit reuses it", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchMock as any;
  try {
    const first = await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env);
    assert.equal(first.status, 303);
    assert.equal(first.headers.get("location"), "https://checkout.test/session/123");
    assert.equal(f.checkoutCustomerEmail, "buyer@sellauth.test");
    const second = await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env);
    assert.equal(second.status, 303);
    assert.equal(second.headers.get("location"), "https://checkout.test/session/123");
    assert.equal((f.db.prepare("SELECT amount_minor,status FROM payments WHERE invoice_id='12345'").get() as any).amount_minor, 1234);
    assert.equal((await worker.fetch(new Request("https://merchant.test/pay?invoice=nope"), f.env)).status, 400);
  } finally { globalThis.fetch = original; f.db.close(); }
});

test("invoice without buyer email fails before requesting a checkout", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchMock as any;
  try {
    f.setInvoiceEmail("");
    const response = await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env);
    assert.equal(response.status, 409);
    assert.match(await response.text(), /missing a valid buyer email/);
    assert.equal(f.checkoutPosts, 0);
  } finally { globalThis.fetch = original; f.db.close(); }
});

test("official SellAuth price fixture processes and then reports paid", async () => {
  const f = fixture();
  const process = await f.fetchMock("https://sellauth.test/v1/shops/shop-1/invoices/12345/process?mark_as_paid=true", {
    method: "GET", headers: { Accept: "application/json" },
  });
  assert.deepEqual(await process.json(), { success: "Invoice processed" });
  const reread = await f.fetchMock("https://sellauth.test/v1/shops/shop-1/invoices/12345", { method: "GET" });
  const finalInvoice = await reread.json() as any;
  assert.equal(finalInvoice.status, "completed");
  assert.equal(finalInvoice.paid, finalInvoice.price);
  f.db.close();
});

test("paid invoices and incomplete webhook amount bindings are rejected", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchMock as any;
  try {
    f.setInvoice("paid");
    assert.equal((await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env)).status, 409);
    f.setInvoice("pending");
    f.setInvoice("pending", "1.00");
    assert.equal((await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env)).status, 409);
    f.setInvoice("pending", "0.00");
    await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env);
    const missingRequired = await worker.fetch(await signedEvent("payment.completed", eventData({ requiredAmount: undefined }), "missing-required"), f.env);
    const missingOverpayment = await worker.fetch(await signedEvent("payment.completed", eventData({ overpaymentAmount: undefined }), "missing-overpayment"), f.env);
    assert.equal(missingRequired.status, 409);
    assert.equal(missingOverpayment.status, 409);
  } finally { globalThis.fetch = original; f.db.close(); }
});

test("only an authoritative pre-trade expiry permits a new checkout attempt", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchMock as any;
  try {
    assert.equal((await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env)).status, 303);
    assert.equal(f.checkoutPosts, 1);
    f.db.prepare("UPDATE payments SET checkout_expires_at=? WHERE invoice_id=?").run(new Date(Date.now() - 1000).toISOString(), "12345");
    for (const status of ["pending", "active", "completed"]) {
      f.setCheckoutStatus(status);
      assert.equal((await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env)).status, 409);
      assert.equal(f.checkoutPosts, 1);
    }
    f.setCheckoutStatus("expired");
    assert.equal((await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env)).status, 303);
    assert.equal(f.checkoutPosts, 2);
    const keys = f.db.prepare("SELECT idempotency_key FROM payments").all() as any[];
    assert.equal(keys[0].idempotency_key, "sellauth:rust:v1:12345:2");
  } finally { globalThis.fetch = original; f.db.close(); }
});

test("unsigned, stale, conflicting, pending and mismatched events are rejected", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchMock as any;
  try {
    await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env);
    const pending = await worker.fetch(await signedEvent("payment.pending", eventData()), f.env);
    assert.equal(pending.status, 200);
    assert.equal(f.queue.messages.length, 0);
    const unsigned = await worker.fetch(new Request("https://merchant.test/webhook/skinloop", {
      method: "POST", body: JSON.stringify({ version: "1", id: "bad", type: "payment.completed", data: eventData() }),
      headers: { "Skinloop-Event-Id": "bad", "Skinloop-Timestamp": String(Math.floor(Date.now() / 1000)) },
    }), f.env);
    assert.equal(unsigned.status, 401);
    const stale = await worker.fetch(await signedEvent("payment.completed", eventData(), "stale-event"), f.env);
    assert.equal(stale.status, 200); // fresh signature helper; stale is covered by an explicitly old timestamp below
    const old = await signedEvent("payment.completed", eventData(), "old");
    const oldBody = await old.text();
    const oldHeaders = new Headers(old.headers);
    oldHeaders.set("Skinloop-Timestamp", String(Math.floor(Date.now() / 1000) - 301));
    assert.equal((await worker.fetch(new Request(old.url, { method: "POST", body: oldBody, headers: oldHeaders }), f.env)).status, 401);
    const conflict = await worker.fetch(await signedEvent("payment.pending", eventData({ amount: "12.35" }), "stale-event-2"), f.env);
    assert.equal(conflict.status, 409);
    const mismatch = await worker.fetch(await signedEvent("payment.completed", eventData({ merchantOrderId: "99999" }), "mismatch"), f.env);
    assert.equal(mismatch.status, 409);
  } finally { globalThis.fetch = original; f.db.close(); }
});

test("completed event queues delivery, rechecks, processes and rereads paid SellAuth invoice", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchMock as any;
  try {
    await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env);
    assert.equal((await worker.fetch(await signedEvent("payment.completed", eventData()), f.env)).status, 200);
    assert.equal(f.queue.messages.length, 1);
    const acknowledged: any[] = []; const retried: any[] = [];
    await worker.queue({ messages: [{ body: f.queue.messages[0], ack: () => acknowledged.push(1), retry: () => retried.push(1) }] } as any, f.env);
    assert.deepEqual(acknowledged, [1]); assert.deepEqual(retried, []);
    assert.equal(f.processCalls, 1);
    assert.equal((f.db.prepare("SELECT status,delivered_at FROM payments WHERE invoice_id='12345'").get() as any).status, "completed");
    const duplicate = await worker.fetch(await signedEvent("payment.completed", eventData(), "duplicate"), f.env);
    assert.equal(duplicate.status, 200);
    assert.equal(f.queue.messages.length, 2); // duplicate event is safely idempotent but schedules a retryable delivery
  } finally { globalThis.fetch = original; f.db.close(); }
});

test("reversion before processing blocks delivery and cron never republishes it", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchMock as any;
  try {
    await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env);
    await worker.fetch(await signedEvent("payment.completed", eventData(), "complete-before-revert"), f.env);
    await worker.fetch(await signedEvent("payment.reverted", eventData({ fulfillmentAllowed: false }), "revert-before-process"), f.env);
    const before = f.queue.messages.length;
    await worker.scheduled({}, f.env);
    assert.equal(f.queue.messages.length, before);
    const retried: any[] = [];
    await worker.queue({ messages: [{ body: { invoiceId: "12345" }, ack: () => {}, retry: () => retried.push(1) }] } as any, f.env);
    assert.deepEqual(retried, [1]);
    assert.equal(f.processCalls, 0);
  } finally { globalThis.fetch = original; f.db.close(); }
});

test("remote SellAuth success followed by a lost response is reconciled without double processing", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchMock as any;
  try {
    await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env);
    f.setProcessResponseFailure(true);
    await worker.fetch(await signedEvent("payment.completed", eventData(), "lost-process-response"), f.env);
    const retried: any[] = [];
    await worker.queue({ messages: [{ body: f.queue.messages[0], ack: () => {}, retry: () => retried.push(1) }] } as any, f.env);
    assert.deepEqual(retried, [1]);
    f.setProcessResponseFailure(false);
    await worker.queue({ messages: [{ body: f.queue.messages[0], ack: () => {}, retry: () => retried.push(2) }] } as any, f.env);
    assert.equal(f.processCalls, 1);
  } finally { globalThis.fetch = original; f.db.close(); }
});

test("reversion during async SellAuth processing records delivery for reconciliation", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchMock as any;
  try {
    await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env);
    await worker.fetch(await signedEvent("payment.completed", eventData(), "barrier-completed"), f.env);
    f.setProcessingBarrier(true);
    const retried: any[] = [];
    const delivery = worker.queue({ messages: [{ body: f.queue.messages[0], ack: () => {}, retry: () => retried.push(1) }] } as any, f.env);
    await f.processingStarted;
    await worker.fetch(await signedEvent("payment.reverted", eventData({ fulfillmentAllowed: false }), "barrier-reverted"), f.env);
    f.releaseProcessing();
    await delivery;
    const row = f.db.prepare("SELECT status,delivery_state,delivered_at FROM payments WHERE invoice_id='12345'").get() as any;
    assert.equal(row.status, "reconciliation_required");
    assert.equal(row.delivery_state, "reconciliation_required");
    assert.ok(row.delivered_at, "SellAuth may have delivered; preserve the delivery timestamp for review");
    assert.equal(f.processCalls, 1);
    assert.deepEqual(retried, []);
  } finally { globalThis.fetch = original; f.db.close(); }
});

test("SellAuth failure is retried by cron outbox and reverted blocks delivery", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.fetchMock as any;
  try {
    await worker.fetch(new Request("https://merchant.test/pay?invoice=12345"), f.env);
    await worker.fetch(await signedEvent("payment.completed", eventData(), "complete"), f.env);
    f.setFailProcessing(true);
    const retried: any[] = [];
    await worker.queue({ messages: [{ body: f.queue.messages[0], ack: () => {}, retry: () => retried.push(1) }] } as any, f.env);
    assert.deepEqual(retried, [1]);
    f.db.prepare("UPDATE payments SET lease_until=? WHERE invoice_id=?").run(new Date(Date.now() - 1000).toISOString(), "12345");
    await worker.scheduled({}, f.env);
    assert.ok(f.queue.messages.length >= 2);
    const reverted = await worker.fetch(await signedEvent("payment.reverted", eventData({ fulfillmentAllowed: false }), "revert-event"), f.env);
    assert.equal(reverted.status, 200);
    assert.equal((f.db.prepare("SELECT status,fulfillment_allowed FROM payments WHERE invoice_id='12345'").get() as any).status, "reconciliation_required");
    const before = f.queue.messages.length;
    await worker.queue({ messages: [{ body: { invoiceId: "12345" }, ack: () => {}, retry: () => {} }] } as any, f.env);
    assert.equal(f.queue.messages.length, before);
  } finally { globalThis.fetch = original; f.db.close(); }
});