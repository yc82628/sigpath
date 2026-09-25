import { searchAll } from "@/lib/marketplace/search";
import { defaultSources } from "@/lib/marketplace/sources";
import { formatMoney, totalPrice, type Listing } from "@/lib/marketplace/types";
import type { Flag } from "@/lib/marketplace/anomaly";
import { signQuote, quoteSigningConfigured } from "@/lib/checkout/quote";
import { checkoutEligibility } from "@/lib/checkout/eligibility";
import { AddressStore } from "@/lib/checkout/address-store";

/**
 * app/search/page.tsx — the buyer-facing half.
 *
 * A SERVER COMPONENT WITH A PLAIN GET FORM, ON PURPOSE.
 * The query string is the entire state. That means: the page works with
 * JavaScript disabled, a result is a shareable URL, the back button does what
 * it should, and there is no client-side fetch to instrument. For a site whose
 * selling point is that it has no accounts, not shipping a tracking surface is
 * part of the product rather than an optimisation.
 *
 * Nothing here reads a cookie, a session or a user id, and the server writes no
 * log tying a query to a person.
 *
 * WHAT THE PAGE IS CAREFUL ABOUT
 * Every flag shown is an observation the buyer can weigh, never an accusation
 * about a seller — the styling is deliberately not alarm-red for the same
 * reason. And the coverage strip is not diagnostics: when a marketplace did not
 * answer, the price comparison is withheld and the page says so, because a
 * median taken over a biased sample would flag honest listings as suspicious.
 */

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  ok: "searched",
  not_configured: "not configured",
  rate_limited: "rate limited",
  timeout: "timed out",
  error: "failed",
};

/** Checkout offer for one listing: a signed quote, a reason there is none, or null when checkout is off. */
type CheckoutOffer = { token: string } | { reason: string } | null;

function ListingRow({ listing, flags, checkout }: { listing: Listing; flags: Flag[]; checkout: CheckoutOffer }) {
  const total = totalPrice(listing);
  const shipping = listing.shipping?.amount ?? 0;
  const seller = listing.seller;

  return (
    <article className="listing">
      <div className="body">
        <h3>
          {/* noreferrer as well as noopener: the destination has no business
              knowing which search sent the buyer there. */}
          <a href={listing.url} target="_blank" rel="noopener noreferrer">
            {listing.title}
          </a>
        </h3>
        <p className="meta">
          {listing.source} &middot; {listing.condition} &middot; {seller.displayName ?? seller.handle}
          {seller.feedbackScore !== undefined && (
            <>
              {" "}
              &middot;{" "}
              {/* The marketplace's own number, labelled for what it is. It is
                  self-contained to one platform and not independently
                  checkable — which is exactly the gap the verification half of
                  this product closes. Presenting it as trust would overstate
                  it. */}
              <span className="unverified" title="Reported by the marketplace itself; not independently verified">
                {seller.feedbackScore} ratings, unverified
              </span>
            </>
          )}
        </p>
        {flags.length > 0 && (
          <ul className="flags">
            {flags.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
        )}
        {checkout && "token" in checkout && (
          // The price travels inside a server signature, so this link cannot
          // be edited into a cheaper order. See lib/checkout/quote.ts.
          <a className="pay" href={`/checkout?quote=${encodeURIComponent(checkout.token)}`}>
            Pay with USDC &rarr;
          </a>
        )}
        {checkout && "reason" in checkout && <p className="pay-blocked">{checkout.reason}</p>}
      </div>
      <div className="price">
        {formatMoney(total)}
        <span className="ship">{shipping > 0 ? `incl. shipping` : "free shipping"}</span>
      </div>
    </article>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const q = (searchParams.q ?? "").trim().slice(0, 120);
  const result = q ? await searchAll(q, defaultSources(), { limit: 20 }) : null;

  const byListing = new Map<string, Flag[]>();
  for (const f of result?.analysis.flags ?? []) {
    byListing.set(f.listingId, [...(byListing.get(f.listingId) ?? []), f]);
  }

  const a = result?.analysis;

  // Checkout is offered only when BOTH secrets exist: one to sign prices, one to
  // encrypt delivery addresses. Missing either, no listing gets a pay button.
  const checkoutReady = quoteSigningConfigured() && AddressStore.fromEnv() !== null;
  const checkoutOffer = (l: Listing, flags: Flag[]): CheckoutOffer => {
    if (!checkoutReady) return null;
    const e = checkoutEligibility(l, flags);
    if (!e.eligible) return { reason: e.reason };
    const total = totalPrice(l);
    const token = signQuote({
      source: l.source,
      id: l.id,
      url: l.url,
      title: l.title,
      amount: total.amount,
      currency: total.currency,
    });
    return token ? { token } : null;
  };

  return (
    <main className="container wide">
      <h1>SigPath Search</h1>
      <p className="lede">
        One search across several marketplaces &mdash; and the checks no single
        marketplace can run on itself.
      </p>

      <form className="searchbar" method="GET" action="/search">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="What are you looking for?"
          aria-label="Search all marketplaces"
          autoFocus
        />
        <button type="submit">Search</button>
      </form>
      <p className="hint">No account, no sign-in, nothing stored about this search.</p>

      {result && (
        <>
          {/* Which marketplaces this answer actually rests on. */}
          <ul className="coverage">
            {result.sources.map((s) => (
              <li
                key={s.source}
                className={
                  s.status === "ok" ? "ok" : s.status === "not_configured" ? "" : "degraded"
                }
                title={s.detail ?? ""}
              >
                {s.source}: {STATUS_LABEL[s.status] ?? s.status}
                {s.status === "ok" && ` (${s.count})`}
              </li>
            ))}
          </ul>

          {a?.status === "ok" ? (
            <p className="notice">
              Median price {formatMoney({ amount: a.median!, currency: a.currency! })} across{" "}
              {a.sampleSize} comparable listings
              {a.coverage.length > 1
                ? ` on ${a.coverage.length} marketplaces`
                : ` on ${a.coverage[0]}`}
              .
              {a.notConfigured.length > 0 && (
                <> Not searched: {a.notConfigured.join(", ")}.</>
              )}
              {a.excludedFromComparison.length > 0 && (
                // Says why a cheap listing from these carries no price flag.
                <> Shown but not price-compared: {a.excludedFromComparison.join(", ")} (handmade and vintage goods are not comparable with retail).</>
              )}
            </p>
          ) : (
            // Saying WHY there is no price comparison matters more than hiding
            // its absence. A buyer who thinks a check ran when it did not is
            // worse off than one who knows it did not.
            <p className="notice withheld">{a?.reason}</p>
          )}

          {result.listings.length === 0 ? (
            <p className="hint">No listings found for &ldquo;{q}&rdquo;.</p>
          ) : (
            result.listings.map((l) => {
              const flags = byListing.get(l.id) ?? [];
              return (
                <ListingRow
                  key={`${l.source}-${l.id}`}
                  listing={l}
                  flags={flags}
                  checkout={checkoutOffer(l, flags)}
                />
              );
            })
          )}

          {/* The marketplaces we cover but are not permitted to query. One
              click each rather than nothing — and deliberately separated from
              the results above, because no price here reached the median and
              implying otherwise would overstate the comparison. */}
          {result.linkOut.length > 0 && (
            <section className="linkout">
              <h2>Also search directly</h2>
              <p className="hint">
                These have no API we may use, so their prices are not part of the
                comparison above.
              </p>
              <ul>
                {result.linkOut.map((t) => (
                  <li key={t.id}>
                    <a href={t.url} target="_blank" rel="noopener noreferrer">
                      {t.label} &rarr;
                    </a>
                    {t.note && <span className="hint"> {t.note}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
