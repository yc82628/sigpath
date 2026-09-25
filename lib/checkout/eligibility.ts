/**
 * lib/checkout/eligibility.ts — which listings SigPath will buy for you.
 *
 * When SigPath buys on a shopper's behalf, a scam listing costs SIGPATH's
 * money: the operator pays the seller, the item never comes, and the escrow
 * has already released. So the trust checks stop being advice at this point
 * and become a gate.
 *
 * THE GATE IS STRICTER THAN THE WARNINGS, ON PURPOSE
 * The anomaly module flags a listing only when the evidence is solid, because
 * a false flag misinforms a shopper and defames a seller — silence is the safe
 * default there. The checkout faces the opposite trade: a missed scam here is
 * SigPath's own loss, while declining an honest cheap item only costs a sale.
 * So the checkout does not ask "was this flagged?" but "was this price
 * CHECKED?" — compared against enough listings of the same condition. A price
 * nobody could check gets no pay button, even though nothing on the page
 * accuses it of anything.
 *
 * The gate is enforced where the quote is SIGNED: no quote is issued for an
 * ineligible listing, and the checkout accepts nothing but a signed quote. A
 * hand-crafted checkout link for a flagged listing has no valid signature.
 */

import type { Analysis, Flag } from "../marketplace/anomaly";
import type { Listing } from "../marketplace/types";
import { listingKey, totalPrice } from "../marketplace/types";

export type Eligibility = { eligible: true } | { eligible: false; reason: string };
export type PriceCheck = { checked: true } | { checked: false; reason: string };

const PAYABLE_CURRENCIES = new Set(["EUR", "USD"]);

/**
 * Was this listing's price compared against a same-condition median? And if
 * not, why not — in words the shopper can use.
 */
export function priceCheckFor(listing: Listing, analysis: Analysis): PriceCheck {
  // Keyed by source AND id: eBay "123" being checked must not vouch for Etsy "123".
  if (analysis.priceChecked.includes(listingKey(listing))) return { checked: true };

  if (analysis.excludedFromComparison.includes(listing.source)) {
    return { checked: false, reason: "Prices from this marketplace aren't compared with retail." };
  }
  if (analysis.status === "incomplete_coverage") {
    return { checked: false, reason: "Prices can't be compared while a marketplace isn't responding." };
  }
  if (listing.condition === "unknown") {
    return { checked: false, reason: "Its condition isn't stated, so its price can't be compared." };
  }
  if (listing.price.currency !== analysis.currency) {
    return { checked: false, reason: `It's priced in ${listing.price.currency}, so it can't be compared with the rest.` };
  }
  const condition = listing.condition === "used" ? "used" : "new";
  return { checked: false, reason: `There weren't enough ${condition} listings to compare its price with.` };
}

export function checkoutEligibility(listing: Listing, flags: Flag[], priceCheck: PriceCheck): Eligibility {
  if (flags.length > 0) {
    return {
      eligible: false,
      reason: "SigPath won't buy a listing its own checks flagged — see the notes above.",
    };
  }
  if (!priceCheck.checked) {
    return { eligible: false, reason: `SigPath only buys what it could price-check. ${priceCheck.reason}` };
  }
  if (listing.shipping === undefined) {
    // Etsy never publishes shipping in search results, and eBay does not
    // always. Quoting the item alone would under-collect, and SigPath would pay
    // the difference to a stranger's courier.
    return { eligible: false, reason: "Shipping cost isn't published, so the total can't be quoted." };
  }
  const total = totalPrice(listing);
  if (!PAYABLE_CURRENCIES.has(total.currency.toUpperCase())) {
    return { eligible: false, reason: `Priced in ${total.currency}; USDC checkout supports EUR and USD.` };
  }
  if (listing.shipping.currency !== listing.price.currency) {
    // totalPrice cannot add these, so the quote would understate the total.
    return { eligible: false, reason: "Shipping is priced in a different currency, so the total is unknown." };
  }
  return { eligible: true };
}
