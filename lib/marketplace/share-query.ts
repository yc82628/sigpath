/**
 * lib/marketplace/share-query.ts — what a shopping app shared with SigPath.
 *
 * On Android, SigPath installed as an app sits in the share menu (app/manifest.ts).
 * Sharing a product from the Amazon or eBay app sends a title, a text and a
 * link, in each app's own way:
 *   Amazon: "Sony WF-1000XM5 … https://amzn.eu/d/3xYz" (a short link, no name in it)
 *   eBay:   "Schau dir diesen Artikel auf eBay an: Sony WH-1000XM5 … https://ebay.us/m/AbC"
 *   a shop's website in Chrome: the page title, and its full link with the name in the path.
 * From that, the product's name to search for: from the link when it carries
 * one (link-query.ts), otherwise from the words around it, without the apps'
 * own phrases ("Check out this item on eBay"). The shared link is never
 * opened: short links would need a request to Amazon or eBay to resolve, and
 * SigPath doesn't fetch shops' pages.
 */

import { queryFromLink, type LinkQuery } from "./link-query";
import { shortQuery } from "./price-check";

const URL_RE = /https?:\/\/[^\s<>"']+/i;

/** The apps' own words around the product's name, in English and German. */
const BOILERPLATE: RegExp[] = [
  /\b(check out|look at|have a look at|i found|found)\b[^:]*?\b(on|at|via)\s+(amazon|ebay|otto|mediamarkt|saturn|aliexpress)[^:]*:?/gi,
  /\b(schau( dir)?|sieh dir|guck( dir)?|ich habe)\b[^:]*?\b(auf|bei)\s+(amazon|ebay|otto|mediamarkt|saturn|aliexpress)\b(?:[^:\n]*:)?/gi,
  /\b(this|these) (product|item|deal|listing)s?\b/gi,
  /\s*[:|]\s*(amazon|ebay|otto|mediamarkt|saturn|aliexpress)(\.[a-z.]+)?\b.*$/gi, // "… : Amazon.de: Elektronik & Foto"
  /\bauf ebay\b|\bon ebay\b|\bbei amazon\b|\bon amazon\b/gi,
];

const SHOPS: [RegExp, string][] = [
  [/amzn\.|amazon\./i, "Amazon"],
  [/ebay\.|ebay\.us/i, "eBay"],
  [/otto\.de/i, "OTTO"],
  [/mediamarkt\./i, "MediaMarkt"],
  [/saturn\.de/i, "Saturn"],
  [/aliexpress\./i, "AliExpress"],
];

function cleanName(s: string): string {
  let t = s.replace(new RegExp(URL_RE.source, "gi"), " ");
  for (const re of BOILERPLATE) t = t.replace(re, " ");
  t = t.replace(/["„“”«»]/g, " ").replace(/\s+/g, " ").trim().replace(/^[\s:–—-]+|[\s:–—-]+$/g, "");
  return t;
}

/** The product to search for, and which shop it came from; null when nothing usable was shared. */
export function queryFromShare(input: { title?: string | null; text?: string | null; url?: string | null }): LinkQuery | null {
  const title = (input.title ?? "").slice(0, 500);
  const text = (input.text ?? "").slice(0, 1000);
  const link = (input.url ?? "").match(URL_RE)?.[0] ?? text.match(URL_RE)?.[0] ?? title.match(URL_RE)?.[0] ?? null;
  const shop = link ? SHOPS.find(([re]) => re.test(link))?.[1] : undefined;

  // A link with the name in it is the most exact (amazon.de/Apple-AirPods-Pro-2/dp/…).
  const fromLink = link ? queryFromLink(link) : null;
  if (fromLink) return fromLink;

  // Otherwise the words that came with it: the longer of the text's and the title's.
  const names = [cleanName(text), cleanName(title)].filter((n) => /[a-zäöüß]/i.test(n) && n.length >= 3).sort((a, b) => b.length - a.length);
  if (!names.length) return null;
  const query = shortQuery(names[0], { keepStorage: true }) || names[0].split(" ").slice(0, 8).join(" ");
  return query.length >= 3 ? { query: query.slice(0, 120), shop: shop ?? "" } : null;
}
