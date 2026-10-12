import { Suspense } from "react";
import { headers } from "next/headers";
import { limitedMessage, RULES } from "@/lib/guard/limit";
import { assembleSearch, startSearch } from "@/lib/marketplace/search";
import { defaultSources } from "@/lib/marketplace/sources";
import { formatMoney, totalPrice, type Listing, type SourceResult } from "@/lib/marketplace/types";
import type { Flag } from "@/lib/marketplace/anomaly";
import { signQuote, quoteSigningConfigured } from "@/lib/checkout/quote";
import { checkoutEligibility, priceCheckFor } from "@/lib/checkout/eligibility";
import { AddressStore } from "@/lib/checkout/address-store";
import { eurUsdRate, toUsdcBaseUnits } from "@/lib/checkout/fx";
import { formatFeeRate, serviceFeeBps, withServiceFee } from "@/lib/checkout/fee";
import { DecisionLog } from "@/lib/reports/reports";
import { VerifiedSellerLog, badgeFor, type BadgeView } from "@/lib/sellers/verified-log";
import { BusinessLog, businessIndex, verifiedPhotoFlags } from "@/lib/sellers/business";
import { listingKey, sellerKey } from "@/lib/marketplace/types";
import { describeSaving, labelSearch, type BusinessBadge, type CheckLabel } from "@/lib/marketplace/label";
import AlertButton from "../components/AlertButton";
import AddToCart from "../components/AddToCart";
import PopIcon from "../components/PopIcon";
import { QUOTE_TTL_SECONDS } from "@/lib/checkout/quote";
import { MARKETPLACES } from "@/lib/marketplace/registry";

const marketLabel = (id: string) =>
  MARKETPLACES.find((m) => m.id === id)?.label ?? (id === "stub" ? "Demo" : id === "feed" ? "Partner feeds" : id);

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
  not_configured: "not connected yet",
  rate_limited: "rate limited",
  timeout: "timed out",
  error: "failed",
};

/** Checkout offer for one listing: a signed quote, a reason there is none, or null when checkout is off. */
type CheckoutOffer = { token: string; usdc?: string } | { reason: string } | null;

/** "163.41 USDC": a preview rounded UP to the cent, so the checkout never shows more than this. */
function usdcPreview(baseUnits: bigint): string {
  return `${(Number((baseUnits + 9_999n) / 10_000n) / 100).toFixed(2)} USDC`;
}

function ListingRow({
  listing,
  flags,
  checkout,
  badge,
  business,
  label,
}: {
  listing: Listing;
  flags: Flag[];
  checkout: CheckoutOffer;
  badge: BadgeView | null;
  business: BusinessBadge | null;
  label: CheckLabel;
}) {
  const total = totalPrice(listing);
  const shipping = listing.shipping?.amount ?? 0;
  const seller = listing.seller;
  const warns = label.points.filter((p) => p.tone === "warn");
  const keyPoints = warns.length ? warns : label.points.slice(0, 1);
  const otherPoints = label.points.filter((p) => !keyPoints.includes(p));

  return (
    <article className="listing" id={`l-${listingKey(listing)}`}>
      <div className="thumb" aria-hidden="true">
        {listing.imageUrl ? (
          // The marketplace's own image, straight from its CDN. no-referrer: the
          // CDN learns an image was viewed, not which search on SigPath showed it.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={listing.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          marketLabel(listing.source).slice(0, 1)
        )}
      </div>
      <div className="body">
        <h3>
          {/* noreferrer as well as noopener: the destination has no business
              knowing which search sent the buyer there. */}
          <a href={listing.url} target="_blank" rel={listing.affiliate ? "sponsored noopener noreferrer" : "noopener noreferrer"}>
            {listing.title}
          </a>
        </h3>
        <p className="meta">
          <span className="chip">{marketLabel(listing.source)}</span> {listing.condition} &middot;{" "}
          {seller.displayName ?? seller.handle}
          {business ? (
            // The business tier: a VAT number checked against the EU register,
            // and every account its wallet verified. Like the seller badge, it
            // vouches for who runs the account, not the item.
            <>
              {" "}
              <a className="verified business" href={`/business/${encodeURIComponent(business.id)}`} title="A registered business, checked against the EU VAT register. It vouches for who runs the account, not this item.">
                &#10003; Verified business
              </a>
            </>
          ) : badge && (
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
          {/* The verdict, then only what matters: every red flag, or else the main reason. The rest folds away. */}
          <ul>
            {keyPoints.map((p, i) => (
              <li key={i} className={p.tone}>
                {p.text}
              </li>
            ))}
          </ul>
          {otherPoints.length > 0 && (
            <details className="check-more">
              <summary>How it was checked</summary>
              <ul>
                {otherPoints.map((p, i) => (
                  <li key={i} className={p.tone}>
                    {p.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        {checkout && "token" in checkout && (
          // The price travels inside a server signature, so this link cannot
          // be edited into a cheaper order. See lib/checkout/quote.ts.
          <a className="pay" href={`/checkout?quote=${encodeURIComponent(checkout.token)}`}>
            Pay with USDC{checkout.usdc && <span className="pay-amount"> · {checkout.usdc}</span>} &rarr;
          </a>
        )}
        {checkout && "reason" in checkout && label.verdict === "checked" && (
          // Unchecked or flagged: the verdict above already says why there's no pay button.
          <p className="pay-blocked">{checkout.reason}</p>
        )}
        {/* The cart keeps a snapshot in this browser and asks for the price again when opened (lib/cart/cart.ts). */}
        <AddToCart
          item={{
            key: listingKey(listing),
            source: listing.source,
            id: listing.id,
            title: listing.title,
            url: listing.url,
            imageUrl: listing.imageUrl,
            condition: listing.condition,
            seller: seller.displayName ?? seller.handle,
            price: listing.price,
            shipping: listing.shipping,
            verdict: label.verdict,
            headline: label.headline,
            quote:
              checkout && "token" in checkout
                ? { token: checkout.token, usdc: checkout.usdc, expiresAt: Date.now() + QUOTE_TTL_SECONDS * 1000 }
                : undefined,
          }}
        >
          <PopIcon name="shopping-cart-simple" tone="blue" size={18} />
        </AddToCart>
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
  // Public by design: browsers need it to subscribe. Alerts are offered only when it's set.
  const vapidKey = process.env.VAPID_PUBLIC_KEY?.trim() || null;

  // STREAMING. Every marketplace is asked NOW, once. The page shell goes out
  // immediately; each marketplace's listings stream in as it answers, marked
  // "checking"; and when the last one is in, the fully checked results replace
  // them. Verdicts are only ever drawn from the complete set — a price compared
  // against half the marketplaces is exactly the biased comparison this design
  // refuses — so nothing streamed early carries a verdict or a pay button.
  // Every search is an eBay call against the site's daily quota: a script gets a pause, not the quota.
  const tooMany = q ? await limitedMessage(headers(), RULES.search) : null;
  const sources = q && !tooMany ? defaultSources() : [];
  const pending = q && !tooMany ? startSearch(q, sources, { limit: 20 }) : [];

  return (
    <main className="container wide">
      <h1>Compare every marketplace</h1>
      <p className="lede">One search, every deal checked.</p>

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
      <p className="hint">Nothing about your search is stored.</p>

      {tooMany && <p className="notice withheld">{tooMany}</p>}
      {q && !tooMany && (
        <Suspense key={`${q}|${checkedOnly}`} fallback={<SearchProgress ids={sources.map((s) => s.id)} pending={pending} />}>
          <SearchResults q={q} checkedOnly={checkedOnly} vapidKey={vapidKey} pending={pending} />
        </Suspense>
      )}
    </main>
  );
}

/** While marketplaces are still answering: what has arrived so far, with no verdicts yet. */
function SearchProgress({ ids, pending }: { ids: string[]; pending: Promise<SourceResult>[] }) {
  return (
    <section className="progress" aria-live="polite" aria-busy="true">
      <p className="notice">
        <span className="spinner" aria-hidden="true" /> Searching and checking&hellip;
      </p>
      {ids.map((id, i) => (
        <Suspense
          key={id}
          fallback={
            <p className="progress-source">
              <span className="chip">{marketLabel(id)}</span> <span className="hint">searching&hellip;</span>
            </p>
          }
        >
          <SourceProgress result={pending[i]} />
        </Suspense>
      ))}
    </section>
  );
}

async function SourceProgress({ result }: { result: Promise<SourceResult> }) {
  const r = await result;
  if (r.status === "not_configured") return null;
  if (r.status !== "ok") {
    return (
      <p className="progress-source">
        <span className="chip">{marketLabel(r.source)}</span> <span className="hint">{STATUS_LABEL[r.status] ?? r.status}</span>
      </p>
    );
  }
  return (
    <div className="progress-source">
      <p>
        <span className="chip">{marketLabel(r.source)}</span>{" "}
        <span className="hint">
          {r.listings.length} listing{r.listings.length === 1 ? "" : "s"} &middot; checking&hellip;
        </span>
      </p>
      {[...r.listings]
        .sort((x, y) => totalPrice(x).amount - totalPrice(y).amount)
        .slice(0, 3)
        .map((l) => (
          <article key={listingKey(l)} className="listing provisional">
            <div className="thumb" aria-hidden="true">
              {l.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                marketLabel(l.source).slice(0, 1)
              )}
            </div>
            <div className="body">
              <h3>{l.title}</h3>
              <div className="check-label pending">
                <span className="check-head">Checking&hellip;</span>
              </div>
            </div>
            <div className="price">{formatMoney(totalPrice(l))}</div>
          </article>
        ))}
    </div>
  );
}

/** Once EVERY marketplace has answered: the checked results. */
async function SearchResults({
  q,
  checkedOnly,
  vapidKey,
  pending,
}: {
  q: string;
  checkedOnly: boolean;
  vapidKey: string | null;
  pending: Promise<SourceResult>[];
}) {
  // Upheld fake-product reports flag their seller's listings — and a flag
  // removes the pay button, so the same finding closes SigPath's checkout to them.
  // Read while the marketplaces answer: each is a round trip to the database.
  const [upheldReports, badgeEntries, businessEntries, answered] = await Promise.all([
    DecisionLog.fromEnv().upheldCounts(),
    VerifiedSellerLog.fromEnv().all(),
    BusinessLog.fromEnv().all(),
    Promise.all(pending),
  ]);
  const result = assembleSearch(q, answered, { limit: 20 }, { upheldReports });
  const businesses = businessIndex(businessEntries, badgeEntries, upheldReports);
  // Same as labelledSearch: a verified business's photo under an unlinked account on another marketplace.
  result.analysis = { ...result.analysis, flags: [...result.analysis.flags, ...verifiedPhotoFlags(result.listings, businesses)] };
  const businessOf = (l: Listing) => businesses.get(sellerKey(l.source, l.seller.handle)) ?? null;

  const a = result.analysis;
  const badgeOf = (l: Listing) => badgeFor(sellerKey(l.source, l.seller.handle), badgeEntries, upheldReports);
  // Flags grouped by marketplace AND id, one verdict per listing, the best checked deals.
  const labelled = result ? labelSearch(result, (l) => badgeOf(l) !== null, businessOf) : null;
  const flagsOf = (l: Listing) => labelled?.flagsOf(l) ?? [];
  const labelOf = (l: Listing) => labelled!.labelOf(l);
  const deals = labelled?.deals ?? [];
  const shown = (result?.listings ?? []).filter((l) => !checkedOnly || labelOf(l).verdict === "checked");
  const hiddenCount = (result?.listings.length ?? 0) - shown.length;
  const checkedCount = (result?.listings ?? []).filter((l) => labelOf(l).verdict === "checked").length;

  // Checkout is offered only when BOTH secrets exist: one to sign prices, one to
  // encrypt delivery addresses. Missing either, no listing gets a pay button.
  const checkoutReady = quoteSigningConfigured() && AddressStore.fromEnv() !== null;
  // The conversion shown on each pay button: the same ECB rate and service fee
  // the checkout charges. One rate fetch per page (it is cached), and none if
  // checkout is off. No rate: the button simply shows no amount.
  const feeBps = serviceFeeBps();
  const rate = checkoutReady ? await eurUsdRate().catch(() => null) : null;
  const usdcFor = (amount: number, currency: string) => {
    const item = toUsdcBaseUnits(amount, currency, currency.toUpperCase() === "USD" ? null : rate);
    return item === null ? undefined : usdcPreview(withServiceFee(item, feeBps).total);
  };
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
    return token ? { token, usdc: usdcFor(total.amount, total.currency) } : null;
  };

  return (
    <>
      {/* Which marketplaces this answer actually rests on. */}
      <ul className="coverage">
        {/* Only marketplaces that were searched: a list of what isn't connected yet is noise. */}
        {result.sources.filter((s) => s.status !== "not_configured").map((s) => (
          <li
            key={s.source}
            className={
              s.status === "ok" ? "ok" : s.status === "not_configured" ? "" : "degraded"
            }
            title={s.detail ?? ""}
          >
            {marketLabel(s.source)}: {STATUS_LABEL[s.status] ?? s.status}
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
          {/* Real marketplaces and the demo feed are never pooled: say which one the median is from. */}
          {a.medianScope
            ? ` ${a.medianScope}`
            : a.coverage.length > 1
              ? ` on ${a.coverage.length} marketplaces`
              : ` on ${a.coverage[0] === "stub" ? "the demo feed" : marketLabel(a.coverage[0])}`}
          .
          {a.excludedFromComparison.length > 0 && (
            // Says why a cheap listing from these carries no price flag.
            <> Not price-compared: {a.excludedFromComparison.map(marketLabel).join(", ")}.</>
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
                <span className="chip">{marketLabel(d.listing.source)}</span>{" "}
                <span className="hint">{d.group === "used" ? "used" : "new"}</span>
                <br />
                <a href={`#l-${listingKey(d.listing)}`}>{d.listing.title}</a>
                {describeSaving(d) && <span className="saving"> &mdash; {describeSaving(d)}</span>}
                {vapidKey && <AlertButton query={q} group={d.group} current={d.total} vapidKey={vapidKey} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.listings.length > 0 && (
        <p className="hint label-explainer">
          {/* The full definition is in the API (CHECKED_MEANS); one line here. */}
          ✓ Checked: priced against identical listings, no red flags. Not a guarantee.{" "}
          {checkedOnly ? (
            <a href={`/search?q=${encodeURIComponent(q)}`}>Show all {result.listings.length} listings</a>
          ) : (
            checkedCount > 0 && (
              <a href={`/search?q=${encodeURIComponent(q)}&checked=1`}>Show only the {checkedCount} checked</a>
            )
          )}
        </p>
      )}
      {checkoutReady && rate && result.listings.length > 0 && (
        <p className="hint">
          USDC at {rate.display} USD/EUR ({rate.source}), incl. {formatFeeRate(feeBps)} fee.
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
              business={businessOf(l)}
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
          <p className="hint">Not part of the comparison.</p>
          <ul>
            {result.linkOut.map((t) => (
              <li key={t.id}>
                <a href={t.url} target="_blank" rel={t.affiliate ? "sponsored noopener noreferrer" : "noopener noreferrer"}>
                  {t.label} &rarr;
                </a>
                {t.note && <span className="hint"> {t.note}</span>}
              </li>
            ))}
          </ul>
          {result.linkOut.some((t) => t.affiliate) && (
            // Amazon requires this disclosure wherever an Associates link appears.
            <p className="hint affiliate-note">
              As an Amazon Associate, SigPath earns from qualifying purchases (Als Amazon-Partner verdient SigPath an
              qualifizierten Verkäufen).
            </p>
          )}
        </section>
      )}
    </>
  );
}
