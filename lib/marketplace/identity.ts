/**
 * lib/marketplace/identity.ts — what a listing actually is, read from its title.
 *
 * WHY THIS EXISTS
 * A search for "ThinkPad X1" returns X1 Carbons and X1 Yogas, 8 GB and 32 GB
 * machines, Gen 6 and Gen 11, and the odd charger. Pricing all of them
 * against one median produces both failures that matter: an old 8 GB unit
 * priced like a new 32 GB one reads as "in line with the market" (false
 * reassurance), and a 20-euro charger reads as a scam (a false alarm). So a
 * listing is only ever compared with listings of the same thing.
 *
 * WHAT IT READS
 *   kind        product, accessory ("charger for …", "case", "box only") or
 *               parts (for parts, broken, not working, locked)
 *   variant     model words right after the searched name ("X1 Carbon",
 *               "15 Pro Max"); unknown when the title does not contain the name
 *   generation  "Gen 11", "2nd gen"
 *   storage     TB, or GB marked SSD/storage, or a GB figure of 64 and up
 *   ram         GB marked RAM/memory, or the smaller of two unmarked figures
 *
 * WHAT IT DOES NOT CLAIM
 * Titles are written by sellers. A spec missing from a title is UNKNOWN, not
 * absent: an unknown never conflicts with anything, and the label says the
 * spec wasn't stated. This reads words; it does not inspect the item.
 */

export type ListingKind = "product" | "accessory" | "parts";

export interface Identity {
  kind: ListingKind;
  /** Why it is not a product, in words for the shopper. */
  kindReason?: string;
  /**
   * Model words straight after the searched name that the search did not ask
   * for, sorted. Undefined when the name is not in the title in order: then
   * the variant is unknown, and an unknown never conflicts.
   */
  variant?: string[];
  /**
   * Whether the title names the searched model at all, ignoring spaces and
   * punctuation ("HERO11" names "Hero 11"; "iPad Air (5. Generation)" names
   * "iPad Air 5"). A title that doesn't, an "iPhone 12" in an "iPhone 14"
   * search, is never compared: there is no telling what it is.
   */
  named?: boolean;
  generation?: number;
  storageGB?: number;
  ramGB?: number;
}

/** Words that make an accessory, unless the shopper searched for that word. */
const ACCESSORY_WORDS = [
  "charger", "charging", "adapter", "cable", "case", "cover", "sleeve", "bag", "pouch", "skin", "sticker", "decal",
  "stand", "dock", "mount", "holder", "strap", "band", "protector", "tempered glass", "keyboard cover", "power supply",
  "box only", "empty box", "dust bag", "controller grip", "earbud tips", "ear tips",
  // German, for eBay.de titles. Only words that name a separate item: "Controller"
  // or "Kabel" in a console's title usually lists what comes with it.
  "ladegerät", "ladegeraet", "ladekabel", "netzteil", "hülle", "schutzhülle", "handyhülle", "schutzfolie",
  "displayschutz", "displayschutzfolie", "panzerglas", "schutzglas", "halterung",
];

/** Words that make a listing a service, not the product. */
const SERVICE_WORDS = ["repair service", "reparatur", "reparaturservice", "austauschservice"];

/** Phrases that say the item does not work as sold. */
const PARTS_PHRASES = [
  "for parts", "parts only", "spares or repair", "spares/repair", "not working", "doesn't work", "does not work", "broken",
  "faulty", "defective", "cracked", "smashed", "water damaged", "won't turn on", "no power", "icloud locked", "activation locked",
  "blacklisted", "bad esn", "as is, untested", "untested",
  "defekt", "kaputt", "für bastler", "bastlerware", "funktioniert nicht", "nicht funktionsfähig", "ersatzteil",
  "als ersatzteil", "gesperrt", "icloud gesperrt", "displaybruch", "wasserschaden",
  "gesprungen", "glasbruch", "riss", "risse", "gerissen", "beschädigt", "beschaedigt", "displayschaden",
  "defekte", "defekter", "defektes", "defektem", "beschädigte", "beschädigter", "beschädigtes",
];

/** Phrases that say only part of the product is sold (a Dyson "Hauptgerät" is the motor unit alone). */
const PARTIAL_PHRASES = [
  "hauptgerät", "nur hauptgerät", "nur gerät", "ohne akku", "body only", "main unit only", "without battery",
  "nur tablet", "nur konsole", "nur ladecase", "nur case", "case only", "einzeln", "ersatz", "linker", "rechter",
  "left earbud", "right earbud", "ohne ovp und zubehör",
];

/**
 * Parts that are also sold alone: only when nothing in the title says the
 * listing comes WITH them ("AirPods Pro 2 mit MagSafe Ladecase" is the whole
 * set; "AirPods Pro 2 Ladecase A2700" is the case alone).
 */
const PART_ALONE_WORDS = ["ladecase", "charging case only"];
const COMES_WITH = /(^|[^a-z0-9])(mit|inkl\.?|inklusive|und|samt|with|incl\.?|including|plus|\+|&)([^a-z0-9]|$)/i;

/**
 * Model words that change what the product is. "Pro" is not a "Pro Max";
 * an "X1 Carbon" is not an "X1 Yoga"; a Switch OLED is not a Switch.
 */
const VARIANT_WORDS = [
  "pro", "max", "plus", "mini", "ultra", "lite", "air", "se", "fe", "xl", "slim", "carbon", "yoga", "nano", "fold", "flip",
  "oled", "studio", "edge", "neo", "go",
];

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function phraseRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "gi");
}

function hasPhrase(text: string, phrase: string): boolean {
  return phraseRegex(phrase).test(text);
}

/**
 * Does the phrase occur in a way that counts? Occurrences the surrounding
 * words cancel are skipped: "with case" and "charger included" describe
 * extras that come WITH the product; "not cracked" and "never broken" say the
 * opposite of the phrase.
 */
function countsAs(text: string, phrase: string, cancelBefore: RegExp, cancelAfter?: RegExp): boolean {
  for (const m of text.matchAll(phraseRegex(phrase))) {
    const start = m.index! + m[1].length;
    const end = m.index! + m[0].length - m[2].length;
    const before = text.slice(Math.max(0, start - 24), start);
    const after = text.slice(end, end + 16);
    if (cancelBefore.test(before)) continue;
    if (cancelAfter?.test(after)) continue;
    return true;
  }
  return false;
}

/** "with a case", "incl. charger", "+ cover", "comes with sleeve" */
const INCLUDED_BEFORE =
  /(with|w\/|incl\.?|including|includes|\+|&|and|plus|mit|inkl\.?|inklusive|samt|und)\s+(an?\s+|the\s+|original\s+|its\s+|einem\s+|einer\s+|dem\s+|der\s+)?$/i;
/** "charger included", "case incl.", "Hülle inklusive" */
const INCLUDED_AFTER = /^\s*(included|incl\b|inclusive|inklusive|dabei)/i;
/** "not cracked", "no broken", "never water damaged", "isn't faulty", "nicht defekt" */
const NEGATED_BEFORE = /(not|no|never|isn'?t|wasn'?t|without|zero|free of|nicht|kein|keine|keinen|ohne|nie)\s+(been\s+|any\s+)?$/i;

export function identify(title: string, query: string): Identity {
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  const qWords = new Set(words(q));

  // --- kind ------------------------------------------------------------------
  let kind: ListingKind = "product";
  let kindReason: string | undefined;
  const parts = PARTS_PHRASES.find((p) => !hasPhrase(q, p) && countsAs(t, p, NEGATED_BEFORE));
  const partial =
    PARTIAL_PHRASES.find((p) => !hasPhrase(q, p) && hasPhrase(t, p)) ??
    PART_ALONE_WORDS.find((p) => {
      if (hasPhrase(q, p) || !hasPhrase(t, p)) return false;
      const at = t.search(phraseRegex(p));
      return !COMES_WITH.test(t.slice(Math.max(0, at - 30), at));
    });
  if (parts) {
    kind = "parts";
    kindReason = `The listing says "${parts}", so it isn't compared with working ones.`;
  } else if (partial) {
    kind = "parts";
    kindReason = `The listing says "${partial}": only part of the product, so it isn't compared with complete ones.`;
  } else {
    const accessory = ACCESSORY_WORDS.find((w) => !hasPhrase(q, w) && countsAs(t, w, INCLUDED_BEFORE, INCLUDED_AFTER));
    const service = SERVICE_WORDS.find((w) => !hasPhrase(q, w) && hasPhrase(t, w));
    // "… for ThinkPad X1", "fits ThinkPad X1", "für PlayStation 5": the searched product comes right after.
    const at = q ? t.indexOf(q) : -1;
    const soldForUseWith =
      at > 0 &&
      /(^|[^a-z0-9])(for|fits|compatible with|für|fuer|passend für|kompatibel mit)\s+(the\s+|your\s+|all\s+|die\s+|den\s+|das\s+)?$/i.test(
        t.slice(0, at),
      );
    if (service) {
      kind = "accessory";
      kindReason = `It looks like a service ("${service}"), not a ${query.trim()}, so it isn't compared with one.`;
    } else if (accessory) {
      kind = "accessory";
      kindReason = `It looks like an accessory (${accessory}), not the ${query.trim()} itself, so it isn't compared with it.`;
    } else if (soldForUseWith) {
      kind = "accessory";
      kindReason = `It's sold for use with a ${query.trim()}, not as one, so it isn't compared with it.`;
    }
  }

  // --- variant -----------------------------------------------------------------
  // Only the words straight after the product name count: "ThinkPad X1 Carbon"
  // is a Carbon, but "ThinkPad X1, must go today" is not a Surface Go.
  // The model is the search without its specs: in "iPhone 13 128GB" the model
  // is "iPhone 13", so "iPhone 13 mini 128GB" reads as a mini, not as unknown.
  const allQw = words(q);
  const specWord = (w: string, i: number) =>
    /^\d+(gb|tb)$/.test(w) || ((w === "gb" || w === "tb") && i > 0) || (/^\d+$/.test(w) && /^(gb|tb)$/.test(allQw[i + 1] ?? ""));
  const modelQw = allQw.filter((w, i) => !specWord(w, i));
  const qw = modelQw.length ? modelQw : allQw;
  const tw = words(t);
  let variant: string[] | undefined;
  const at = qw.length ? tw.findIndex((_, i) => qw.every((w, j) => tw[i + j] === w)) : -1;
  if (at >= 0) {
    const run: string[] = [];
    for (const w of tw.slice(at + qw.length, at + qw.length + 3)) {
      if (!VARIANT_WORDS.includes(w) || qWords.has(w)) break;
      run.push(w);
    }
    variant = [...new Set(run)].sort();
  }

  // --- generation ------------------------------------------------------------
  const gen = t.match(/\bgen(?:eration)?\.?\s?(\d{1,2})\b/) ?? t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+gen(?:eration)?\b/);
  const generation = gen ? Number(gen[1]) : undefined;

  // --- memory and storage ------------------------------------------------------
  let storageGB: number | undefined;
  let ramGB: number | undefined;
  const ram = t.match(/\b(\d{1,3})\s?gb\s?(?:of\s)?(?:ram|memory|ddr\d?|lpddr\d?x?)\b/);
  if (ram) ramGB = Number(ram[1]);
  const tb = t.match(/\b(\d(?:\.\d)?)\s?tb\b/);
  if (tb) storageGB = Math.round(Number(tb[1]) * 1024);
  const marked = t.match(/\b(\d{2,4})\s?gb\s?(?:ssd|hdd|emmc|nvme|storage|rom)\b/);
  if (storageGB === undefined && marked) storageGB = Number(marked[1]);
  // Unmarked GB figures: a large one is storage; with two, the smaller is RAM.
  const unmarked = [...t.matchAll(/\b(\d{1,4})\s?gb\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n !== ramGB && n !== storageGB);
  for (const n of unmarked.sort((a, b) => b - a)) {
    if (storageGB === undefined && n >= 64) storageGB = n;
    else if (ramGB === undefined && n <= 64 && storageGB !== undefined && n < storageGB) ramGB = n;
  }

  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const named = qw.length ? squash(t).includes(qw.join("")) : undefined;

  return { kind, kindReason, variant, named, generation, storageGB, ramGB };
}

/** Do two products' known specs agree? An unknown never conflicts. */
export function sameProduct(a: Identity, b: Identity): boolean {
  if (a.kind !== "product" || b.kind !== "product") return false;
  if (a.variant && b.variant && a.variant.join(" ") !== b.variant.join(" ")) return false;
  const conflicts = (x?: number, y?: number) => x !== undefined && y !== undefined && x !== y;
  return !conflicts(a.generation, b.generation) && !conflicts(a.storageGB, b.storageGB) && !conflicts(a.ramGB, b.ramGB);
}

/** The specs a title states, in words, e.g. "Carbon, Gen 11, 512 GB storage, 16 GB RAM". */
export function describeSpecs(i: Identity): string | null {
  const bits = [
    ...(i.variant ?? []).map((v) => (v.length <= 2 ? v.toUpperCase() : v[0].toUpperCase() + v.slice(1))),
    i.generation !== undefined ? `Gen ${i.generation}` : null,
    i.storageGB !== undefined ? (i.storageGB >= 1024 ? `${+(i.storageGB / 1024).toFixed(1)} TB storage` : `${i.storageGB} GB storage`) : null,
    i.ramGB !== undefined ? `${i.ramGB} GB RAM` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(", ") : null;
}
