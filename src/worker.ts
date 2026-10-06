import { numericInvoice, minor, decimalMinor, eventState, exactBinding, verify, MAX_WEBHOOK_BYTES } from "./logic";

interface Env {
  DB: D1Database; FULFILLMENT_QUEUE: Queue;
  SKINLOOP_API_KEY?: string; SKINLOOP_API_BASE_URL?: string; SKINLOOP_HOSTED_ORIGIN?: string;
  SKINLOOP_WEBHOOK_SECRET_CURRENT?: string; SKINLOOP_WEBHOOK_SECRET_PREVIOUS?: string;
  SELLAUTH_API_KEY?: string; SELLAUTH_API_BASE_URL?: string; SELLAUTH_SHOP_ID?: string;
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {status, headers: {"content-type":"application/json","cache-control":"no-store"}});
const text = (v: string, status = 400) => new Response(v, {status, headers: {"content-type":"text/plain;charset=utf-8","cache-control":"no-store"}});
const clean = (v: unknown, n=500) => String(v ?? "").trim().slice(0,n);
function configured(e: Env, webhook = true) {
  const names: Array<keyof Env> = ["SKINLOOP_API_KEY","SKINLOOP_API_BASE_URL","SKINLOOP_HOSTED_ORIGIN","SELLAUTH_API_KEY","SELLAUTH_API_BASE_URL","SELLAUTH_SHOP_ID"];
  if (webhook) names.push("SKINLOOP_WEBHOOK_SECRET_CURRENT");
  const missing = names.filter(k => !clean(e[k]));
  for (const k of ["SKINLOOP_API_BASE_URL","SKINLOOP_HOSTED_ORIGIN","SELLAUTH_API_BASE_URL"] as Array<keyof Env>) {
    if (clean(e[k])) { const u = new URL(String(e[k])); if (u.protocol !== "https:") throw new Error(`${k} must use HTTPS`); }
  }
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
}
async function skinloop(e: Env, path: string, init: RequestInit = {}) {
  const h = new Headers(init.headers); h.set("Authorization", `Bearer ${e.SKINLOOP_API_KEY}`); h.set("Accept","application/json");
  if (init.body) h.set("content-type","application/json");
  const r = await fetch(`${e.SKINLOOP_API_BASE_URL!.replace(/\/+$/,"")}${path}`, {...init, headers:h, signal:AbortSignal.timeout(30000)});
  const body = await r.json().catch(() => ({})); return {r, body};
}
function unwrap(x: any) { return x?.checkout || x?.payment || x?.data?.checkout || x?.data?.payment || x?.data || x; }
async function sellauth(e: Env, invoice: string, process = false) {
  /* SellAuth's API response is intentionally parsed narrowly. Unknown documented
     variants fail closed rather than guessing paid/unpaid or amount. */
  const path = `/shops/${encodeURIComponent(e.SELLAUTH_SHOP_ID!)}/invoices/${encodeURIComponent(invoice)}${process ? "/process?mark_as_paid=true" : ""}`;
  const r = await fetch(`${e.SELLAUTH_API_BASE_URL!.replace(/\/+$/,"")}${path}`, {
    method: "GET", headers: {Authorization:`Bearer ${e.SELLAUTH_API_KEY}`, Accept:"application/json"},
    signal: AbortSignal.timeout(30000)
  });
  const b: any = await r.json().catch(() => null);
  if (process) return r.ok && b?.success === "Invoice processed" ? b : null;
  if (!r.ok || !b || String(b.id ?? b.invoice_id) !== invoice) return null;
  return b;
}
function invoiceDetails(i: any) {
  const status = clean(i.status).toLowerCase();
  const currency = clean(i.currency).toUpperCase();
  const raw = i.price;
  const paidMinor = typeof i.paid === "string" ? decimalMinor(i.paid) : Number.NaN;
  if (!["pending","confirming"].includes(status) || paidMinor !== 0 || currency !== "USD") return null;
  try { return {status, currency, amount_minor: minor(raw)}; } catch { return null; }
}
function paidInvoiceDetails(i: any) {
  if (!i || clean(i.status).toLowerCase() !== "completed" || clean(i.currency).toUpperCase() !== "USD") return null;
  try {
    const amount = minor(i.price);
    if (typeof i.paid !== "string" || decimalMinor(i.paid) !== amount) return null;
    return {amount_minor: amount, currency:"USD"};
  } catch { return null; }
}
async function pay(url: URL, e: Env) {
  const id = numericInvoice(url.searchParams.get("invoice"));
  if (!id) return text("A numeric invoice is required.",400);
  const i = await sellauth(e,id); const d = i && invoiceDetails(i);
  if (!d) return text("This invoice cannot currently be paid.",409);
  const customerEmail = typeof i.email === "string" ? i.email.trim() : "";
  if (!customerEmail || customerEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))
    return text("SellAuth invoice is missing a valid buyer email.",409);
  const old: any = await e.DB.prepare("SELECT * FROM payments WHERE invoice_id=?").bind(id).first();
  let retryExpired = false;
  if (old) {
    if (Number(old.amount_minor)!==d.amount_minor || old.currency !== d.currency) return text("Invoice amount changed; manual review required.",409);
    if (old.external_payment_id || !["creating","created"].includes(old.status)) return text("A payment is already in progress or requires review.",409);
    if (old.hosted_url && old.checkout_expires_at && Date.parse(old.checkout_expires_at)>Date.now()) return Response.redirect(old.hosted_url,303);
    if (old.hosted_url || old.checkout_id) {
      if (!old.checkout_id || !old.checkout_expires_at || Date.parse(old.checkout_expires_at)>Date.now()) return text("The previous checkout requires review.",409);
      const previous = await skinloop(e,`/v1/merchant-api/checkouts/${encodeURIComponent(old.checkout_id)}/status`);
      const prior = unwrap(previous.body);
      if (!previous.r.ok || String(prior.id)!==String(old.checkout_id) || String(prior.merchantOrderId)!==id ||
          Number(prior.amount?.value ?? prior.amount)!==d.amount_minor || String(prior.amount?.currency).toUpperCase()!=="USD" ||
          prior.status!=="expired" || prior.fulfillmentAllowed===true) {
        return text("The previous checkout is not confirmed expired before a trade.",409);
      }
      retryExpired = true;
    }
  }
  const key = old ? `sellauth:rust:v1:${id}:${Number(old.attempt || 1) + (retryExpired ? 1 : 0)}` : `sellauth:rust:v1:${id}:1`;
  if (!old) {
    try {
      await e.DB.prepare("INSERT INTO payments(invoice_id,amount_minor,currency,status,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(id,d.amount_minor,"USD","creating",key,new Date().toISOString(),new Date().toISOString()).run();
    } catch {
      const raced:any=await e.DB.prepare("SELECT * FROM payments WHERE invoice_id=?").bind(id).first();
      if (!raced || Number(raced.amount_minor)!==d.amount_minor || raced.currency!=="USD") return text("Invoice creation race requires manual review.",409);
      if (raced.external_payment_id || !["creating","created"].includes(raced.status)) return text("A payment is already in progress or requires review.",409);
      if (raced.hosted_url && raced.checkout_expires_at && Date.parse(raced.checkout_expires_at)>Date.now()) return Response.redirect(raced.hosted_url,303);
    }
  }
  else if (retryExpired) {
    const changed = await e.DB.prepare("UPDATE payments SET attempt=?,idempotency_key=?,checkout_id=NULL,hosted_url=NULL,checkout_expires_at=NULL,status='creating',updated_at=? WHERE invoice_id=? AND amount_minor=? AND currency='USD' AND checkout_id=? AND attempt=? AND status IN ('creating','created') AND external_payment_id IS NULL AND delivered_at IS NULL")
      .bind(Number(old.attempt || 1)+1,key,new Date().toISOString(),id,d.amount_minor,old.checkout_id,Number(old.attempt || 1)).run();
    if (!changed.meta?.changes) return text("The previous checkout changed; retry later.",409);
  }
  const c = await skinloop(e,"/v1/merchant-api/checkouts",{method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify({
    merchantOrderId:id, customerEmail, amount:{value:d.amount_minor,currency:"USD"}, allowedGames:["rust"],
    successUrl:`${url.origin}/return?invoice=${id}`, cancelUrl:`${url.origin}/cancel?invoice=${id}`,
    metadata:{source:"sellauth",invoiceId:id,game:"rust"}, expiresInSeconds:3600
  })});
  if (!c.r.ok) {
    const message = (c.body as { message?: unknown })?.message;
    if (c.r.status===400 && message==="redirect URL origin is not allowed")
      return text("Add this Worker origin to Skinloop checkout redirect origins.",502);
    if (c.r.status===400 && message==="customerEmail must be a valid email address")
      return text("SellAuth invoice buyer email was rejected by Skinloop.",502);
    if (c.r.status===401 || c.r.status===403)
      return text("Skinloop API key is invalid or lacks permission to create Rust checkouts.",502);
    return text("Skinloop could not create checkout. Check checkout settings and retry.",502);
  }
  const checkout = unwrap(c.body);
  let hosted = ""; try { const h = new URL(checkout.hostedUrl); const allowed = new URL(e.SKINLOOP_HOSTED_ORIGIN!); if (h.protocol==="https:" && h.origin===allowed.origin && !h.username && !h.password) hosted=h.toString(); } catch {}
  const expires=clean(checkout.expiresAt || checkout.expires_at);
  if (!hosted || !expires || Date.parse(expires)<=Date.now() || String(checkout.merchantOrderId)!==id || Number(checkout.amount?.value ?? checkout.amount)!==d.amount_minor || String(checkout.amount?.currency).toUpperCase()!=="USD" || JSON.stringify(checkout.allowedGames)!==JSON.stringify(["rust"])) return text("Skinloop returned an unverified checkout.",502);
  const saved = await e.DB.prepare("UPDATE payments SET checkout_id=?,hosted_url=?,checkout_expires_at=?,status='created',updated_at=? WHERE invoice_id=? AND idempotency_key=? AND status='creating' AND external_payment_id IS NULL").bind(clean(checkout.id,200),hosted,expires,new Date().toISOString(),id,key).run();
  if (!saved.meta?.changes) return text("Checkout state changed; retry later.",409);
  return Response.redirect(hosted,303);
}
async function webhook(req: Request, e: Env) {
  const raw = await req.arrayBuffer(); if (raw.byteLength > MAX_WEBHOOK_BYTES) return json({error:"payload_too_large"},413);
  const id=clean(req.headers.get("Skinloop-Event-Id")), ts=clean(req.headers.get("Skinloop-Timestamp")), sig=clean(req.headers.get("Skinloop-Signature"));
  if (!(await verify(raw,id,ts,sig,e.SKINLOOP_WEBHOOK_SECRET_CURRENT!) || await verify(raw,id,ts,sig,e.SKINLOOP_WEBHOOK_SECRET_PREVIOUS||""))) return json({error:"invalid_signature"},401);
  const digestBytes=await crypto.subtle.digest("SHA-256",raw);
  const bodyDigest=[...new Uint8Array(digestBytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
  const previous:any=await e.DB.prepare("SELECT event_id,body_digest FROM webhook_events WHERE event_id=?").bind(id).first();
  if (previous && previous.body_digest !== bodyDigest) return json({error:"event_identity_conflict"},409);
  let ev:any; try { ev=JSON.parse(new TextDecoder().decode(raw)); } catch { return json({error:"invalid_json"},400); }
  if (ev?.version!=="1" || ev.id!==id || !eventState(ev.type,ev.data?.status)) return json({error:"invalid_event"},400);
  const invoice=numericInvoice(ev.data?.merchantOrderId); const p:any=invoice && await e.DB.prepare("SELECT * FROM payments WHERE invoice_id=?").bind(invoice).first();
  if (!p || !exactBinding(ev.data,p)) return json({error:"payment_identity_conflict"},409);
  if (previous) {
    if (p.status==="completed" && Number(p.fulfillment_allowed)===1) await e.FULFILLMENT_QUEUE.send({invoiceId:invoice});
    return json({received:true,duplicate:true});
  }
  const status=clean(ev.data.status).toLowerCase(), allowed=status==="completed" && ev.data.fulfillmentAllowed===true;
  const recorded = await e.DB.batch([
    e.DB.prepare("INSERT INTO webhook_events(event_id,body_digest,event_type,invoice_id,received_at) VALUES(?,?,?,?,?)").bind(id,bodyDigest,ev.type,invoice,new Date().toISOString()),
    e.DB.prepare(`UPDATE payments SET external_payment_id=COALESCE(external_payment_id,?),status=CASE
       WHEN ?='reverted' AND delivery_state IN ('delivered','processing') THEN 'reconciliation_required'
      WHEN ?='reverted' THEN 'reverted'
      WHEN status IN ('reverted','reconciliation_required') THEN status
      WHEN status='completed' AND ?='pending' THEN status
      ELSE ? END,
      fulfillment_allowed=CASE WHEN ?='reverted' THEN 0 WHEN ?='completed' THEN ? ELSE fulfillment_allowed END,updated_at=?
       WHERE invoice_id=? AND (external_payment_id IS NULL OR external_payment_id=?)`).bind(clean(ev.data.externalPaymentId,256),status,status,status,status,status,status,allowed?1:0,new Date().toISOString(),invoice,clean(ev.data.externalPaymentId,256)),
    ...(allowed?[e.DB.prepare("INSERT OR IGNORE INTO outbox(invoice_id,created_at) SELECT invoice_id,? FROM payments WHERE invoice_id=? AND external_payment_id=? AND status='completed' AND fulfillment_allowed=1").bind(new Date().toISOString(),invoice,clean(ev.data.externalPaymentId,256))]:[])
  ]);
  if (!recorded[1]?.meta?.changes) return json({error:"payment_identity_conflict"},409);
  if (allowed) await e.FULFILLMENT_QUEUE.send({invoiceId:invoice});
  return json({received:true});
}
async function fulfill(invoice: string, e: Env) {
  const p:any=await e.DB.prepare("SELECT * FROM payments WHERE invoice_id=?").bind(invoice).first();
  if (!p || p.status!=="completed" || Number(p.fulfillment_allowed)!==1) throw new Error("Payment is not deliverable");
  if (p.delivered_at) return true;
  const owner=crypto.randomUUID(), now=new Date().toISOString();
  const lease=await e.DB.prepare("UPDATE payments SET delivery_state='processing',lease_owner=?,lease_until=?,updated_at=? WHERE invoice_id=? AND delivered_at IS NULL AND status='completed' AND fulfillment_allowed=1 AND (lease_until IS NULL OR lease_until<?)")
    .bind(owner,new Date(Date.now()+300000).toISOString(),now,invoice,now).run();
  if (!lease.meta?.changes) throw new Error("Delivery lease is active; retry later");
  const checkout=await skinloop(e,`/v1/merchant-api/checkouts/${encodeURIComponent(p.checkout_id)}/status`);
  const c=unwrap(checkout.body);
  if (!checkout.r.ok || String(c.merchantOrderId)!==invoice || Number(c.amount?.value ?? c.amount)!==Number(p.amount_minor) || String(c.amount?.currency).toUpperCase()!=="USD" || c.status!=="completed" || c.fulfillmentAllowed!==true) throw new Error("Skinloop recheck failed");
  const i=await sellauth(e,invoice); const d=i && invoiceDetails(i);
  const paid=i && paidInvoiceDetails(i);
  if (!d && (!paid || paid.amount_minor!==Number(p.amount_minor))) throw new Error("SellAuth invoice changed or is not unpaid");
  if (!d && paid) {
    const done=await e.DB.prepare("UPDATE payments SET delivered_at=?,delivery_state=CASE WHEN status='completed' AND fulfillment_allowed=1 THEN 'delivered' ELSE 'reconciliation_required' END,status=CASE WHEN status='completed' AND fulfillment_allowed=1 THEN status ELSE 'reconciliation_required' END,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE invoice_id=? AND lease_owner=? AND status IN ('completed','reverted','reconciliation_required') AND delivered_at IS NULL").bind(new Date().toISOString(),new Date().toISOString(),invoice,owner).run();
    if (!done.meta?.changes) throw new Error("Paid reconciliation lease lost");
    return true;
  }
  const guard=await e.DB.prepare("UPDATE payments SET updated_at=? WHERE invoice_id=? AND status='completed' AND fulfillment_allowed=1 AND delivery_state='processing' AND lease_owner=? AND delivered_at IS NULL")
    .bind(new Date().toISOString(),invoice,owner).run();
  if (!guard.meta?.changes) throw new Error("Payment reverted before SellAuth processing");
  const processed=await sellauth(e,invoice,true);
  if (!processed) throw new Error("SellAuth processing failed; queue must retry");
  const final=await sellauth(e,invoice); const confirmed=final && paidInvoiceDetails(final);
  if (!confirmed || confirmed.amount_minor!==Number(p.amount_minor)) throw new Error("SellAuth did not confirm full payment and processing");
  const done=await e.DB.prepare("UPDATE payments SET delivered_at=?,delivery_state=CASE WHEN status='completed' AND fulfillment_allowed=1 THEN 'delivered' ELSE 'reconciliation_required' END,status=CASE WHEN status='completed' AND fulfillment_allowed=1 THEN status ELSE 'reconciliation_required' END,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE invoice_id=? AND lease_owner=? AND status IN ('completed','reverted','reconciliation_required') AND delivered_at IS NULL").bind(new Date().toISOString(),new Date().toISOString(),invoice,owner).run();
  if (!done.meta?.changes) throw new Error("Delivery lease lost");
  return true;
}
const worker = {
  async fetch(req: Request,e: Env) {
    const u=new URL(req.url);
    try {
      if (req.method==="GET" && (u.pathname==="/" || u.pathname==="/status")) { configured(e,false); return json({ok:true,service:"SellAuth Skinloop Rust Bridge",setupRequired:!clean(e.SKINLOOP_WEBHOOK_SECRET_CURRENT),webhookEndpoint:`${u.origin}/webhook/skinloop`}); }
      configured(e);
      if (req.method==="GET" && u.pathname==="/pay") return pay(u,e);
      if (req.method==="POST" && u.pathname==="/webhook/skinloop") return webhook(req,e);
      if (req.method==="GET" && (u.pathname==="/return" || u.pathname==="/cancel")) return text("Payment confirmation is handled server-side. Do not start another payment.",200);
      return json({error:"Not found"},404);
    } catch (x) { return json({error:"Checkout unavailable",detail:clean(x instanceof Error?x.message:x,300)},500); }
  },
  async queue(batch: MessageBatch<any>,e: Env) {
    configured(e);
    for (const m of batch.messages) try { const id=numericInvoice(m.body?.invoiceId); if (!id) throw new Error("Invalid invoice"); await fulfill(id,e); m.ack(); } catch { m.retry(); }
  },
  async scheduled(_c: ScheduledController,e: Env) {
    configured(e);
    const rows=await e.DB.prepare("SELECT o.invoice_id FROM outbox o JOIN payments p ON p.invoice_id=o.invoice_id WHERE p.delivered_at IS NULL AND p.status='completed' AND p.fulfillment_allowed=1 AND (o.published_at IS NULL OR p.lease_until IS NULL OR p.lease_until<?) LIMIT 25").bind(new Date().toISOString()).all();
    for (const r of rows.results as any[]) try { await e.FULFILLMENT_QUEUE.send({invoiceId:r.invoice_id}); await e.DB.prepare("UPDATE outbox SET published_at=? WHERE invoice_id=?").bind(new Date().toISOString(),r.invoice_id).run(); } catch {}
  }
};
export default worker;