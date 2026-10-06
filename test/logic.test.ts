import test from "node:test";
import assert from "node:assert/strict";
import { numericInvoice, minor, eventState, exactBinding, verify } from "../src/logic";

test("only numeric invoice IDs are accepted", () => {
  assert.equal(numericInvoice("123"), "123");
  assert.equal(numericInvoice("unique_123"), "");
  assert.equal(numericInvoice(""), "");
});
test("amount parser is fixed two-decimal USD minor units", () => {
  assert.equal(minor("12.34"), 1234);
  assert.throws(() => minor("12.3"));
  assert.throws(() => minor("0.00"));
});
test("event states are strict", () => {
  assert.equal(eventState("payment.pending","pending"), true);
  assert.equal(eventState("payment.completed","pending"), false);
  assert.equal(eventState("payment.reverted","reverted"), true);
});
test("payment and invoice identity are bound exactly", () => {
  const p={invoice_id:"123",checkout_id:"co_1",amount_minor:1234};
  const data={externalPaymentId:"pay_1",merchantOrderId:"123",currency:"USD",amount:"12.34",requiredAmount:"12.34",overpaymentAmount:"0.00",game:"rust",reservationRequired:false};
  assert.equal(exactBinding(data,p),true);
  assert.equal(exactBinding({...data,amount:"12.35",overpaymentAmount:"0.00"},p),false);
  assert.equal(exactBinding({...data,merchantOrderId:"124"},p),false);
  assert.equal(exactBinding({...data,amount:"13.34",overpaymentAmount:"1.00"},p),true);
});
test("pending cannot be treated as completed or reversed", () => {
  assert.equal(eventState("payment.pending","completed"), false);
  assert.equal(eventState("payment.reverted","pending"), false);
});
test("unsigned, stale and malformed signatures fail", async () => {
  const body=new TextEncoder().encode("{}").buffer;
  assert.equal(await verify(body,"event_123",String(Math.floor(Date.now()/1000)),"","secret"),false);
  assert.equal(await verify(body,"event_123",String(Math.floor(Date.now()/1000)-301),"v1="+"0".repeat(64),"secret"),false);
});