import Link from "next/link";
import { getLang } from "@/lib/i18n/server";
import { countedSince, EVENTS, readStats, totalOf, type StatEvent } from "@/lib/stats/counter";

/**
 * app/stats — how much SigPath is used, in public.
 *
 * Totals only, as lib/stats/counter.ts keeps them: one number per event per
 * day, nothing about who. Public because the same numbers are what SigPath
 * would show anyone deciding about it, and a count anyone can see is one that
 * can't quietly be made to look better. Not linked from the menu.
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return { title: getLang() === "de" ? "Nutzung in Zahlen — SigPath" : "Usage in numbers — SigPath" };
}

const en = {
  title: "Usage in numbers",
  lede: "How much SigPath is used, counted without knowing by whom: one total per day, nothing else.",
  event: "What",
  today: "Today",
  week: "7 days",
  month: "30 days",
  labels: {
    search: "Searches on the site",
    check: "Price checks on the site",
    "ext-shop": "Extension checks on shop pages",
    "ext-ebay": "Extension checks on eBay listings",
    "good-deal": "Good deals the extension showed",
    caution: "Warnings the extension showed",
    click: "Search results opened",
  } as Record<StatEvent, string>,
  since: (d: string) => `Counted since ${d}. Days run on Berlin time.`,
  none: "Nothing counted yet.",
  off: "Counting isn't set up on this server.",
  how: "What is counted, and what isn't →",
};

const de: typeof en = {
  title: "Nutzung in Zahlen",
  lede: "Wie viel SigPath genutzt wird, gezählt ohne zu wissen, von wem: eine Summe pro Tag, sonst nichts.",
  event: "Was",
  today: "Heute",
  week: "7 Tage",
  month: "30 Tage",
  labels: {
    search: "Suchen auf der Website",
    check: "Preisprüfungen auf der Website",
    "ext-shop": "Prüfungen der Erweiterung in Shops",
    "ext-ebay": "Prüfungen der Erweiterung auf eBay-Angeboten",
    "good-deal": "Gute Angebote, von der Erweiterung gezeigt",
    caution: "Warnungen, von der Erweiterung gezeigt",
    click: "Geöffnete Suchergebnisse",
  },
  since: (d) => `Gezählt seit ${d}. Die Tage laufen nach Berliner Zeit.`,
  none: "Noch nichts gezählt.",
  off: "Die Zählung ist auf diesem Server nicht eingerichtet.",
  how: "Was gezählt wird und was nicht →",
};

export default async function StatsPage() {
  const lang = getLang();
  const t = lang === "de" ? de : en;
  const [days, first] = await Promise.all([readStats(30).catch(() => null), countedSince().catch(() => null)]);
  const n = (x: number) => x.toLocaleString(lang === "de" ? "de-DE" : "en-GB");
  const sinceText = first ? new Date(`${first}T12:00:00Z`).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "long", year: "numeric" }) : null;

  return (
    <main className="container">
      <h1>{t.title}</h1>
      <p className="lede">{t.lede}</p>
      {!days ? (
        <p className="notice">{t.off}</p>
      ) : (
        <>
          <div className="invoice-table-wrap">
            <table className="invoice-table">
              <thead>
                <tr>
                  <th scope="col">{t.event}</th>
                  <th scope="col" className="num">{t.today}</th>
                  <th scope="col" className="num">{t.week}</th>
                  <th scope="col" className="num">{t.month}</th>
                </tr>
              </thead>
              <tbody>
                {EVENTS.map((e) => (
                  <tr key={e}>
                    <th scope="row">{t.labels[e]}</th>
                    <td className="num">{n(totalOf(days, 1)[e])}</td>
                    <td className="num">{n(totalOf(days, 7)[e])}</td>
                    <td className="num">{n(totalOf(days, 30)[e])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">{sinceText ? t.since(sinceText) : t.none}</p>
        </>
      )}
      <p>
        <Link href="/privacy#stats">{t.how}</Link>
      </p>
    </main>
  );
}
