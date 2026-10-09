import { test } from "node:test";
import assert from "node:assert";
import { amazonTag, assistantProvider, hasPriceAlerts, operator, photoCheckProvider, providerFor, solanaRpcProvider } from "../lib/legal/site";

test("the Impressum shows the operator only once name, address and email are all set", () => {
  assert.equal(operator({}), null);
  assert.equal(operator({ IMPRESSUM_NAME: "Jane Doe", IMPRESSUM_EMAIL: "a@b.de" }), null, "no address");
  assert.equal(operator({ IMPRESSUM_NAME: "Jane Doe", IMPRESSUM_ADDRESS: "c/o Service|Str. 1", IMPRESSUM_EMAIL: "not-an-email" }), null);
  const op = operator({ IMPRESSUM_NAME: '"Jane Doe"', IMPRESSUM_ADDRESS: "c/o Impressum Service | Musterstr. 1 | 10115 Berlin", IMPRESSUM_EMAIL: "hello@sigpath.example" });
  assert.deepEqual(op?.address, ["c/o Impressum Service", "Musterstr. 1", "10115 Berlin"]);
  assert.equal(op?.name, "Jane Doe", "pasted quotes are stripped");
});

test("the privacy page names each provider from the setting the feature reads", () => {
  assert.equal(
    assistantProvider({ ASSISTANT_PROVIDER: "openai", ASSISTANT_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/", ASSISTANT_MODEL: "gemini-3.5-flash" }),
    "Google (Gemini API), USA",
  );
  assert.equal(assistantProvider({}), null, "Ai-chan off: not listed");
  assert.equal(photoCheckProvider({}), null, "no key: photos go nowhere");
  assert.equal(photoCheckProvider({ VISION_BACKEND: "remote", VISION_API_BASE: "https://openrouter.ai/api/v1", VISION_API_KEY: "k", VISION_MODEL: "m" }), "OpenRouter, Inc., USA");
  assert.equal(photoCheckProvider({ VISION_BACKEND: "ollama" }), "SigPath's own server");
  assert.equal(providerFor("https://vision.example.org/v1"), "vision.example.org", "an unknown host is named as it is");
  assert.equal(hasPriceAlerts({ VAPID_PUBLIC_KEY: "a" }), false);
  assert.equal(solanaRpcProvider({}), "the Solana Foundation's public RPC service");
});

test("the Amazon disclosure appears only with a well-formed tag", () => {
  assert.equal(amazonTag({}), null);
  assert.equal(amazonTag({ AMAZON_PARTNER_TAG: "sigpath-21" }), "sigpath-21");
  assert.equal(amazonTag({ AMAZON_PARTNER_TAG: "bad tag&x" }), null);
});
