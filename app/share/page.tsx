import { redirect } from "next/navigation";
import { getLang } from "@/lib/i18n/server";
import { MESSAGES } from "@/lib/i18n/messages";
import { queryFromShare } from "@/lib/marketplace/share-query";

/**
 * app/share — where Android's share menu sends a product (app/manifest.ts).
 *
 * Shared from the Amazon or eBay app, or from a shop's page in Chrome: the
 * product's name is read from what was shared (share-query.ts) and searched on
 * every marketplace, with a check on every offer. The shared link is never
 * opened. When nothing names a product, the shopper types it in.
 */

export const dynamic = "force-dynamic";
export const metadata = { title: "Check a shared product — SigPath", robots: { index: false } };

export default function SharePage({ searchParams }: { searchParams: { title?: string; text?: string; url?: string } }) {
  const q = queryFromShare({ title: searchParams.title, text: searchParams.text, url: searchParams.url });
  if (q) redirect(`/search?q=${encodeURIComponent(q.query)}${q.shop ? `&link=${encodeURIComponent(q.shop)}` : ""}`);

  const lang = getLang();
  const m = MESSAGES[lang];
  return (
    <main className="container">
      <h1>{lang === "de" ? "Geteiltes Produkt prüfen" : "Check a shared product"}</h1>
      <p className="notice withheld">
        {lang === "de"
          ? "Im Geteilten hat SigPath keinen Produktnamen gefunden. Gib ihn hier ein:"
          : "SigPath couldn't find a product's name in what was shared. Type it in here:"}
      </p>
      <form className="searchbar" method="GET" action="/search">
        <input type="search" name="q" placeholder={m.search.placeholder} aria-label={m.home.searchLabel} autoFocus />
        <button type="submit">{m.home.searchButton}</button>
      </form>
    </main>
  );
}
