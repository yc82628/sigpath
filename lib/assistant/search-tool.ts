/**
 * lib/assistant/search-tool.ts — the one tool the shopping assistant has.
 *
 * The model turns what a shopper says ("a used ThinkPad under 400, safe
 * sellers only") into these parameters; this runs SigPath's real search and
 * verdicts and filters them. The assistant never sees a listing the search
 * page would not show, and never gets a verdict the search page would not
 * give, so it cannot talk a flagged listing into a safe one.
 *
 * RANKING
 * Checked listings first, cheapest first; then not-price-checked ones. A
 * "look closer" listing is never ranked among the picks, but the cheapest one
 * that matches is always shown at the end, because the bargain that is too
 * good to be true is exactly what the shopper needs warning about.
 */

import { z } from "zod";
import type { Verdict } from "../marketplace/label";
import type { LabelledSearch } from "../marketplace/labelled-search";
import { agentListing, listingTotal, marketName, type AgentListing } from "../agents/check";
import { CHECKED_MEANS } from "../marketplace/label";
import { listingKey } from "../marketplace/types";

export const MARKETPLACES = ["ebay", "amazon", "etsy"] as const;

export const SearchInput = z.object({
  query: z.string().trim().min(1).max(120),
  condition: z.enum(["new", "used", "refurbished", "any"]).default("any"),
  min_price: z.number().nonnegative().optional(),
  max_price: z.number().positive().optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()).optional(),
  marketplaces: z.array(z.enum(MARKETPLACES)).max(3).optional(),
  checked_only: z.boolean().default(false),
  verified_seller_only: z.boolean().default(false),
});
export type SearchInput = z.infer<typeof SearchInput>;

/** The tool as the model sees it. */
export const SEARCH_TOOL = {
  name: "search_deals",
  description:
    "Search eBay, Amazon and Etsy at once through SigPath and get each listing's SigPath verdict: " +
    '"checked" (price in line with the market, no warnings), "caution" (look closer, with reasons) or ' +
    '"unchecked" (nothing to compare it with). Put only the product in `query` and express preferences ' +
    "with the other fields. Prices are totals including shipping, in major units (e.g. 399.99).",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: 'The product only, e.g. "ThinkPad X1 Carbon" or "ceramic mug".' },
      condition: { type: "string", enum: ["new", "used", "refurbished", "any"], description: "Default any." },
      min_price: { type: "number", description: "Lowest total price, major units." },
      max_price: { type: "number", description: "Highest total price (the budget), major units." },
      currency: { type: "string", description: "ISO code, e.g. EUR. Defaults to the shop's currency." },
      marketplaces: { type: "array", items: { type: "string", enum: [...MARKETPLACES] }, description: "Only these marketplaces." },
      checked_only: { type: "boolean", description: "Only SigPath-checked listings." },
      verified_seller_only: { type: "boolean", description: "Only sellers with the verified-seller badge." },
    },
    required: ["query"],
  },
};

export interface AssistantCard extends AgentListing {
  id: string;
}

export interface AssistantResults {
  query: string;
  /** Picks in order, then at most one warning (a "caution" listing) last. */
  shown: AssistantCard[];
  /** Listings found, and how many met every preference. */
  found: number;
  matched: number;
  /**
   * Only when there is no safe pick (nothing matched, or only flagged
   * listings did): the cheapest listings that meet every preference except
   * the price range, checked ones first, never flagged ones. Real
   * alternatives to offer, so the reply never has to invent one.
   */
  closest: AssistantCard[];
  /**
   * One sentence about the flagged listing shown last, if there is one, for
   * the reply to pass on. Spelled out because a small model given only a
   * verdict field tends to skip it, and the warning is the point.
   */
  warning: string | null;
  counts: Record<Verdict, number>;
  searched: string[];
  notSearched: string[];
  /** Link to the full results page for this search. */
  seeAll: string;
  checkedMeans: string;
}

const MAX_PICKS = 5;

export function filterResults(input: SearchInput, result: LabelledSearch): AssistantResults {
  const wanted = (l: LabelledSearch["listings"][number], ignorePrice = false): boolean => {
    if (input.condition !== "any" && l.condition !== input.condition) return false;
    if (input.marketplaces?.length && !input.marketplaces.includes(l.source as (typeof MARKETPLACES)[number])) {
      // The demo feed stands in for every marketplace, so a marketplace filter never empties a demo.
      if (l.source !== "stub") return false;
    }
    if (input.checked_only && l.check.verdict !== "checked") return false;
    if (input.verified_seller_only && !l.verifiedSeller) return false;
    if (!ignorePrice && (input.min_price !== undefined || input.max_price !== undefined || input.currency)) {
      const total = listingTotal(l);
      if (input.currency && total.currency !== input.currency) return false;
      const major = total.amount / 100;
      if (input.min_price !== undefined && major < input.min_price) return false;
      if (input.max_price !== undefined && major > input.max_price) return false;
    }
    return true;
  };

  const matched = result.listings.filter((l) => wanted(l));
  const byPrice = (a: (typeof matched)[number], b: (typeof matched)[number]) => listingTotal(a).amount - listingTotal(b).amount;
  const checked = matched.filter((l) => l.check.verdict === "checked").sort(byPrice);
  const unchecked = matched.filter((l) => l.check.verdict === "unchecked").sort(byPrice);
  const caution = matched.filter((l) => l.check.verdict === "caution").sort(byPrice);

  const picks = [...checked, ...unchecked].slice(0, MAX_PICKS);
  const shown = [...picks, ...caution.slice(0, 1)].map((l) => ({ id: listingKey(l), ...agentListing(l) }));


  const flagged = shown.find((c) => c.verdict === "caution");
  const card = (l: (typeof matched)[number]) => ({ id: listingKey(l), ...agentListing(l) });
  const closest =
    picks.length > 0
      ? []
      : result.listings
          .filter((l) => wanted(l, true) && l.check.verdict !== "caution")
          .sort((a, b) => (a.check.verdict === b.check.verdict ? byPrice(a, b) : a.check.verdict === "checked" ? -1 : 1))
          .slice(0, 2)
          .map(card);

  const counts: Record<Verdict, number> = { checked: checked.length, caution: caution.length, unchecked: unchecked.length };
  return {
    query: input.query,
    shown,
    found: result.listings.length,
    matched: matched.length,
    closest,
    warning: flagged
      ? `Do not recommend "${flagged.title}" (${flagged.total}): SigPath flags it "Look closer" because: ${flagged.reasons.join(" ") || "something about it looks off."} Warn the shopper about it.`
      : null,
    counts,
    searched: result.sources.filter((s) => s.status === "ok").map((s) => marketName(s.source)),
    notSearched: result.sources.filter((s) => s.status !== "ok").map((s) => marketName(s.source)),
    seeAll: `/search?q=${encodeURIComponent(input.query)}`,
    checkedMeans: CHECKED_MEANS,
  };
}
