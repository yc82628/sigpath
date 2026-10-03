/**
 * lib/agents/check.ts — SigPath's deal check, shaped for AI shopping agents.
 *
 * WHAT AN AGENT GETS
 * The same search and verdicts a shopper sees, cut down to what an agent
 * needs to act on: the best checked deal per condition, then every listing
 * with its verdict and the plain-language reasons. Prices are display
 * strings, so a model can quote them without doing minor-unit arithmetic.
 * `checkedMeans` travels with every answer: an agent relaying "checked" to a
 * person must not let it turn into "guaranteed genuine".
 *
 * HOW IT IS PAID FOR
 * /api/check sits behind a pay.sh gateway (paysh/sigpath.yaml): an agent's
 * first request gets HTTP 402 with a USDC price, its wallet approves the
 * transfer, and the gateway settles it on Solana before forwarding the
 * request here with the shared gateway key (see gatewayAuthorised).
 */

import { timingSafeEqual } from "crypto";
import { CHECKED_MEANS, type Verdict } from "../marketplace/label";
import type { LabelledSearch } from "../marketplace/labelled-search";
import { formatMoney, listingKey, type Money } from "../marketplace/types";

/** The header the pay.sh gateway adds to every request it has been paid for. */
export const GATEWAY_HEADER = "x-sigpath-gateway";

const MARKET_NAME: Record<string, string> = { ebay: "eBay", amazon: "Amazon", etsy: "Etsy", feed: "Partner feeds", stub: "Demo" };

export interface AgentListing {
  title: string;
  url: string;
  marketplace: string;
  condition: string;
  /** Price plus shipping, as shown to shoppers, e.g. "137.00 EUR". */
  total: string;
  verdict: Verdict;
  /** "SigPath-checked", "Look closer" or "Not price-checked". */
  headline: string;
  /** Why, in plain language: what was compared, what raised a flag. */
  reasons: string[];
  verifiedSeller: boolean;
  /** The registered business behind the account, when it is a verified business. */
  verifiedBusiness: { name: string | null; country: string; domain: string | null; profile: string } | null;
}

export interface AgentCheck {
  query: string;
  /** The cheapest SigPath-checked listing per condition. Never a flagged one. */
  bestChecked: { condition: "new" | "used"; listing: AgentListing; belowMedian: string | null }[];
  listings: AgentListing[];
  counts: Record<Verdict, number>;
  /** Marketplaces that answered, and those that did not (with why). */
  searched: string[];
  notSearched: { marketplace: string; status: string }[];
  checkedMeans: string;
}

export function marketName(id: string): string {
  return MARKET_NAME[id] ?? id;
}

/** Price plus shipping, when shipping is in the same currency. */
export function listingTotal(l: LabelledSearch["listings"][number]): Money {
  return l.shipping && l.shipping.currency === l.price.currency ? { ...l.price, amount: l.price.amount + l.shipping.amount } : l.price;
}

/** One labelled listing, in the shape agents (and the shopping assistant) read. */
export function agentListing(l: LabelledSearch["listings"][number]): AgentListing {
  return {
    title: l.title,
    url: l.url,
    marketplace: marketName(l.source),
    condition: l.condition,
    total: formatMoney(listingTotal(l)),
    verdict: l.check.verdict,
    headline: l.check.headline,
    reasons: l.check.points.map((p) => p.text),
    verifiedSeller: l.verifiedSeller,
    verifiedBusiness: l.verifiedBusiness
      ? { name: l.verifiedBusiness.name, country: l.verifiedBusiness.country, domain: l.verifiedBusiness.domain ?? null, profile: `/business/${l.verifiedBusiness.id}` }
      : null,
  };
}

export function agentCheck(query: string, result: LabelledSearch): AgentCheck {
  const byKey = new Map<string, AgentListing>();
  const listings = result.listings.map((l) => {
    const out = agentListing(l);
    byKey.set(listingKey(l), out);
    return out;
  });

  const counts: Record<Verdict, number> = { checked: 0, caution: 0, unchecked: 0 };
  for (const l of listings) counts[l.verdict]++;

  const bestChecked = result.bestCheckedDeals.flatMap((d) => {
    const listing = byKey.get(d.listing);
    return listing ? [{ condition: d.group, listing, belowMedian: d.belowMedian ? formatMoney(d.belowMedian) : null }] : [];
  });

  return {
    query,
    bestChecked,
    listings,
    counts,
    searched: result.sources.filter((s) => s.status === "ok").map((s) => marketName(s.source)),
    notSearched: result.sources.filter((s) => s.status !== "ok").map((s) => ({ marketplace: marketName(s.source), status: s.status })),
    checkedMeans: CHECKED_MEANS,
  };
}

/**
 * Was this request forwarded by our pay.sh gateway, i.e. paid for?
 *
 * With SIGPATH_GATEWAY_KEY set (production), only requests carrying it get
 * through, so the free origin cannot be used to skip the payment. Unset, the
 * endpoint is open: local development and the sandbox demo.
 */
export function gatewayAuthorised(presented: string | null, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
