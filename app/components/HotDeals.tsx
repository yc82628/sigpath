/**
 * "Selling fast on AliExpress" under the home page's search: the products
 * AliExpress reports selling most (lib/hot/hot-deals.ts), with their orders in
 * the last 30 days. Each opens SigPath's price check for it, so the shopper
 * sees it compared with eBay before buying. Streams in after the page; until
 * then, and without the AliExpress keys, the popular searches show instead.
 */

import Link from "next/link";
import { hotDeals } from "@/lib/hot/hot-deals";
import { AliExpressSource } from "@/lib/marketplace/sources/aliexpress";
import { formatMoney } from "@/lib/marketplace/types";
import { shortQuery } from "@/lib/marketplace/price-check";
import { getMessages } from "@/lib/i18n/server";
import { categoryHref } from "./catalog";

export function PopularSearches({ label, queries }: { label: string; queries: string[] }) {
  return (
    <ul className="hero-chips" aria-label={label}>
      {queries.map((p) => (
        <li key={p}>
          <Link href={categoryHref(p)}>{p}</Link>
        </li>
      ))}
    </ul>
  );
}

export default async function HotDeals({ fallback }: { fallback: React.ReactNode }) {
  const m = getMessages();
  const { deals } = await hotDeals({ fetch: () => new AliExpressSource().hotProducts(20) });
  if (!deals.length) return <>{fallback}</>;
  return (
    <section className="hot-deals" aria-labelledby="hot-title">
      <div className="hot-head">
        <h2 id="hot-title">{m.home.hotTitle}</h2>
        <p>{m.home.hotSub}</p>
      </div>
      <ul>
        {deals.map((d) => {
          // The price check, filled in: the product's name, its price and where it's from.
          const check = `/check?${new URLSearchParams({
            title: shortQuery(d.title) || d.title.slice(0, 80),
            price: `${(d.price.amount / 100).toFixed(2)} ${d.price.currency}`,
            from: "aliexpress",
            url: d.url,
          })}`;
          return (
            <li key={d.id}>
              <Link className="hot-card" href={check}>
                <span className="hot-photo">
                  {d.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- AliExpress's own product photo
                    <img src={d.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  )}
                </span>
                <span className="hot-text">
                  <span className="hot-title">{d.title}</span>
                  <span className="hot-price">{formatMoney(d.price)}</span>
                  <span className="hot-sold">{m.home.hotSold(d.sold)}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
