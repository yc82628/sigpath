import { test } from "node:test";
import assert from "node:assert";
import { countedUrl, visitCounterOn } from "../lib/visits";

const SITE = "https://sigpath.vercel.app";

test("the visit counter never sees search words, quotes or anything after ? or #", () => {
  assert.equal(countedUrl(`${SITE}/search?q=AirPods%20Pro&checked=1`), `${SITE}/search`);
  assert.equal(countedUrl(`${SITE}/checkout?quote=eyJhbGciOi`), `${SITE}/checkout`);
  assert.equal(countedUrl(`${SITE}/?utm_source=x#top`), `${SITE}/`);
});

test("order numbers, seller handles and business ids become the page type", () => {
  assert.equal(countedUrl(`${SITE}/order/5xKq9`), `${SITE}/order/[order]`);
  assert.equal(countedUrl(`${SITE}/report/5xKq9?pending=1`), `${SITE}/report/[order]`);
  assert.equal(countedUrl(`${SITE}/business/abc123`), `${SITE}/business/[id]`);
  assert.equal(countedUrl(`${SITE}/seller/ebay/some_handle`), `${SITE}/seller/[source]/[handle]`);
  // The fixed seller pages keep their names.
  assert.equal(countedUrl(`${SITE}/seller/verify`), `${SITE}/seller/verify`);
  assert.equal(countedUrl(`${SITE}/seller/business`), `${SITE}/seller/business`);
  assert.equal(countedUrl("not a url"), null, "an unreadable address is dropped, not sent");
});

test("the counter (and its privacy section) is on only on Vercel", () => {
  assert.equal(visitCounterOn({}), false);
  assert.equal(visitCounterOn({ VERCEL: "1" }), true);
});
