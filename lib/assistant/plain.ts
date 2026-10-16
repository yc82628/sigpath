/**
 * lib/assistant/plain.ts — Ai-chan's words as plain text.
 *
 * The prompt asks for plain text, and most models comply; some (the Groq
 * backup, for one) still bold names with **…**, which the chat would show as
 * asterisks. Applied when the reply is shown, to the whole text so far, so a
 * marker split across two streamed pieces is still caught.
 */

export function plainText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "");
}

/** A price as models write it: 26, 26.00, 26,00, 1.249,00, 1,249.00, 1 249,00. */
const NUM = String.raw`\d{1,3}(?:[.,  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const CUR = String.raw`€|\$|EUR\b|Euro\b|USD\b`;
/** A number counts only with a currency beside it, before or after. */
const PRICE = new RegExp(String.raw`(?:${CUR})\s?(${NUM})|(${NUM})\s?(?:${CUR})`, "gi");

/**
 * Whether `text` names the amount of `total` ("26.00 EUR"), however a model
 * writes it: 26.00 EUR, 26,00 €, €26, 26 Euro. Used to tell if a reply already
 * warned about a flagged listing. A bare number doesn't count: "26 positive
 * ratings" must not stand in for the price, or a real warning would be dropped.
 */
export function mentionsAmount(text: string, total: string): boolean {
  const want = Number(total.split(" ")[0]);
  if (!Number.isFinite(want)) return false;
  for (const m of text.matchAll(PRICE)) {
    const raw = (m[1] ?? m[2]).replace(/[  ]/g, "");
    // "1.249,00" or "1,249.00": the last separator before 1–2 digits is the decimal one.
    const dec = raw.match(/[.,](\d{1,2})$/);
    const whole = (dec ? raw.slice(0, -dec[0].length) : raw).replace(/[.,]/g, "");
    const n = Number(dec ? `${whole}.${dec[1]}` : whole);
    if (Math.abs(n - want) < 0.005) return true;
  }
  return false;
}
