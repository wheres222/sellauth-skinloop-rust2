export const MAX_WEBHOOK_BYTES = 256_000;
export const numericInvoice = (v: unknown) => /^\d+$/.test(String(v ?? "").trim()) ? String(v).trim() : "";
export function minor(v: unknown): number {
  const s = String(v ?? "");
  if (!/^(?:0\.[0-9]{2}|[1-9]\d*(?:\.\d{2})?)$/.test(s)) throw new Error("Invalid amount");
  const [whole, cents = "00"] = s.split(".");
  const n = BigInt(whole) * 100n + BigInt(cents);
  if (n < 1n || n > 100_000_000n) throw new Error("Amount outside safe range");
  return Number(n);
}
export function eventState(type: string, status: string) {
  return (type === "payment.pending" && status === "pending") ||
    (type === "payment.completed" && status === "completed") ||
    (type === "payment.reverted" && status === "reverted");
}
export function exactBinding(data: any, p: any) {
  const amount = decimalMinor(data?.amount);
  if (data?.requiredAmount === undefined || data?.overpaymentAmount === undefined) return false;
  const required = decimalMinor(data.requiredAmount);
  const overpayment = decimalMinor(data.overpaymentAmount);
  return String(data?.externalPaymentId || "").length > 0 &&
    (!p.external_payment_id || String(data.externalPaymentId) === String(p.external_payment_id)) &&
    String(data?.merchantOrderId) === String(p.invoice_id) &&
    data?.game === "rust" && data?.currency === "USD" &&
    typeof data?.reservationRequired === "boolean" &&
    required === Number(p.amount_minor) && amount >= required && overpayment === amount - required;
}
export function decimalMinor(value: unknown) {
  const m = /^(?:0\.([0-9]{2})|([1-9][0-9]*)(?:\.([0-9]{2}))?)$/.exec(String(value ?? ""));
  if (!m) return Number.NaN;
  const n = BigInt(m[2] || "0") * 100n + BigInt(m[1] || m[3] || "00");
  return n <= 100_000_000n ? Number(n) : Number.NaN;
}
export async function verify(raw: ArrayBuffer, id: string, timestamp: string, signature: string, secret: string) {
  const m = /^v1=([0-9a-f]{64})$/.exec(signature);
  if (!m || !secret || !/^[A-Za-z0-9_-]{8,200}$/.test(id) || !/^\d{1,20}$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp) * 1000) > 300000) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`), msg = new Uint8Array(prefix.length + raw.byteLength);
  msg.set(prefix); msg.set(new Uint8Array(raw), prefix.length);
  const got = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const expected = Uint8Array.from(m[1].match(/../g)!, x => parseInt(x, 16));
  return got.length === expected.length && got.every((b, i) => b === expected[i]);
}