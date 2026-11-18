/**
 * lib/till/epc.ts — the shop till's bank QR code.
 *
 * HOW A PAYMENT WORKS
 * The shop types an amount; the till shows an EPC QR code (the "GiroCode" German
 * banking apps scan): pay this amount to this IBAN, with this reference. The
 * customer scans it in their own banking app and sends the transfer, as a SEPA
 * instant transfer where their bank offers it, so the money is in the shop's
 * account within seconds. Under the EU Instant Payments Regulation, banks may
 * not charge more for an instant transfer than for a normal one.
 *
 * NO ONE IN THE MIDDLE
 * The money goes straight from the customer's bank to the shop's. SigPath only
 * draws the code: it never receives, holds or passes on money, which is what a
 * payment service would need a licence for. The code is drawn in the browser
 * and the shop's details stay on the shop's own device.
 *
 * The format is the EPC's "Quick Response Code: Guidelines to Enable Data
 * Capture for the Initiation of a SEPA Credit Transfer" (EPC069-12), version
 * 002, which needs no BIC inside the EEA. Pure functions, used by the page and
 * the tests alike.
 */

/** The most one till payment may ask for, in euro cents: a counter, not a car dealer. */
export const TILL_MAX_CENTS = 100_000;

/** An IBAN without spaces, in capitals. */
export function normaliseIban(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

/** Lengths by country, for the countries a Berlin shop is likely to bank in; others pass on the checksum alone. */
const IBAN_LENGTH: Record<string, number> = {
  DE: 22, AT: 20, NL: 18, BE: 16, FR: 27, IT: 27, ES: 24, LU: 20, IE: 22, LT: 20, EE: 20, FI: 18, PL: 28, CH: 21, DK: 18, SE: 24,
};

/** Whether this is an IBAN: country, check digits, account part, the length its country uses, and mod 97 = 1 (ISO 13616). */
export function validIban(input: string): boolean {
  const iban = normaliseIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const len = IBAN_LENGTH[iban.slice(0, 2)];
  if (len && iban.length !== len) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/** An IBAN in groups of four, as people read it: "DE89 3704 0044 0532 0130 00". */
export function formatIban(input: string): string {
  return normaliseIban(input).replace(/(.{4})/g, "$1 ").trim();
}

/**
 * An amount as a shop types it — "3,50", "3.50", "3", "€ 12,90" — in euro cents;
 * null when it isn't one, is zero, or is over the till's limit.
 */
export function parseEuroCents(input: string): number | null {
  const s = input.replace(/€|eur/gi, "").replace(/\s+/g, "");
  const m = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return cents > 0 && cents <= TILL_MAX_CENTS ? cents : null;
}

/** The account holder's name as the code may carry it: one line, at most 70 characters. */
export function cleanName(input: string): string {
  return input.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
}

/**
 * The text inside the QR code. Lines, in order: service tag, version, character
 * set (1 = UTF-8), identification, BIC (empty: not needed in the EEA from
 * version 002), name, IBAN, amount ("EUR12.5"), purpose code (empty), structured
 * reference (empty), the reference text the shop will see on its statement.
 */
export function epcPayload(args: { name: string; iban: string; cents: number; text: string }): string {
  const name = cleanName(args.name);
  const iban = normaliseIban(args.iban);
  if (!name) throw new Error("The account holder's name is missing.");
  if (!validIban(iban)) throw new Error("That isn't a valid IBAN.");
  if (!Number.isInteger(args.cents) || args.cents <= 0 || args.cents > TILL_MAX_CENTS) throw new Error("That amount can't be asked for here.");
  const amount = `EUR${Math.floor(args.cents / 100)}.${String(args.cents % 100).padStart(2, "0")}`;
  const text = args.text.replace(/[\r\n\t]+/g, " ").trim().slice(0, 140);
  return ["BCD", "002", "1", "SCT", "", name, iban, amount, "", "", text].join("\n");
}

/** The reference a payment carries, so the shop finds it on its statement: "Spaeti 63 · 18.11. Nr. 7". */
export function paymentReference(shop: string, at: Date, number: number): string {
  const day = `${String(at.getDate()).padStart(2, "0")}.${String(at.getMonth() + 1).padStart(2, "0")}.`;
  return `${cleanName(shop).slice(0, 80)} · ${day} Nr. ${number}`.trim();
}

/** One line of the day's list as the till keeps it on the device. */
export interface TillSale {
  /** Its number that day, from 1. */
  n: number;
  cents: number;
  /** Unix ms. */
  at: number;
  reference: string;
  status: "paid" | "cancelled";
}

/** The day's sales as CSV for the shop's records (semicolons and decimal commas, as German spreadsheets expect). */
export function salesCsv(sales: TillSale[], header: { number: string; time: string; amount: string; reference: string; status: string }, statusWord: (s: TillSale["status"]) => string): string {
  const cell = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = sales.map((s) => {
    const d = new Date(s.at);
    const time = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const amount = `${Math.floor(s.cents / 100)},${String(s.cents % 100).padStart(2, "0")}`;
    return [String(s.n), time, amount, cell(s.reference), statusWord(s.status)].join(";");
  });
  return [[header.number, header.time, header.amount, header.reference, header.status].join(";"), ...rows].join("\r\n") + "\r\n";
}
