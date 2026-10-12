/**
 * lib/cart/refresh.ts — the cart's prices, asked again of the marketplace.
 *
 * Only eBay can be asked today (Browse getItem). Demo listings are invented,
 * and other marketplaces aren't priced live by SigPath, so those come back
 * "unchecked" with the reason, never with a guessed price. Each item is one
 * call against the site's daily eBay quota, so the caller passes a budget:
 * items past it are "unchecked" too, and the page says to try again later.
 */

import type { CurrentPrice } from "../marketplace/sources/types";
import type { Freshness } from "./cart";

export interface PriceAsker {
  currentPrice(id: string): Promise<CurrentPrice>;
}

export interface RefreshRequest {
  source: string;
  id: string;
}

export async function refreshPrices(
  items: RefreshRequest[],
  ebay: PriceAsker,
  /** Called once per eBay item before asking; false means the limit is reached. */
  allow: () => Promise<boolean>,
): Promise<Record<string, Freshness>> {
  const out: Record<string, Freshness> = {};
  await Promise.all(
    items.map(async ({ source, id }) => {
      const key = `${source}:${id}`;
      if (source === "stub") return void (out[key] = { status: "unchecked", reason: "A demo listing: there is no live price." });
      if (source !== "ebay") return void (out[key] = { status: "unchecked", reason: "SigPath can't check this marketplace's price live yet." });
      if (!(await allow())) return void (out[key] = { status: "unchecked", reason: "Too many price checks just now. Try again in a few minutes." });
      const r = await ebay.currentPrice(id);
      if (r.status === "ok" || r.status === "sold_out") out[key] = { status: r.status, price: r.price, shipping: r.shipping };
      else if (r.status === "gone") out[key] = { status: "gone" };
      else out[key] = { status: "unchecked", reason: r.status === "not_configured" ? "eBay isn't connected here." : "eBay didn't answer just now." };
    }),
  );
  return out;
}
