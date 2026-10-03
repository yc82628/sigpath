/**
 * lib/marketplace/sources/stub.ts — an offline feed that behaves like a real one.
 *
 * WHY THIS EXISTS
 * eBay credentials are a developer-account registration, which gates every
 * other piece of work behind something only the repo owner can do. This feed
 * means the search route, the merge, the anomaly check and the UI can all be
 * built and tested today, and the real source drops in behind the same
 * interface later.
 *
 * DETERMINISTIC ON PURPOSE
 * The same query always produces the same listings, seeded from the query
 * string. A demo that reshuffles itself between rehearsal and stage is worse
 * than no demo, and a test against random data is a test that fails on Tuesday.
 *
 * IT DELIBERATELY CONTAINS SCAMS
 * Every query yields one drastically underpriced listing and one pair of
 * listings sharing a photo under different seller names, because a feed that
 * only ever looks healthy cannot demonstrate a check that is supposed to catch
 * unhealthy things. Nothing here is meant to resemble a real seller: names are
 * generated, and no real marketplace is contacted.
 */

import { createHash } from "crypto";
import type { Condition, Listing, SearchOptions, SourceResult } from "../types";
import type { MarketplaceSource } from "./types";

/** Deterministic 32-bit stream from a seed string. */
function rng(seed: string): () => number {
  let h = createHash("sha256").update(seed).digest();
  let i = 0;
  return () => {
    if (i + 4 > h.length) {
      h = createHash("sha256").update(h).digest();
      i = 0;
    }
    const v = h.readUInt32BE(i);
    i += 4;
    return v / 0xffffffff;
  };
}

const CONDITIONS: Condition[] = ["new", "new", "new", "refurbished", "used"];
const ADJECTIVES = ["Sealed", "Boxed", "Mint", "Genuine", "Original", "Unused"];

export class StubSource implements MarketplaceSource {
  readonly id = "stub" as const;

  /**
   * `delayMs` makes the demo feed answer like a real marketplace would — after
   * a network round trip — so the search page's streaming can be seen and
   * demonstrated without live keys (STUB_DELAY_MS). Zero by default.
   */
  constructor(
    private readonly currency = "EUR",
    private readonly delayMs = 0,
  ) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SourceResult> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const q = query.trim();
    if (!q) {
      return { source: this.id, status: "ok", listings: [] };
    }

    const limit = Math.min(opts.limit ?? 12, 40);
    const next = rng(q.toLowerCase());

    // A plausible going rate for this query, 40.00 to 640.00.
    const base = 4000 + Math.floor(next() * 60000);
    const listings: Listing[] = [];

    for (let i = 0; i < limit; i++) {
      // Honest listings scatter within roughly +/-25% of the going rate.
      const spread = 0.75 + next() * 0.5;
      const amount = Math.round((base * spread) / 100) * 100;
      const condition = CONDITIONS[Math.floor(next() * CONDITIONS.length)];
      const sellerNo = Math.floor(next() * 900) + 100;

      listings.push({
        id: `stub-${i}`,
        source: this.id,
        title: `${ADJECTIVES[Math.floor(next() * ADJECTIVES.length)]} ${q}`,
        url: `https://example.invalid/stub/${encodeURIComponent(q)}/${i}`,
        price: { amount, currency: this.currency },
        shipping: { amount: Math.floor(next() * 5) * 100, currency: this.currency },
        condition,
        imageHash: `img-${i}`,
        seller: {
          handle: `seller_${sellerNo}`,
          displayName: `Seller ${sellerNo}`,
          feedbackScore: Math.floor(next() * 4000),
          feedbackPercentage: 90 + Math.floor(next() * 10),
        },
        listedAt: Math.floor(Date.now() / 1000) - Math.floor(next() * 60 * 86400),
      });
    }

    // --- the plant: far below the going rate, from a brand-new account -------
    listings.push({
      id: "stub-bait",
      source: this.id,
      title: `${q} - URGENT SALE, must go today`,
      url: `https://example.invalid/stub/${encodeURIComponent(q)}/bait`,
      price: { amount: Math.round((base * 0.28) / 100) * 100, currency: this.currency },
      shipping: { amount: 0, currency: this.currency },
      condition: "new",
      imageHash: "img-shared",
      seller: {
        handle: "quick_deals_2026",
        displayName: "Quick Deals",
        feedbackScore: 0,
        feedbackPercentage: 0,
        memberSince: Math.floor(Date.now() / 1000) - 3 * 86400,
      },
      listedAt: Math.floor(Date.now() / 1000) - 3600,
    });

    // --- the plant: a USED item far below the going used price ----------------
    // Priced against other used units, not against new ones: it is a scam
    // because it is cheap for a USED one. The seller account is deliberately
    // old and rated, so the only thing that can catch it is the used-item price
    // comparison — the check this plant exists to demonstrate.
    listings.push({
      id: "stub-used-bait",
      source: this.id,
      title: `${q} used, like new - quick sale`,
      url: `https://example.invalid/stub/${encodeURIComponent(q)}/used-bait`,
      price: { amount: Math.round((base * 0.15) / 100) * 100, currency: this.currency },
      shipping: { amount: 0, currency: this.currency },
      condition: "used",
      imageHash: "img-used-bait",
      seller: { handle: "long_time_seller", displayName: "Long Time Seller", feedbackScore: 1200, feedbackPercentage: 98 },
      listedAt: Math.floor(Date.now() / 1000) - 86400,
    });

    // --- the plant: same photo, different seller ----------------------------
    listings.push({
      id: "stub-clone",
      source: this.id,
      title: `${q} brand new`,
      url: `https://example.invalid/stub/${encodeURIComponent(q)}/clone`,
      price: { amount: Math.round((base * 0.9) / 100) * 100, currency: this.currency },
      shipping: { amount: 499, currency: this.currency },
      condition: "new",
      imageHash: "img-shared",
      seller: { handle: "bargain_bin_77", displayName: "Bargain Bin", feedbackScore: 12 },
      listedAt: Math.floor(Date.now() / 1000) - 7200,
    });

    // --- not the product: an accessory and a for-parts unit ---------------------
    // Both are far below the going rate and both are honest. Priced against the
    // product they would read as scams; the identity check (identity.ts) keeps
    // them out of the comparison and says why, instead of accusing their sellers.
    const oldAccount = Math.floor(Date.now() / 1000) - 5 * 365 * 86400;
    listings.push({
      id: "stub-accessory",
      source: this.id,
      title: `Charger for ${q}`,
      url: `https://example.invalid/stub/${encodeURIComponent(q)}/accessory`,
      price: { amount: Math.max(900, Math.round((base * 0.05) / 100) * 100), currency: this.currency },
      shipping: { amount: 0, currency: this.currency },
      condition: "new",
      imageHash: "img-accessory",
      seller: { handle: "cable_corner", displayName: "Cable Corner", feedbackScore: 5400, feedbackPercentage: 99, memberSince: oldAccount },
      listedAt: Math.floor(Date.now() / 1000) - 5 * 86400,
    });
    listings.push({
      id: "stub-parts",
      source: this.id,
      title: `${q} for parts, not working`,
      url: `https://example.invalid/stub/${encodeURIComponent(q)}/parts`,
      price: { amount: Math.round((base * 0.18) / 100) * 100, currency: this.currency },
      shipping: { amount: 500, currency: this.currency },
      condition: "used",
      imageHash: "img-parts",
      seller: { handle: "repair_shop_de", displayName: "Repair Shop", feedbackScore: 860, feedbackPercentage: 97, memberSince: oldAccount },
      listedAt: Math.floor(Date.now() / 1000) - 9 * 86400,
    });

    return { source: this.id, status: "ok", listings };
  }
}
