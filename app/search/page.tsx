import { searchAll } from "@/lib/marketplace/search";
import { defaultSources } from "@/lib/marketplace/sources";
import { formatMoney, totalPrice, type Listing } from "@/lib/marketplace/types";
import type { Flag } from "@/lib/marketplace/anomaly";
import { signQuote, quoteSigningConfigured } from "@/lib/checkout/quote";
import { checkoutEligibility, priceCheckFor } from "@/lib/checkout/eligibility";
import { AddressStore } from "@/lib/checkout/address-store";
import { DecisionLog } from "@/lib/reports/reports";
import { VerifiedSellerLog, badgeFor, type BadgeView } from "@/lib/sellers/verified-log";
import { listingKey, sellerKey } from "@/lib/marketplace/types";
import { CHECKED_MEANS, bestCheckedDeals, checkLabel, describeSaving, type CheckLabel } from "@/lib/marketplace/label";

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

function ListingRow({
  listing,
  flags,
  checkout,
  badge,
  label,
}: {
  listing: Listing;
  flags: Flag[];
  checkout: CheckoutOffer;
  badge: BadgeView | null;
  label: CheckLabel;
}) {
  const total = totalPrice(listing);
  const shipping = listing.shipping?.amount ?? 0;
  const seller = listing.seller;

  return (
    <article className="listing" id={`l-${listingKey(listing)}`}>
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
          {badge && (
            // Earned, not reported: the seller proved control of this account,
            // holds the non-transferable token, and passed a live check. It
            // vouches for the account, not the item — so it removes no flag
            // and changes nothing about the price check or checkout.
            <>
              {" "}
              <a
                className="verified"
                href={`/seller/${encodeURIComponent(listing.source)}/${encodeURIComponent(seller.handle)}`}
                title="This seller proved control of the account and passed a live check. It vouches for the account, not this item."
              >
                &#10003; Verified seller
              </a>
            </>
          )}
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
        {/* One verdict per listing, every check underneath it. See lib/marketplace/label.ts. */}
        <div className={`check-label ${label.verdict}`}>
          <span className="check-head">
            {label.verdict === "checked" ? "✓ " : label.verdict === "caution" ? "! " : ""}
            {label.headline}
          </span>
          <ul>
            {label.points.map((p, i) => (
              <li key={i} className={p.tone}>
                {p.text}
              </li>
            ))}
          </ul>
        </div>
        {checkout && "token" in checkout && (
          // The price travels inside a server signature, so this link cannot
          // be edited into a cheaper order. See lib/checkout/quote.ts.
          <a className="pay" href={`/checkout?quote=${encodeURIComponent(checkout.token)}`}>
            Pay with USDC &rarr;
          </a>
        )}
        {checkout && "reason" in checkout && (
          // The label above already says why a listing isn't checked or what
          // was flagged; repeating it here would say the same thing twice.
          <p className="pay-blocked">
            {label.verdict === "checked" ? checkout.reason : "SigPath checkout is only offered on SigPath-checked listings."}
          </p>
        )}
        {flags.some((f) => f.kind === "upheld_reports") && (
          // Every finding is shown with the seller's own reply beside it — a
          // buyer judging this seller should see both sides, not just ours.
          <p className="pay-blocked">
            <a href={`/seller/${encodeURIComponent(listing.source)}/${encodeURIComponent(seller.handle)}`}>
              See the findings and the seller&apos;s response &rarr;
            </a>
          </p>
        )}
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
  searchParams: { q?: string; checked?: string };
}) {
  const q = (searchParams.q ?? "").trim().slice(0, 120);
  const checkedOnly = searchParams.checked === "1";
  // Upheld fake-product reports flag their seller's listings — and a flag
  // removes the pay button, so the same finding closes SigPath's checkout to them.
  const upheldReports = q ? await DecisionLog.fromEnv().upheldCounts() : new Map<string, number>();
  const result = q ? await searchAll(q, defaultSources(), { limit: 20 }, { upheldReports }) : null;
  const badgeEntries = q ? await VerifiedSellerLog.fromEnv().all() : {};

  const byListing = new Map<string, Flag[]>();
  for (const f of result?.analysis.flags ?? []) {
    // Keyed by marketplace AND id — ids are only unique within one marketplace.
    const k = listingKey({ source: f.source, id: f.listingId });
    byListing.set(k, [...(byListing.get(k) ?? []), f]);
  }
  const flagsOf = (l: Listing) => byListing.get(listingKey(l)) ?? [];

  const a = result?.analysis;
  const badgeOf = (l: Listing) => badgeFor(sellerKey(l.source, l.seller.handle), badgeEntries, upheldReports);
  const labels = new Map<string, CheckLabel>();
  for (const l of result?.listings ?? []) {
    if (a) labels.set(listingKey(l), checkLabel(l, flagsOf(l), priceCheckFor(l, a), a, badgeOf(l) !== null));
  }
  const labelOf = (l: Listing) => labels.get(listingKey(l))!;
  const deals = a ? bestCheckedDeals(result!.listings, labelOf, a) : [];
  const shown = (result?.listings ?? []).filter((l) => !checkedOnly || labelOf(l).verdict === "checked");
  const hiddenCount = (result?.listings.length ?? 0) - shown.length;
  const checkedCount = (result?.listings ?? []).filter((l) => labelOf(l).verdict === "checked").length;

  // Checkout is offered only when BOTH secrets exist: one to sign prices, one to
  // encrypt delivery addresses. Missing either, no listing gets a pay button.
  const checkoutReady = quoteSigningConfigured() && AddressStore.fromEnv() !== null;
  const checkoutOffer = (l: Listing, flags: Flag[]): CheckoutOffer => {
    if (!checkoutReady || !a) return null;
    const e = checkoutEligibility(l, flags, priceCheckFor(l, a));
    if (!e.eligible) return { reason: e.reason };
    const total = totalPrice(l);
    const token = signQuote({
      source: l.source,
      id: l.id,
      url: l.url,
      title: l.title,
      seller: l.seller.handle,
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
        {checkedOnly && <input type="hidden" name="checked" value="1" />}
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
              {/* New and used are compared separately, each against its own
                  median — so both are shown when both could be computed. */}
              {a.median !== undefined && (
                <>
                  Median price new {formatMoney({ amount: a.median, currency: a.currency! })} across{" "}
                  {a.sampleSize} listings
                </>
              )}
              {a.median !== undefined && a.used && "; "}
              {a.used && (
                <>
                  {a.median === undefined ? "Median price used " : "used "}
                  {formatMoney({ amount: a.used.median, currency: a.currency! })} across {a.used.sampleSize} listings
                </>
              )}
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

          {deals.length > 0 && (
            // The deal the shopper came for — restricted to listings that passed.
            <section className="best-deals">
              <h2>Best checked deal{deals.length > 1 ? "s" : ""}</h2>
              <ul>
                {deals.map((d) => (
                  <li key={d.group}>
                    <span className="deal-price">{formatMoney(d.total)}</span>{" "}
                    <span className="hint">{d.group === "used" ? "used" : "new"} &middot; {d.listing.source}</span>
                    <br />
                    <a href={`#l-${listingKey(d.listing)}`}>{d.listing.title}</a>
                    {describeSaving(d) && <span className="saving"> &mdash; {describeSaving(d)}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.listings.length > 0 && (
            <p className="hint label-explainer">
              {CHECKED_MEANS}{" "}
              {checkedOnly ? (
                <a href={`/search?q=${encodeURIComponent(q)}`}>Show all {result.listings.length} listings</a>
              ) : (
                checkedCount > 0 && (
                  <a href={`/search?q=${encodeURIComponent(q)}&checked=1`}>Show only the {checkedCount} checked</a>
                )
              )}
            </p>
          )}

          {result.listings.length === 0 ? (
            <p className="hint">No listings found for &ldquo;{q}&rdquo;.</p>
          ) : (
            <>
              {shown.map((l) => (
                <ListingRow
                  key={listingKey(l)}
                  listing={l}
                  flags={flagsOf(l)}
                  checkout={checkoutOffer(l, flagsOf(l))}
                  badge={badgeOf(l)}
                  label={labelOf(l)}
                />
              ))}
              {checkedOnly && hiddenCount > 0 && (
                <p className="hint">
                  {hiddenCount} listing{hiddenCount === 1 ? "" : "s"} hidden because {hiddenCount === 1 ? "it isn't" : "they aren't"} SigPath-checked.
                </p>
              )}
            </>
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
