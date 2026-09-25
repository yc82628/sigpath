/**
 * lib/checkout/eligibility.ts — which listings SigPath will buy for you.
 *
 * When SigPath buys on a shopper's behalf, a scam listing costs SIGPATH's
 * money: the operator pays the seller, the item never comes, and the escrow
 * has already released. So the trust checks stop being advice at this point
 * and become a gate. A listing the anomaly analysis flagged gets no "Pay with
 * USDC" button — and the page says why, which is the more honest outcome for
 * the shopper too.
 *
 * The gate is enforced where the quote is SIGNED: no quote is issued for an
 * ineligible listing, and the checkout accepts nothing but a signed quote. A
 * hand-crafted checkout link for a flagged listing has no valid signature.
 */

import type { Flag } from "../marketplace/anomaly";
import type { Listing } from "../marketplace/types";
import { totalPrice } from "../marketplace/types";

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

const PAYABLE_CURRENCIES = new Set(["EUR", "USD"]);

export function checkoutEligibility(listing: Listing, flags: Flag[]): Eligibility {
  if (flags.length > 0) {
    return {
      eligible: false,
      reason: "SigPath won't buy a listing its own checks flagged — see the notes above.",
    };
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
  if (listing.shipping && listing.shipping.currency !== listing.price.currency) {
    // totalPrice cannot add these, so the quote would understate the total.
    return { eligible: false, reason: "Shipping is priced in a different currency, so the total is unknown." };
  }
  return { eligible: true };
}
