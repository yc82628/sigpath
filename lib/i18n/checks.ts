/**
 * lib/i18n/checks.ts — the check reasons, in German.
 *
 * The checks (anomaly.ts, identity.ts, label.ts, eligibility.ts, the cart)
 * write their reasons as English sentences with numbers and names in them.
 * Rather than rebuild that engine around message codes, each sentence shape
 * is matched here and rewritten in German. A sentence with no rule stays in
 * English: never a guess. tests/i18n.test.ts runs every shape through, so a
 * new or reworded reason that loses its German shows up there.
 */

import type { Lang } from "./lang";
import { germanMoneyInText } from "./money";

/** "on eBay", "on the demo feed", "on eBay and Amazon" -> "auf eBay", "im Demo-Feed", ... */
function where(s: string): string {
  const t = s.replace(/^(on|across) /, "");
  if (t === "the demo feed") return "im Demo-Feed";
  if (t === "the partner feed") return "im Partner-Feed";
  if (t === "this marketplace") return "auf diesem Marktplatz";
  const m = t.match(/^(\d+) marketplaces$/);
  if (m) return `auf ${m[1]} Marktplätzen`;
  return `auf ${t.replace(/ and /g, " und ")}`;
}

/** "the same product" / "the same model and configuration (Carbon, Gen 11, 512 GB storage)" */
function what(s: string): string {
  if (s === "the same product") return "desselben Produkts";
  const m = s.match(/^the same model and configuration \((.+)\)$/);
  return m ? `desselben Modells und derselben Ausstattung (${specs(m[1])})` : s;
}

const specs = (s: string) => s.replace(/ storage/g, " Speicher").replace(/\bGen (\d+)/g, "Gen. $1");

const age = (n: string, unit: string) => {
  const one = n === "1";
  if (unit.startsWith("day")) return `${n} ${one ? "Tag" : "Tage"}`;
  if (unit.startsWith("month")) return `${n} ${one ? "Monat" : "Monate"}`;
  return `${n} ${one ? "Jahr" : "Jahre"}`;
};

const market = (s: string) => (s === "the demo feed" ? "der Demo-Feed" : s === "the partner feed" ? "der Partner-Feed" : s);
const condition = (s: string) => (s === "used" ? "gebrauchte" : s === "new" ? "neue" : s);

type Rule = [RegExp, (...m: string[]) => string];

const RULES: Rule[] = [
  // --- photo instructions (lib/challenge/generate.ts)
  [
    /^Write (\S+) on a piece of paper, place it next to the item you received, and photograph both\.$/,
    (c) => `Schreib ${c} auf ein Blatt Papier, leg es neben den erhaltenen Artikel und fotografiere beides.`,
  ],
  [/^Write (\S+) on a piece of paper and hold it next to your face\.$/, (c) => `Schreib ${c} auf ein Blatt Papier und halte es neben dein Gesicht.`],
  [
    /^Write (\S+) on a piece of paper and hold it next to your face, and hold up (\d) fingers with your other hand\.$/,
    (c, n) => `Schreib ${c} auf ein Blatt Papier, halte es neben dein Gesicht und zeig mit der anderen Hand ${n} Finger.`,
  ],
  [/^Write (\S+) on a piece of paper and hold it next to the item\.$/, (c) => `Schreib ${c} auf ein Blatt Papier und halte es neben den Artikel.`],
  [
    /^Write (\S+) on paper, place it beside the item, and photograph both from about (\d+)°\.$/,
    (c, deg) => `Schreib ${c} auf Papier, leg es neben den Artikel und fotografiere beides aus etwa ${deg}°.`,
  ],
  [
    /^Place the item next to something (blue|red|green|yellow|black|white) and photograph them together\.$/,
    (c) =>
      `Leg den Artikel neben etwas ${({ blue: "Blaues", red: "Rotes", green: "Grünes", yellow: "Gelbes", black: "Schwarzes", white: "Weißes" } as Record<string, string>)[c]} und fotografiere beides zusammen.`,
  ],

  // --- headlines and short labels
  [/^SigPath-checked$/, () => "Von SigPath geprüft"],
  [/^Look closer$/, () => "Genauer hinsehen"],
  [/^Not price-checked$/, () => "Preis nicht geprüft"],

  // --- price comparison (label.ts, anomaly.ts)
  [
    /^Price in line with the market: compared with (\d+) (used )?listings of (.+?) ((?:on|across) .+)\.$/,
    (n, used, w, on) => `Preis im Marktrahmen: verglichen mit ${n} ${used ? "gebrauchten " : ""}Angeboten ${what(w)} ${where(on)}.`,
  ],
  [
    /^Priced above most of the (\d+) (used )?listings of (.+?) ((?:on|across) .+) \(median (.+)\)\. You may find it cheaper\.$/,
    (n, used, w, on, median) => `Teurer als die meisten der ${n} ${used ? "gebrauchten " : ""}Angebote ${what(w)} ${where(on)} (Median ${median}). Vielleicht findest du es günstiger.`,
  ],
  [/^Price in line with comparable listings\.$/, () => "Preis im Rahmen vergleichbarer Angebote."],
  [
    /^Priced well below the median of (\d+) comparable (used )?listings ((?:on|across) .+)\.$/,
    (n, used, on) => `Deutlich unter dem Median von ${n} vergleichbaren ${used ? "gebrauchten " : ""}Angeboten ${where(on)}.`,
  ],
  [
    /^The seller has no ratings yet, and the price is (\d+)% below the median of (\d+) comparable (used )?listings ((?:on|across) .+)\.$/,
    (pct, n, used, on) =>
      `Der Verkäufer hat noch keine Bewertungen, und der Preis liegt ${pct} % unter dem Median von ${n} vergleichbaren ${used ? "gebrauchten " : ""}Angeboten ${where(on)}.`,
  ],
  [
    /^Its title doesn't state model details like generation or storage, so it was compared with every version\.$/,
    () => "Der Titel nennt keine Modelldetails wie Generation oder Speicher, daher wurde mit allen Versionen verglichen.",
  ],
  [
    /^Only (\d+) (used )?listings? of the same model and configuration, so its price isn't compared\.$/,
    (n, used) => `Nur ${n} ${used ? "gebrauchte " : ""}${n === "1" ? "Angebot" : "Angebote"} desselben Modells und derselben Ausstattung, daher wird der Preis nicht verglichen.`,
  ],
  [
    /^Only (\d+) new and (\d+) used comparable listing\(s\); at least (\d+) of one condition are needed before a price is worth comparing\.$/,
    (a, b, k) => `Nur ${a} neue und ${b} gebrauchte vergleichbare Angebote; mindestens ${k} in einem Zustand sind nötig, bevor sich ein Preisvergleich lohnt.`,
  ],
  [
    /^Price comparison is unavailable: (.+) did not respond, so any median would be taken over a biased sample\.$/,
    (s) => `Kein Preisvergleich möglich: ${s} hat nicht geantwortet, ein Median wäre daher verzerrt.`,
  ],
  [
    /^Its title doesn't name the (.+), so it isn't compared with listings that do\.$/,
    (n) => `Der Titel nennt „${n}“ nicht, daher wird es nicht mit Angeboten verglichen, die das tun.`,
  ],
  [
    /^Listed under "(.+)", not "(.+)" like most results, so its price isn't compared\.$/,
    (a, b) => `Unter „${a}“ gelistet, nicht unter „${b}“ wie die meisten Ergebnisse, daher wird der Preis nicht verglichen.`,
  ],
  [/^There weren't enough (new|used) listings to compare its price with\.$/, (c) => `Es gab nicht genug ${condition(c)} Angebote, um den Preis zu vergleichen.`],
  [/^Prices can't be compared while a marketplace isn't responding\.$/, () => "Preise können nicht verglichen werden, solange ein Marktplatz nicht antwortet."],
  [/^Its condition isn't stated, so its price can't be compared\.$/, () => "Der Zustand ist nicht angegeben, daher kann der Preis nicht verglichen werden."],
  [/^It's priced in ([A-Z]{3}), so it can't be compared with the rest\.$/, (c) => `Es ist in ${c} bepreist und kann daher nicht mit den anderen verglichen werden.`],
  [
    /^AliExpress prices aren't compared with eBay's: they're a different price level, shipped from abroad\.$/,
    () => "AliExpress-Preise werden nicht mit eBay verglichen: anderes Preisniveau, Versand aus dem Ausland.",
  ],
  [/^Prices from this marketplace aren't compared with retail\.$/, () => "Preise dieses Marktplatzes werden nicht mit dem Handel verglichen."],

  // --- what the listing is (identity.ts)
  [/^The listing says "(.+)", so it isn't compared with working ones\.$/, (p) => `Im Angebot steht „${p}“, daher wird es nicht mit funktionierenden verglichen.`],
  [
    /^The listing says "(.+)": only part of the product, so it isn't compared with complete ones\.$/,
    (p) => `Im Angebot steht „${p}“: nur ein Teil des Produkts, daher wird es nicht mit vollständigen verglichen.`,
  ],
  [
    /^It looks like a service \("(.+)"\), not a (.+), so it isn't compared with one\.$/,
    (s, q) => `Es sieht nach einer Dienstleistung aus („${s}“), nicht nach ${q}, daher wird es nicht damit verglichen.`,
  ],
  [
    /^It looks like an accessory \((.+)\), not the (.+) itself, so it isn't compared with it\.$/,
    (a, q) => `Es sieht nach Zubehör aus (${a}), nicht nach ${q} selbst, daher wird es nicht damit verglichen.`,
  ],
  [/^It's sold for use with a (.+), not as one, so it isn't compared with it\.$/, (q) => `Es wird zur Verwendung mit ${q} verkauft, nicht als solches, daher wird es nicht damit verglichen.`],

  // --- photo, seller, reports (label.ts, anomaly.ts, ebay.ts)
  [/^Its photo isn't used by another seller on the same marketplace\.$/, () => "Das Foto wird von keinem anderen Verkäufer auf demselben Marktplatz verwendet."],
  [/^This photo appears on (\d+) different seller accounts on the same marketplace\.$/, (n) => `Dieses Foto erscheint bei ${n} verschiedenen Verkäuferkonten auf demselben Marktplatz.`],
  [/^Photo not checked: there was no photo to compare\.$/, () => "Foto nicht geprüft: Es gab kein Foto zum Vergleichen."],
  [/^Photo not checked: the listing has no photo\.$/, () => "Foto nicht geprüft: Das Angebot hat kein Foto."],
  [/^Photo not checked: new items often show the maker's own photo\.$/, () => "Foto nicht geprüft: Neuware zeigt oft das Foto des Herstellers."],
  [/^Photo not checked: the item's condition isn't stated\.$/, () => "Foto nicht geprüft: Der Zustand ist nicht angegeben."],
  [/^Photo not checked: it's eBay's stock photo for this product\.$/, () => "Foto nicht geprüft: Es ist eBays Standardfoto für dieses Produkt."],
  [/^Photo not checked: the photo couldn't be loaded\.$/, () => "Foto nicht geprüft: Das Foto konnte nicht geladen werden."],
  [
    /^Photo not checked: it's a product picture on a white background, not a photo of the item itself\.$/,
    () => "Foto nicht geprüft: Es ist ein Produktbild auf weißem Grund, kein Foto des Artikels selbst.",
  ],
  [/^Seller account is (\d+) (days?|months?|years?) old\.$/, (n, u) => `Das Verkäuferkonto ist ${age(n, u)} alt.`],
  [
    /^Seller has (\d+) ratings(?: \((\d+(?:\.\d+)?)% positive\))? on (.+); account age isn't published, so it wasn't checked\.$/,
    (n, pct, m) => `Der Verkäufer hat ${n} Bewertungen${pct ? ` (${pct} % positiv)` : ""} auf ${market(m)}; das Kontoalter ist nicht veröffentlicht und wurde daher nicht geprüft.`,
  ],
  [/^Seller history not checked: (.+) doesn't publish it\.$/, (m) => `Verkäuferhistorie nicht geprüft: ${market(m)} veröffentlicht sie nicht.`],
  [/^No upheld fake-product reports against this seller\.$/, () => "Keine bestätigten Fälschungsmeldungen gegen diesen Verkäufer."],
  [/^Buyer reports weren't checked for this search\.$/, () => "Käufermeldungen wurden bei dieser Suche nicht geprüft."],
  [/^A verified buyer's fake-product report against this seller was upheld after review\.$/, () => "Die Fälschungsmeldung eines verifizierten Käufers gegen diesen Verkäufer wurde nach Prüfung bestätigt."],
  [/^(\d+) verified buyers' fake-product reports against this seller were upheld after review\.$/, (n) => `${n} Fälschungsmeldungen verifizierter Käufer gegen diesen Verkäufer wurden nach Prüfung bestätigt.`],
  [
    /^Verified seller: proved control of this account and passed a live check\. That vouches for the account, not this price\.$/,
    () => "Verifizierter Verkäufer: hat die Kontrolle über das Konto nachgewiesen und eine Live-Prüfung bestanden. Das bürgt für das Konto, nicht für diesen Preis.",
  ],
  [
    /^Verified business: registered as (.+) in ([A-Z]{2})(?:, owns (.+))?\. That vouches for who runs the account, not this price\.$/,
    (n, c, d) => `Verifiziertes Unternehmen: eingetragen als ${n} in ${c}${d ? `, betreibt ${d}` : ""}. Das bürgt dafür, wer das Konto führt, nicht für diesen Preis.`,
  ],
  [
    /^Verified business: VAT number registered in ([A-Z]{2}) \(the register doesn't publish the name\)(?:, owns (.+))?\. That vouches for who runs the account, not this price\.$/,
    (c, d) => `Verifiziertes Unternehmen: USt-IdNr. in ${c} eingetragen (das Register veröffentlicht keinen Namen)${d ? `, betreibt ${d}` : ""}. Das bürgt dafür, wer das Konto führt, nicht für diesen Preis.`,
  ],

  // --- checkout (eligibility.ts, requote.ts)
  [/^SigPath only buys what it could price-check\. (.+)$/, (r) => `SigPath kauft nur, was es preislich prüfen konnte. ${translateCheck(r, "de")}`],
  [/^SigPath won't buy a listing its own checks flagged — see the notes above\.$/, () => "SigPath kauft kein Angebot, das seine eigenen Prüfungen markiert haben: siehe Hinweise oben."],
  [/^Shipping cost isn't published, so the total can't be quoted\.$/, () => "Versandkosten sind nicht angegeben, daher kann kein Gesamtpreis genannt werden."],
  [/^Priced in ([A-Z]{3}); USDC checkout supports EUR and USD\.$/, (c) => `In ${c} bepreist; die USDC-Kasse unterstützt EUR und USD.`],
  [/^Shipping is priced in a different currency, so the total is unknown\.$/, () => "Der Versand ist in einer anderen Währung bepreist, daher ist der Gesamtpreis unbekannt."],
  [/^AliExpress items are bought on AliExpress, through its own checkout\.$/, () => "AliExpress-Artikel werden auf AliExpress gekauft, über die eigene Kasse."],
  [/^It isn't in today's search results, so it couldn't be checked again\.$/, () => "Es ist nicht in den heutigen Suchergebnissen und konnte daher nicht erneut geprüft werden."],
  [/^Not SigPath-checked today: (.+)\.$/, (h) => `Heute nicht von SigPath geprüft: ${translateCheck(h, "de")}.`],
  [/^This item can't be searched again\.$/, () => "Dieser Artikel kann nicht erneut gesucht werden."],
  [/^USDC checkout isn't set up here\.$/, () => "Die USDC-Kasse ist hier nicht eingerichtet."],
  [/^SigPath's USDC checkout doesn't cover this marketplace\.$/, () => "SigPaths USDC-Kasse deckt diesen Marktplatz nicht ab."],

  // --- the cart's price refresh (refresh.ts)
  [/^A demo listing: there is no live price\.$/, () => "Ein Demo-Angebot: Es gibt keinen Live-Preis."],
  [/^SigPath can't check this marketplace's price live yet\.$/, () => "SigPath kann den Preis auf diesem Marktplatz noch nicht live prüfen."],
  [/^Too many price checks just now\. Try again in a few minutes\.$/, () => "Gerade zu viele Preisprüfungen. Versuche es in ein paar Minuten erneut."],
  [/^eBay isn't connected here\.$/, () => "eBay ist hier nicht verbunden."],
  [/^eBay didn't answer just now\.$/, () => "eBay hat gerade nicht geantwortet."],

  // --- savings (label.ts describeSaving)
  [/^(.+) below the typical (new|used) price$/, (amount, g) => `${amount} unter dem typischen ${g === "used" ? "Gebrauchtpreis" : "Neupreis"}`],
];

/** "on eBay" / "on the demo feed", in `lang`: the scope a median was taken over. */
export function translateWhere(s: string, lang: Lang): string {
  return lang === "en" ? s : where(s);
}

/** One English check sentence, in `lang`. Unknown sentences come back unchanged. */
export function translateCheck(text: string, lang: Lang): string {
  if (lang === "en") return text;
  for (const [re, f] of RULES) {
    const m = text.match(re);
    // Prices inside the sentence, the German way too: "125.19 EUR" -> "125,19 €".
    if (m) return germanMoneyInText(f(...m.slice(1).map((x) => x ?? "")));
  }
  return text;
}

/** For tests: does any rule match? */
export function hasGerman(text: string): boolean {
  return RULES.some(([re]) => re.test(text));
}
