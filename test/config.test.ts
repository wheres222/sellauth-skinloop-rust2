import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("fixed service URLs are preconfigured, not merchant setup inputs", () => {
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const bindings = pkg.cloudflare.bindings as Record<string, unknown>;

  for (const [name, url] of Object.entries({
    SKINLOOP_API_BASE_URL: "https://api.skinloop.io",
    SKINLOOP_HOSTED_ORIGIN: "https://checkout.skinloop.io",
    SELLAUTH_API_BASE_URL: "https://api.sellauth.com/v1",
  })) {
    assert.ok(wrangler.includes(`${name} = "${url}"`), `${name} must have a fixed URL`);
    assert.equal(name in bindings, false, `${name} must not be a merchant prompt`);
  }

  for (const name of ["SKINLOOP_API_KEY", "SELLAUTH_API_KEY", "SELLAUTH_SHOP_ID"]) {
    assert.ok(name in bindings, `${name} must remain a merchant input`);
  }
});