import { test } from "node:test";
import assert from "node:assert";
import { mentionsAmount, plainText } from "../lib/assistant/plain";

/** Ai-chan's replies shown as plain text, and the check that a reply already named a flagged price. */

test("plain text: bold, headings and bullets lose their markers, the words stay", () => {
  assert.strictEqual(plainText("Take the **Boxed ThinkPad X1** for **140,00 EUR**."), "Take the Boxed ThinkPad X1 for 140,00 EUR.");
  assert.strictEqual(plainText("## Best pick\n- one\n* two"), "Best pick\none\ntwo");
  assert.strictEqual(plainText("**half a marker so far"), "**half a marker so far", "an unfinished marker waits for the rest of the stream");
  assert.strictEqual(plainText("2 * 3 = 6, and 5*2"), "2 * 3 = 6, and 5*2", "a lone asterisk inside a line is left alone");
});

test("amounts: the flagged price is recognised however the model writes it", () => {
  for (const said of ["for 26.00 EUR", "für 26,00 €", "the one at 26 EUR", "nur 26 Euro", "€26"]) assert.ok(mentionsAmount(said, "26.00 EUR"), said);
  assert.ok(mentionsAmount("für 1.249,00 €", "1249.00 EUR"));
  assert.ok(mentionsAmount("for 1,249.00 EUR", "1249.00 EUR"));
  assert.ok(mentionsAmount("at 12.5 EUR", "12.50 EUR"));
  for (const said of ["for 126.00 EUR", "260 EUR", "26.50 EUR", "nothing about it", "a seller with 26 positive ratings", "26.00 alone"]) assert.ok(!mentionsAmount(said, "26.00 EUR"), said);
});
