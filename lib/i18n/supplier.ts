/**
 * lib/i18n/supplier.ts — the supplier check's findings, in German.
 *
 * lib/suppliers/check.ts writes its findings as English sentences (the paid API
 * returns them as they are). As with the search's check reasons (checks.ts),
 * each sentence shape is matched and rewritten for the German page; one with
 * no rule stays English, never a guess. tests/i18n.test.ts runs them through.
 */

import { VIES_COUNTRIES, countryName } from "./countries";
import type { Lang } from "./lang";

/** An English country name from VIES_COUNTRIES, in German. */
const CODE_OF = Object.fromEntries(Object.entries(VIES_COUNTRIES).map(([code, name]) => [name, code]));
const land = (name: string) => countryName(CODE_OF[name], name, "de") ?? name;

/** "3 years", "5 months", "12 days" -> German. */
const dauer = (s: string) =>
  s
    .replace(/^(\d+) years$/, "$1 Jahren")
    .replace(/^(\d+) months$/, "$1 Monaten")
    .replace(/^1 day$/, "1 Tag")
    .replace(/^(\d+) days$/, "$1 Tagen");

const where = (s: string) => s.replace(/ on the demo marketplace$/, " auf dem Demo-Marktplatz").replace(/ on (eBay|Etsy|Amazon)$/, " auf $1");

type Rule = [RegExp, (...m: string[]) => string];

const RULES: Rule[] = [
  // --- headlines
  [/^Warning signs found\. Read these before ordering\.$/, () => "Warnsignale gefunden. Lies sie vor der Bestellung."],
  [/^Some details don't add up\. Check them with the supplier\.$/, () => "Einige Angaben passen nicht zusammen. Kläre sie mit dem Lieferanten."],
  [/^Verified business on SigPath, and nothing contradicts it\.$/, () => "Verifiziertes Unternehmen auf SigPath, und nichts spricht dagegen."],
  [/^No warning signs in the checks that ran\.$/, () => "Keine Warnsignale in den durchgeführten Prüfungen."],
  [/^Not enough could be checked to say anything\.$/, () => "Es konnte nicht genug geprüft werden, um etwas zu sagen."],

  // --- titles
  [/^Registered business$/, () => "Eingetragenes Unternehmen"],
  [/^VAT number not registered$/, () => "USt-IdNr. nicht registriert"],
  [/^VAT number not checked$/, () => "USt-IdNr. nicht geprüft"],
  [/^Name not checked$/, () => "Name nicht geprüft"],
  [/^Name matches the register$/, () => "Name stimmt mit dem Register überein"],
  [/^Name doesn't match the register$/, () => "Name stimmt nicht mit dem Register überein"],
  [/^Name not confirmed$/, () => "Name nicht bestätigt"],
  [/^Website domain doesn't exist$/, () => "Domain der Website existiert nicht"],
  [/^Very new website$/, () => "Sehr neue Website"],
  [/^Established website$/, () => "Etablierte Website"],
  [/^Website exists, age unknown$/, () => "Website existiert, Alter unbekannt"],
  [/^Website not checked$/, () => "Website nicht geprüft"],
  [/^Upheld fake-product reports$/, () => "Bestätigte Fälschungsmeldungen"],
  [/^Verified seller on SigPath$/, () => "Verifizierter Verkäufer auf SigPath"],
  [/^No SigPath record for this account$/, () => "Kein SigPath-Eintrag zu diesem Konto"],
  [/^Details belong to a different business$/, () => "Angaben gehören zu einem anderen Unternehmen"],
  [/^Verified business on SigPath$/, () => "Verifiziertes Unternehmen auf SigPath"],
  [/^SigPath business verification suspended$/, () => "SigPath-Unternehmensverifizierung ausgesetzt"],
  [/^Not a verified business on SigPath$/, () => "Kein verifiziertes Unternehmen auf SigPath"],

  // --- details
  [/^VAT number (\S+) is valid in the EU's VIES register \((.+)\)\.$/, (v, c) => `Die USt-IdNr. ${v} ist im VIES-Register der EU gültig (${land(c)}).`],
  [
    /^The EU's VIES register says (\S+) isn't a valid VAT number\. Ask the supplier to confirm it: a real EU business trading with other businesses has one\.$/,
    (v) => `Laut VIES-Register der EU ist ${v} keine gültige USt-IdNr. Lass sie dir vom Lieferanten bestätigen: Ein echtes EU-Unternehmen, das mit anderen Unternehmen handelt, hat eine.`,
  ],
  [/^The EU's VIES register isn't answering right now\. Try again in a few minutes\.$/, () => "Das VIES-Register der EU antwortet gerade nicht. Versuche es in ein paar Minuten erneut."],
  [/^A name can only be checked against the register together with a VAT number\.$/, () => "Ein Name lässt sich nur zusammen mit einer USt-IdNr. im Register prüfen."],
  [/^The register gives the name as (.+)\.$/, (n) => `Laut Register lautet der Name ${n}.`],
  [
    /^The register gives the name for this VAT number as (.+), not "(.+)"\. Someone may be using another company's VAT number\.$/,
    (reg, given) => `Laut Register lautet der Name zu dieser USt-IdNr. ${reg}, nicht „${given}“. Vielleicht nutzt jemand die USt-IdNr. einer anderen Firma.`,
  ],
  [
    /^(.+) doesn't publish business names through the register, so "(.+)" couldn't be compared\.$/,
    (c, n) => `${land(c)} veröffentlicht über das Register keine Firmennamen, daher konnte „${n}“ nicht verglichen werden.`,
  ],
  [
    /^(\S+) isn't registered \(checked with (.+)\)\. A supplier's website that doesn't exist is a serious warning sign\.$/,
    (d, r) => `${d} ist nicht registriert (geprüft bei ${r}). Eine Lieferanten-Website, die es nicht gibt, ist ein ernstes Warnsignal.`,
  ],
  [
    /^(\S+) was registered on (\S+), only (.+) ago\. Scam shops are typically weeks old\.$/,
    (d, on, a) => `${d} wurde am ${on} registriert, erst vor ${dauer(a)}. Betrugsshops sind meist nur wenige Wochen alt.`,
  ],
  [/^(\S+) was registered on (\S+), (.+) ago\.$/, (d, on, a) => `${d} wurde am ${on} registriert, vor ${dauer(a)}.`],
  [/^(\S+) is registered, but its registry \((.+)\) doesn't publish when\.$/, (d, r) => `${d} ist registriert, aber die Registry (${r}) veröffentlicht nicht, seit wann.`],
  [/^The registry directory couldn't be reached\.$/, () => "Das Verzeichnis der Registries war nicht erreichbar."],
  [/^The \.(\S+) registry doesn't offer public lookups\.$/, (t) => `Die .${t}-Registry bietet keine öffentlichen Abfragen an.`],
  [/^The registry answered (\d+)\.$/, (n) => `Die Registry antwortete mit ${n}.`],
  [/^The registry didn't answer in time\.$/, () => "Die Registry hat nicht rechtzeitig geantwortet."],
  [
    /^(\d+) verified buyer(?:'s|s') fake-product reports? (?:was|were) upheld against (.+) after review\.$/,
    (n, w) => `${n} ${n === "1" ? "Fälschungsmeldung eines verifizierten Käufers wurde" : "Fälschungsmeldungen verifizierter Käufer wurden"} nach Prüfung gegen ${where(w)} bestätigt.`,
  ],
  [/^(.+) proved control of the account and passed a live check\. No upheld reports\.$/, (w) => `${where(w)} hat die Kontrolle über das Konto nachgewiesen und eine Live-Prüfung bestanden. Keine bestätigten Meldungen.`],
  [/^(.+) isn't a verified seller, and has no upheld reports\.$/, (w) => `${where(w)} ist kein verifizierter Verkäufer und hat keine bestätigten Meldungen.`],
  [
    /^The (.+) you gave don't match the verified business these other details belong to\. Someone may be borrowing a real business's identity\.$/,
    (what) =>
      `Die angegebene${what.includes(" and ") ? "n" : ""} ${what
        .replace("VAT number", "USt-IdNr.")
        .replace("website", "Website")
        .replace("marketplace account", "Marktplatzkonto")
        .replace(/ and /g, " und ")} passen nicht zu dem verifizierten Unternehmen, zu dem die anderen Angaben gehören. Vielleicht gibt sich jemand als echtes Unternehmen aus.`,
  ],
  [
    /^That isn't a warning sign on its own: most businesses haven't verified with SigPath\.$/,
    () => "Für sich genommen ist das kein Warnsignal: Die meisten Unternehmen haben sich nicht bei SigPath verifiziert.",
  ],
  [
    /^A verified buyer's fake-product report against one of its accounts was upheld\.$/,
    () => "Eine Fälschungsmeldung eines verifizierten Käufers gegen eines seiner Konten wurde bestätigt.",
  ],
  [/^Pick the marketplace the account is on\.$/, () => "Wähle den Marktplatz, auf dem das Konto ist."],
  [
    /^That doesn't look like an EU VAT number\. Pick the country and enter the number\.$/,
    () => "Das sieht nicht nach einer EU-USt-IdNr. aus. Wähle das Land und gib die Nummer ein.",
  ],
  [/^Enter the website as a domain, like example-shop\.de\.$/, () => "Gib die Website als Domain ein, z. B. example-shop.de."],
  [/^Enter at least a VAT number, a website or a marketplace account\.$/, () => "Gib mindestens eine USt-IdNr., eine Website oder ein Marktplatzkonto ein."],
];

/** One supplier-check sentence, in `lang`. Unknown sentences come back unchanged. */
export function translateSupplier(text: string, lang: Lang): string {
  if (lang === "en") return text;
  for (const [re, f] of RULES) {
    const m = text.match(re);
    if (m) return f(...m.slice(1).map((x) => x ?? ""));
  }
  // The "verified business" summary line has too many parts for one pattern: its pieces, in order.
  const v = text.match(/^(.+): VAT checked (\S+)(, controls (\S+))?, (\d+) linked marketplace accounts?\.$/);
  if (v) {
    const who = v[1].replace(/^A business registered in (.+)$/, (_, c: string) => `Ein Unternehmen eingetragen in ${land(c)}`);
    return `${who}: USt-IdNr. geprüft am ${v[2]}${v[4] ? `, verwaltet ${v[4]}` : ""}, ${v[5]} ${v[5] === "1" ? "verknüpftes Marktplatzkonto" : "verknüpfte Marktplatzkonten"}.`;
  }
  return text;
}
