/**
 * lib/marketplace/registry.ts — the fixed set of marketplaces, and the honest
 * verdict on how each one can be reached.
 *
 * WHY A FIXED LIST
 * A small set of large retailers gives results that are comparable to each
 * other, and every source is an integration somebody has to keep working. This
 * is a product decision, and a good one.
 *
 * It is worth being clear about what it does NOT buy, though: speed. Sources
 * are queried in parallel HTTP fan-out, not crawled, and no language model is
 * involved in searching. Total latency is the SLOWEST source, not the sum — so
 * a fifth marketplace costs almost nothing in time. Limit the list for result
 * quality and maintenance cost, which are real, rather than for latency, which
 * is not the constraint here.
 *
 * WHY TWO ARE LINK-OUTS
 * Wanting a marketplace and being allowed to query it are different things, and
 * the gap is not a technical one we can engineer around:
 *
 *   eBay           Browse API. Application credentials, no user login. Usable.
 *
 *   Etsy           Open API v3, application key only. Usable, but its prices are
 *                  kept out of the median — handmade and vintage goods are not
 *                  comparable with retail. See sources/etsy.ts.
 *
 *   Amazon         sources/amazon.ts implements Product Advertising API 5.0,
 *                  which Amazon retired in 2026. Its successor, the Creators
 *                  API, is open only to an Associates account with at least 10
 *                  qualifying sales in the past 30 days. Until SigPath has that,
 *                  Amazon is a link-out too: a search link carrying the
 *                  Associates tag (AMAZON_PARTNER_TAG), so referred purchases
 *                  count towards access. It is shown only while Amazon is not a
 *                  live source, and it never touches a verdict.
 *
 *   idealo         developer.idealo.com is a PARTNER API for retailers pushing
 *                  their own offers INTO idealo. It is not read access to
 *                  idealo's product search. There is no public search API.
 *
 *   Kleinanzeigen  No public API at all. The terms forbid automated access, and
 *                  systematic extraction additionally runs into the German sui
 *                  generis database right (UrhG s.87b).
 *
 * The many "idealo API" and "Kleinanzeigen API" products that turn up in a
 * search are resold scrapers. Routing through one does not change what is
 * happening to the source site, it just puts a vendor between us and it — and
 * it inherits the same terms problem while adding a dependency that breaks
 * whenever the target's markup changes.
 *
 * SO WE LINK OUT INSTEAD.
 * For those two, the product shows a one-click deep link into the site's own
 * search. The buyer still gets every marketplace from one page, we extract
 * nothing, and nothing here is something a judge can object to. That is a
 * smaller feature than live results, and it is the honest version of it.
 */

import type { AccessMode, MarketplaceId } from "./types";

export interface MarketplaceInfo {
  id: MarketplaceId;
  /** Shown in the UI. */
  label: string;
  access: AccessMode;
  /** For link_out sources: why there is no API. Shown to the user, briefly. */
  note?: string;
  /** For link_out sources: build a deep link into that site's own search. */
  searchUrl?: (query: string) => string;
}

/** Hyphenated slug for path-style search URLs. */
function slug(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s-]/gi, "")
    .trim()
    .split(/\s+/)
    .join("-");
}

export const MARKETPLACES: MarketplaceInfo[] = [
  {
    id: "ebay",
    label: "eBay",
    access: "api",
  },
  {
    id: "amazon",
    label: "Amazon",
    access: "api",
  },
  {
    // Open API v3 with an application key. Prices are shown but kept out of the
    // median: handmade and vintage goods are not comparable with retail. See
    // sources/etsy.ts.
    id: "etsy",
    label: "Etsy",
    access: "api",
  },
  {
    id: "idealo",
    label: "idealo",
    access: "link_out",
    note: "No public search API — idealo's developer API is for retailers submitting offers.",
    searchUrl: (q) =>
      `https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${encodeURIComponent(q)}`,
  },
  {
    id: "kleinanzeigen",
    label: "Kleinanzeigen",
    access: "link_out",
    note: "No public API, and the terms do not permit automated access.",
    // Path-style search: /s-<slug>/k0, where k0 is the all-categories id.
    searchUrl: (q) => `https://www.kleinanzeigen.de/s-${slug(q) || "suche"}/k0`,
  },
];

export interface LinkOut {
  id: MarketplaceId;
  label: string;
  url: string;
  note?: string;
  /** An affiliate link: shown with the disclosure, and rel="sponsored". */
  affiliate?: boolean;
}

/** Amazon's storefront per AMAZON_LOCALE, the same codes sources/amazon.ts takes. */
const AMAZON_STORES: Record<string, string> = { DE: "www.amazon.de", UK: "www.amazon.co.uk", FR: "www.amazon.fr", US: "www.amazon.com" };

/**
 * A search link into Amazon's own storefront, carrying the Associates tag when
 * one is set. An Associates tracking id is short: letters, digits and hyphens
 * (e.g. "sigpath-21"); anything else is ignored rather than put in a URL.
 */
export function amazonSearchLink(query: string, env: Record<string, string | undefined> = process.env): LinkOut {
  const store = AMAZON_STORES[(env.AMAZON_LOCALE?.trim() || "DE").toUpperCase()] ?? AMAZON_STORES.DE;
  const tag = env.AMAZON_PARTNER_TAG?.trim();
  const tagged = !!tag && /^[A-Za-z0-9-]{1,64}$/.test(tag);
  return {
    id: "amazon",
    label: "Amazon",
    url: `https://${store}/s?k=${encodeURIComponent(query)}${tagged ? `&tag=${tag}` : ""}`,
    note: "Amazon's product API isn't open to SigPath yet, so its prices aren't compared.",
    affiliate: tagged,
  };
}

export function linkOutTargets(
  query: string,
  opts: { amazon?: boolean; env?: Record<string, string | undefined> } = {},
): LinkOut[] {
  const fixed: LinkOut[] = MARKETPLACES.filter((m) => m.access === "link_out" && m.searchUrl).map((m) => ({
    id: m.id,
    label: m.label,
    url: m.searchUrl!(query),
    note: m.note,
  }));
  return opts.amazon ? [amazonSearchLink(query, opts.env), ...fixed] : fixed;
}

export function marketplaceLabel(id: MarketplaceId): string {
  return MARKETPLACES.find((m) => m.id === id)?.label ?? id;
}
