import { test } from "node:test";
import assert from "node:assert";
import { TILL_MAX_CENTS, epcPayload, formatIban, paymentReference, parseEuroCents, salesCsv, validIban } from "../lib/till/epc";

// The standard example IBAN from the ISO/ECBS documentation: valid checksum.
const IBAN = "DE89370400440532013000";

test("IBAN: checksum, country length, spaces and case", () => {
  assert.equal(validIban(IBAN), true);
  assert.equal(validIban("de89 3704 0044 0532 0130 00"), true, "as people type it");
  assert.equal(validIban("DE88370400440532013000"), false, "one digit off");
  assert.equal(validIban("DE8937040044053201300"), false, "a German IBAN is 22 characters");
  assert.equal(validIban("GB82WEST12345698765432"), true, "other countries on the checksum");
  assert.equal(validIban("hello"), false);
  assert.equal(formatIban(IBAN), "DE89 3704 0044 0532 0130 00");
});

test("amounts as a shop types them", () => {
  assert.equal(parseEuroCents("3,50"), 350);
  assert.equal(parseEuroCents("3.5"), 350);
  assert.equal(parseEuroCents("12"), 1200);
  assert.equal(parseEuroCents("€ 0,05"), 5);
  assert.equal(parseEuroCents("0"), null);
  assert.equal(parseEuroCents("1.234,56"), null, "no thousands separators");
  assert.equal(parseEuroCents("3,505"), null);
  assert.equal(parseEuroCents(String(TILL_MAX_CENTS / 100 + 1)), null, "over the limit");
});

test("EPC QR payload: the lines banking apps read, in order", () => {
  const p = epcPayload({ name: "Späti 63 GmbH", iban: "de89 3704 0044 0532 0130 00", cents: 1250, text: "Späti 63 · 18.11. Nr. 7" });
  assert.deepEqual(p.split("\n"), ["BCD", "002", "1", "SCT", "", "Späti 63 GmbH", IBAN, "EUR12.50", "", "", "Späti 63 · 18.11. Nr. 7"]);
  assert.ok(Buffer.byteLength(p, "utf8") <= 331, "the format's size limit");
  assert.match(epcPayload({ name: "A", iban: IBAN, cents: 5, text: "x" }), /\nEUR0\.05\n/);
});

test("EPC QR payload: refuses what a bank would reject", () => {
  assert.throws(() => epcPayload({ name: "", iban: IBAN, cents: 100, text: "x" }));
  assert.throws(() => epcPayload({ name: "Shop", iban: "DE00123", cents: 100, text: "x" }));
  assert.throws(() => epcPayload({ name: "Shop", iban: IBAN, cents: 0, text: "x" }));
  assert.throws(() => epcPayload({ name: "Shop", iban: IBAN, cents: 12.5, text: "x" }));
  const long = epcPayload({ name: "N".repeat(100), iban: IBAN, cents: 100, text: "T\n".repeat(200) });
  const lines = long.split("\n");
  assert.equal(lines.length, 11, "line breaks in the text don't add lines");
  assert.equal(lines[5].length, 70);
  assert.ok(lines[10].length <= 140);
});

test("reference and the day's CSV", () => {
  const at = new Date(2026, 10, 18, 9, 5);
  assert.equal(paymentReference("Späti 63", at, 7), "Späti 63 · 18.11. Nr. 7");
  const csv = salesCsv(
    [
      { n: 1, cents: 350, at: at.getTime(), reference: "Späti 63 · 18.11. Nr. 1", status: "paid" },
      { n: 2, cents: 1200, at: at.getTime(), reference: 'Say "hi"; ok', status: "cancelled" },
    ],
    { number: "Nr.", time: "Zeit", amount: "Betrag (EUR)", reference: "Verwendungszweck", status: "Status" },
    (s) => (s === "paid" ? "bezahlt" : "abgebrochen"),
  );
  assert.equal(
    csv,
    'Nr.;Zeit;Betrag (EUR);Verwendungszweck;Status\r\n1;2026-11-18 09:05;3,50;Späti 63 · 18.11. Nr. 1;bezahlt\r\n2;2026-11-18 09:05;12,00;"Say ""hi""; ok";abgebrochen\r\n',
  );
});
