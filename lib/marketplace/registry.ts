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
 *   Amazon         Product Advertising API 5.0 is a real, legitimate API and
 *                  sources/amazon.ts implements it properly. But access
 *                  requires an Associates account that has made qualifying
 *                  referred sales — three within 180 days to be granted it, and
 *                  continued sales to keep it, with access revoked after a
 *                  30-day dry spell. A project without live affiliate traffic
 *                  will not hold credentials. The client is built and ready if
 *                  you have them; it reports not_configured if you do not.
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

export function linkOutTargets(query: string): { id: MarketplaceId; label: string; url: string; note?: string }[] {
  return MARKETPLACES.filter((m) => m.access === "link_out" && m.searchUrl).map((m) => ({
    id: m.id,
    label: m.label,
    url: m.searchUrl!(query),
    note: m.note,
  }));
}

export function marketplaceLabel(id: MarketplaceId): string {
  return MARKETPLACES.find((m) => m.id === id)?.label ?? id;
}
