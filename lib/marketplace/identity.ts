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
  /**
   * The number the searched model ends in, when the title names it: "AirPods Pro 2" is the 2 the
   * listings write as "2. Generation". Not a generation of its own ("iPhone 15" isn't Gen 15), but
   * the version the search already pins.
   */
  modelNumber?: number;
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
  // Cleaning kits and small add-ons, common on AliExpress: "Cleaning Pen For … AirPods Pro".
  "cleaning kit", "cleaning pen", "cleaning tool", "cleaner", "brush", "ear hook", "ear hooks", "earhook", "earhooks",
  "lanyard", "anti-lost", "keycap", "reinigungsset", "reinigungsstift", "reinigungsbürste",
  "repair parts", "replacement", "covers", "joystick", "joysticks", "thumb grips", "rubber feet",
  // Spare parts taken out of a device ("Housing … pulled", "Ladebuchse Mikrofon Dock").
  "housing", "pulled", "ladebuchse", "flexkabel", "flex cable", "dock flex", "charging port",
];

/** Words that make a listing a service, not the product. */
const SERVICE_WORDS = ["repair service", "reparatur", "reparaturservice", "austauschservice"];

/** Phrases that say the item does not work as sold. */
const PARTS_PHRASES = [
  "for parts", "parts only", "spares or repair", "spares/repair", "not working", "doesn't work", "does not work", "broken",
  "faulty", "defective", "cracked", "smashed", "water damaged", "won't turn on", "no power", "icloud locked", "activation locked",
  "blacklisted", "bad esn", "as is, untested", "untested",
  "defekt", "kaputt", "für bastler", "bastlerware", "funktioniert nicht", "nicht funktionsfähig", "ersatzteil",
  "als ersatzteil", "gesperrt", "icloud gesperrt", "displaybruch", "wasserschaden", "scharnierbruch", "gehäusebruch",
  "gesprungen", "glasbruch", "riss", "risse", "gerissen", "beschädigt", "beschaedigt", "displayschaden",
  "defekte", "defekter", "defektes", "defektem", "beschädigte", "beschädigter", "beschädigtes",
  // Locked to someone else's Apple account: it can't be set up, so it isn't the working product.
  "icloud lock", "activation lock", "icloud sperre", "icloud-sperre", "icloudsperre", "aktivierungssperre",
  // Faults sellers name in passing ("ANC / Transparenz rauscht"): it doesn't work as it should.
  "rauscht", "rauschen", "knistert", "knistern", "knackt", "wackelkontakt", "tonaussetzer", "kein ton", "ohne ton",
  "crackling", "static noise", "buzzing", "no sound",
  // A screen with dead pixels: "guter Zustand - Pixelfehler" was a checked used deal at -18%.
  "pixelfehler", "pixelfehlern", "dead pixel", "dead pixels", "stuck pixel", "stuck pixels",
];

/** Phrases that say only part of the product is sold (a Dyson "Hauptgerät" is the motor unit alone). */
const PARTIAL_PHRASES = [
  "hauptgerät", "nur hauptgerät", "nur gerät", "ohne akku", "body only", "main unit only", "without battery",
  "nur tablet", "nur konsole", "nur ladecase", "nur case", "case only", "einzeln", "ersatz", "linker", "rechter",
  // One earbud of a pair: "AirPods Pro 2 ... Links Original" is the left one alone.
  "links", "rechts", "left earbud", "right earbud", "left airpod", "right airpod", "left only", "right only",
  "ohne ovp und zubehör",
  // A Switch without its controllers isn't the console it's compared with: "… | OHNE JOY CONS" was offered
  // as the cheaper alternative to a complete one.
  "ohne joy cons", "ohne joy-cons", "ohne joycons", "ohne joy con", "ohne joy-con", "ohne joycon", "ohne controller",
  // Everything but the console: "Nintendo Switch OLED Model - Nur Zubehör OHNE KONSOLE" at 60 € was priced as one.
  "ohne konsole", "nur zubehör", "nur das zubehör", "without console", "accessories only",
  "without joy cons", "without joy-cons", "without joycons", "without controllers", "no joy cons", "no joy-cons",
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
export const VARIANT_WORDS = [
  "pro", "max", "plus", "mini", "ultra", "lite", "air", "se", "fe", "xl", "slim", "carbon", "yoga", "nano", "fold", "flip",
  "oled", "studio", "edge", "neo", "go",
];

/**
 * Words a shop's title puts after the model, which listings write their own way
 * or leave out: the connector, the generation word, colours, "with". Searched as
 * part of the model, "Apple AirPods Pro 2 USB-C" found 50 listings on eBay and
 * compared none: hardly any title says those six words in that order.
 */
const NOT_THE_MODEL = new Set([
  "usb", "usbc", "lightning", "magsafe", "generation", "gen", "wifi", "wlan", "cellular", "lte", "gps", "bluetooth",
  "wireless", "kabellos", "kabellose", "kabelloser", "mit", "with", "inkl", "und", "and",
  "schwarz", "black", "white", "wei", "weiss", "silber", "silver", "grau", "gray", "grey", "blau", "blue", "gold", "rosa", "pink",
]);

/** Brands a listing may leave out of the name ("AirPods Pro 2" for "Apple AirPods Pro 2"). */
const BRANDS = new Set([
  "apple", "samsung", "sony", "lenovo", "nintendo", "microsoft", "google", "xiaomi", "huawei", "dyson", "bose", "jbl",
  "garmin", "canon", "nikon", "fujifilm", "gopro", "dji", "asus", "acer", "hp", "dell", "lg", "philips", "nike", "adidas",
  "oneplus", "sennheiser", "beats", "logitech", "razer", "amazon",
]);

/** The query's words in order, letters and digits only ("Nintendo Switch OLED" -> nintendo, switch, oled). */
function allWords(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    const before = text.slice(Math.max(0, start - 40), start);
    const after = text.slice(end, end + 16);
    if (cancelBefore.test(before)) continue;
    if (cancelAfter?.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * "with a case", "incl. charger", "+ cover", "comes with sleeve", and with the
 * words that describe the part in between: "mit MagSafe Case", "with USB-C
 * charging case". Without them, "AirPods Pro 3 mit MagSafe Case" read as the
 * case alone.
 */
const INCLUDED_BEFORE =
  /(with|w\/|incl\.?|including|includes|\+|&|and|plus|mit|inkl\.?|inklusive|samt|und)\s+(an?\s+|the\s+|original\s+|its\s+|einem\s+|einer\s+|dem\s+|der\s+)?((magsafe|usb[\s‑-]?c|lightning|wireless|kabellose[mnrs]?|kabellos|charging|originale[mnrs]?|qi|wei(ß|ss)e[mnrs]?|wei(ß|ss))[\s‑-]+){0,3}$/i;

/**
 * A German headphone title names the earbuds before the case: "AirPods Pro 3
 * In-Ear-Kopfhörer … USB-C Ladecase" is the whole set, not the case alone.
 */
const EARBUDS_BEFORE = /(kopfhörer|kopfhoerer|ohrhörer|ohrhoerer)/i;
const caseAfterEarbuds = (t: string, word: string) => {
  const at = t.search(phraseRegex(word));
  return at > 0 && EARBUDS_BEFORE.test(t.slice(0, at));
};
/** "charger included", "case incl.", "Hülle inklusive" */
const INCLUDED_AFTER = /^\s*(included|incl\b|inclusive|inklusive|dabei)/i;
/** "not cracked", "no broken", "never water damaged", "isn't faulty", "nicht defekt" */
const NEGATED_BEFORE = /(not|no|never|isn'?t|wasn'?t|without|zero|free of|nicht|kein|keine|keinen|ohne|nie|frei von)\s+(been\s+|any\s+)?$/i;

/**
 * Words in a title that say the item is used, whatever the marketplace's
 * condition field says: sellers mark a console "new" and title it "Zustand
 * gut". Compared with new ones, it then looks like a bargain.
 */
const USED_PHRASES = [
  "gebraucht", "gebrauchte", "gebrauchter", "gebrauchtes", "gebrauchsspuren", "wie neu", "neuwertig",
  "zustand gut", "zustand sehr gut", "zustand: gut", "zustand: sehr gut", "guter zustand", "sehr guter zustand",
  "top zustand", "akzeptabler zustand", "used", "pre-owned", "preowned", "pre owned", "second hand", "secondhand",
  "2nd hand", "like new", "very good condition", "good condition",
];

/**
 * Words that say a listing sold as new is refurbished: "Sehr Gut – Refurbished",
 * listed under eBay's "new". Counted as new, eight of them made the new price of
 * a Switch OLED look 30% lower than it is.
 */
const REFURBISHED_PHRASES = ["refurbished", "generalüberholt", "generalueberholt", "renewed", "wiederaufbereitet"];

/** The refurbished phrase in a title, unless negated ("not refurbished"). */
export function refurbishedFromTitle(title: string): string | undefined {
  const t = title.toLowerCase();
  return REFURBISHED_PHRASES.find((p) => countsAs(t, p, NEGATED_BEFORE));
}

/** The used phrase in a title, unless negated ("nicht gebraucht", "never used"); "ungebraucht" never matches. */
export function usedFromTitle(title: string): string | undefined {
  const t = title.toLowerCase().replace(/["„“”'‚‘’]/g, " ");
  return USED_PHRASES.find((p) => countsAs(t, p, NEGATED_BEFORE));
}

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
      // A shop's feature list ("AirPods Pro 2 Kabellose Ohrhörer, …, USB‑C Ladecase") names the
      // part after a comma: one feature of the product, not the part alone.
      return !COMES_WITH.test(t.slice(Math.max(0, at - 30), at)) && !t.slice(0, at).includes(",") && !caseAfterEarbuds(t, p);
    });
  if (parts) {
    kind = "parts";
    kindReason = `The listing says "${parts}", so it isn't compared with working ones.`;
  } else if (partial) {
    kind = "parts";
    kindReason = `The listing says "${partial}": only part of the product, so it isn't compared with complete ones.`;
  } else {
    // A German compound names its last part: searching "Schutzhülle" is searching for a "Hülle".
    const qCompounds = q.split(/[^\p{L}\p{N}]+/u);
    const searched = (w: string) => hasPhrase(q, w) || (!w.includes(" ") && qCompounds.some((qw) => qw.endsWith(w)));
    const accessory = ACCESSORY_WORDS.find(
      (w) => !searched(w) && countsAs(t, w, INCLUDED_BEFORE, INCLUDED_AFTER) && !(w === "case" && caseAfterEarbuds(t, w)),
    );
    const service = SERVICE_WORDS.find((w) => !hasPhrase(q, w) && hasPhrase(t, w));
    // "… for ThinkPad X1", "fits ThinkPad X1", "für PlayStation 5": the searched product comes right after.
    const at = q ? t.indexOf(q) : -1;
    const soldForUseWith =
      (at > 0 &&
        /(^|[^a-z0-9])(for|fits|compatible with|für|fuer|passend für|kompatibel mit)\s+(the\s+|your\s+|all\s+|die\s+|den\s+|das\s+)?$/i.test(
          t.slice(0, at),
        )) ||
      // A title that opens with "For …" ("For Apple AirPods 1 2 3 Pro Ear Hook") sells something for it.
      /^\s*(for|für|fuer)\s/i.test(t) ||
      // "… Joystick Covers for Nintendo Switch/OLED": "for" and then the product's first word, a brand
      // word ("Apple") at most in between, without the exact name having to follow.
      (allWords(q)[0] !== undefined &&
        new RegExp(String.raw`(^|[^a-z0-9])(for|fits|für|fuer|compatible with|kompatibel mit|passend für)\s+(\S+\s+)?${escapeRe(allWords(q)[0])}([^a-z0-9]|$)`, "i").test(t));
    // Sold by the piece or in packs ("10/20PCS", "2 Stück"): parts, not the product.
    const pack = /(^|[^a-z0-9])\d+\s*(pcs|pc|stück|stk)\.?([^a-z0-9]|$)/i.test(t) && !/(pcs|stück|stk)/i.test(q);
    if (service) {
      kind = "accessory";
      kindReason = `It looks like a service ("${service}"), not a ${query.trim()}, so it isn't compared with one.`;
    } else if (accessory) {
      kind = "accessory";
      kindReason = `It looks like an accessory (${accessory}), not the ${query.trim()} itself, so it isn't compared with it.`;
    } else if (soldForUseWith) {
      kind = "accessory";
      kindReason = `It's sold for use with a ${query.trim()}, not as one, so it isn't compared with it.`;
    } else if (pack) {
      kind = "accessory";
      kindReason = `It's sold by the piece or in a pack, not as a ${query.trim()}, so it isn't compared with one.`;
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
  // ...and without what a shop's title adds after the model: "Apple AirPods Pro 2 USB-C" is the model
  // "Apple AirPods Pro 2", so "AirPods Pro (2. Generation) mit USB-C" names it.
  const specFree = allQw.filter((w, i) => !specWord(w, i));
  const stop = specFree.findIndex((w, i) => i >= 2 && NOT_THE_MODEL.has(w));
  const modelQw = stop >= 0 ? specFree.slice(0, stop) : specFree;
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
  const generation = generationOf(t, modelQw);

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

  // The brand may be left out ("AirPods Pro 2. Generation"), when what is left still names a model on its
  // own: two words or a number. "Apple Watch" without "Apple" is just a watch.
  const unbranded = BRANDS.has(qw[0]) ? qw.slice(1) : [];
  const named = qw.length
    ? namesModel(t, qw.join("")) || ((unbranded.length >= 2 || /[0-9]/.test(unbranded.join(""))) && namesModel(t, unbranded.join("")))
    : undefined;

  const last = qw[qw.length - 1];
  const modelNumber = named && last !== undefined && /^\d{1,2}$/.test(last) ? Number(last) : undefined;

  return { kind, kindReason, variant, named, generation, storageGB, ramGB, ...(modelNumber !== undefined ? { modelNumber } : {}) };
}

const ORDINAL_WORDS: Record<string, number> = {
  erste: 1, zweite: 2, dritte: 3, vierte: 4, "fünfte": 5, sechste: 6,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
};

/** What may follow a number that is a count or a size, not a generation: "2 GB", "2er Set", "2 Stück", "2 Akkus". */
const NOT_A_GENERATION_AFTER =
  /^\s*-?(gb|tb|mb|mp|mm|cm|zoll|inch|x\b|"|er\b|stück|stk|pcs|pc\b|teile|teilig|akku|paar|pair|jahr|year|monat|month|tage|days|w\b|mah|hz|k\b|%|€|euro)/;

/**
 * The generation a title states. German titles write it "2. Generation",
 * "(2. Gen)" or "Erste Generation", English ones "Gen 3" or "3rd Gen", and most
 * just put the number after the model: "AirPods Pro 3", "AirPods Pro2". Read
 * only in English, "AirPods Pro Erste Generation" was priced against Pro 3s.
 *
 * A bare number counts only straight after the searched model (model words
 * like "Max" may come between), when the model doesn't end in a number itself
 * ("iPhone 15 2" says nothing), and when it isn't a size, a count or a year:
 * "Pro 2 GB", "2er Set", "Pro 2022", "AirPods 1/2/3".
 */
function generationOf(t: string, modelQw: string[]): number | undefined {
  const explicit =
    t.match(/\bgen(?:eration)?\.?\s?(\d{1,2})\b/) ??
    t.match(/\b(\d{1,2})(?:st|nd|rd|th)[\s-]?gen(?:eration)?\b/) ??
    t.match(/(?<![0-9.,])(\d{1,2})\.\s?gen(?:eration)?\b/);
  if (explicit) return Number(explicit[1]);
  const word = t.match(/(?<![\p{L}\p{N}])(erste|zweite|dritte|vierte|fünfte|sechste|first|second|third|fourth|fifth|sixth)[nrs]?[\s-]+gen(?:eration)?\b/u);
  if (word) return ORDINAL_WORDS[word[1]];

  const model = modelQw.join("");
  if (!model || /[0-9]$/.test(model)) return undefined;
  const between = "[^a-z0-9]*";
  const variants = `(?:[^a-z0-9]+(?:${VARIANT_WORDS.join("|")})(?![a-z0-9])){0,2}`;
  const re = new RegExp(`(?<![a-z0-9])${[...model].map(escapeRe).join(between)}${variants}[^a-z0-9]*?(\\d{1,2})(?![0-9])`);
  const m = t.match(re);
  if (!m) return undefined;
  const after = t.slice(m.index! + m[0].length);
  // A decimal, a list or a range ("2.5", "1/2/3", "1, 2", "1 2 3", a lens's "28-70") isn't one generation.
  if (/^\s*([.,]\d|[-/,&+]\s*\d|\s\d{1,2}(?![0-9]))/.test(after)) return undefined;
  if (NOT_A_GENERATION_AFTER.test(after)) return undefined;
  return Number(m[1]);
}

/**
 * Does the title name the model? Spacing and punctuation don't matter ("HERO11"
 * names "Hero 11", "iPad Air (5. Generation)" names "iPad Air 5", "PS 5" names
 * "PS5"), but a model number may not run on into more digits: "ThinkPad X13"
 * does not name a "ThinkPad X1", nor "iPhone 150" an "iPhone 15". Written
 * apart ("X1 2023", "X1 3rd Gen"), the digits after it are something else.
 */
function namesModel(title: string, model: string): boolean {
  const between = "[^a-z0-9]*";
  const pattern = [...model].map(escapeRe).join(between) + (/[0-9]$/.test(model) ? "(?![0-9])" : "");
  return new RegExp(pattern).test(title.toLowerCase());
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
