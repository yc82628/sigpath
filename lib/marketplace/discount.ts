/**
 * lib/marketplace/discount.ts — is the advertised discount real?
 *
 * WHY
 * "−40%" is the most persuasive number on a shop's page, and the easiest to
 * inflate: measure the cut from a price nobody ever charged, and any price
 * looks like a bargain. Around Black Friday that's most of what shoppers see.
 *
 * WHAT THE LAW SAYS (Germany, § 11 PAngV, from the EU Omnibus directive)
 * A shop that advertises a cut in its OWN price must state its lowest price of
 * the previous 30 days, and the cut counts from that. A comparison with the
 * maker's recommended retail price (UVP / RRP) is a different thing and is
 * allowed, as long as it's labelled. So a "−40% from UVP" can be perfectly
 * legal and still tell the shopper nothing about what the product costs.
 *
 * WHAT THIS CHECKS
 * The struck-out price the page shows, whatever it's measured from, against
 * what the same product sells for on eBay right now (the market SigPath already
 * measured, market.ts), and against the 30-day low when the page states one:
 *   - "not-lower": the price isn't below the shop's own lowest of the last 30 days.
 *   - "inflated": the struck-out price is above what the product usually sells
 *     for, and the claimed saving is at least 15 points more than the saving
 *     against the market ("−40%", but really −5%, or even above the market).
 *   - "real": the claimed saving holds up against the market.
 *   - "unchecked": there's no market to compare with (the price wasn't checked).
 * Only a SigPath-checked price is measured against the market, as everywhere
 * else: a price the checks flagged has no trustworthy comparison.
 */

/** What the struck-out price is: the maker's recommendation, the shop's earlier price, its 30-day low, or not said. */
export type DiscountReference = "rrp" | "was" | "lowest30" | "unknown";

export type DiscountVerdict = "real" | "inflated" | "not-lower" | "unchecked";

export interface DiscountCheck {
  /** The saving the page claims, in whole percent (40 for "−40%"). */
  claimedPct: number;
  reference: DiscountReference;
  /** In minor units, like the price. */
  was: number;
  lowest30: number | null;
  /** The saving against the market's typical price, in whole percent; negative when the price is above it. */
  vsMarketPct: number | null;
  /** The market's typical price, minor units, when it was compared. */
  typical: number | null;
  verdict: DiscountVerdict;
}

/** How many percentage points the claim may exceed the real saving before it counts as inflated. */
export const INFLATED_GAP = 15;

/** The label beside a struck-out price, in the languages the shops use: what it's measured from. */
export function referenceOf(label: string): DiscountReference {
  const l = label.toLowerCase();
  if (/niedrigst|lowest|30\s*(tage|days)/.test(l)) return "lowest30";
  if (/uvp|rrp|preisempf|list\s*price|listenpreis|prix conseill|msrp/.test(l)) return "rrp";
  if (/was|vorher|statt|previous|typical|mittlerer|ehemals|früher/.test(l)) return "was";
  return "unknown";
}

export function checkDiscount(input: {
  /** All in minor units of the same currency. */
  price: number;
  was: number | null;
  reference?: DiscountReference;
  lowest30?: number | null;
  /** The market for the same product, when SigPath measured one (price-check.ts). */
  market?: { typical: number; high: number } | null;
  /** Whether SigPath checked the price; only then is it measured against the market. */
  checked: boolean;
}): DiscountCheck | null {
  const { price, was } = input;
  if (!was || !(was > price) || price <= 0) return null;
  const claimedPct = Math.round(((was - price) / was) * 100);
  if (claimedPct < 1) return null;
  const reference = input.reference ?? "unknown";
  const lowest30 = input.lowest30 && input.lowest30 > 0 ? input.lowest30 : null;
  const market = input.checked && input.market ? input.market : null;
  const vsMarketPct = market ? Math.round(((market.typical - price) / market.typical) * 100) : null;
  const base = { claimedPct, reference, was, lowest30, vsMarketPct, typical: market?.typical ?? null };

  // The law's own measure, when the page gives it: no cheaper than in the last 30 days is no cut.
  if (lowest30 !== null && price >= lowest30) return { ...base, verdict: "not-lower" };
  if (!market || vsMarketPct === null) return { ...base, verdict: "unchecked" };
  const inflated = was > market.high && claimedPct - vsMarketPct >= INFLATED_GAP;
  return { ...base, verdict: inflated ? "inflated" : "real" };
}
