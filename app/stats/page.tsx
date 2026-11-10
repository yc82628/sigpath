import Link from "next/link";
import { getLang } from "@/lib/i18n/server";
import { countedSince, EVENTS, readStats, totalOf, type StatEvent } from "@/lib/stats/counter";
import { ON_DEVNET, proof } from "@/lib/proof/ledger";

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
    "inflated-discount": "Inflated discounts the extension caught",
    click: "Search results opened",
    "judged-checked": "Offers SigPath-checked",
    "judged-caution": "Offers flagged “look closer”",
    "judged-unchecked": "Offers that couldn't be checked",
  } as Record<StatEvent, string>,
  outcomeTitle: "How the checks come out",
  outcomeLede: (n: string) => `Of the ${n} offers in searches over the last 30 days:`,
  outcomeNone: "Not counted yet: this starts with the next searches.",
  pct: (p: string) => `${p}%`,
  proofTitle: "What happened after",
  proofLine: (fulfilled: number, refunded: number, findings: number) =>
    `Escrow orders: ${fulfilled} fulfilled, ${refunded} refunded. Fake-product reports upheld against sellers: ${findings}.`,
  devnet: "These are test orders on Solana devnet, not real sales.",
  proofLink: "Every order and finding, on Solana →",
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
    "inflated-discount": "Aufgeblähte Rabatte, von der Erweiterung erkannt",
    click: "Geöffnete Suchergebnisse",
    "judged-checked": "Angebote, von SigPath geprüft",
    "judged-caution": "Angebote mit „Genauer hinsehen“",
    "judged-unchecked": "Angebote, die nicht geprüft werden konnten",
  },
  outcomeTitle: "Wie die Prüfungen ausgehen",
  outcomeLede: (n) => `Von den ${n} Angeboten in Suchen der letzten 30 Tage:`,
  outcomeNone: "Noch nicht gezählt: Das beginnt mit den nächsten Suchen.",
  pct: (p) => `${p} %`,
  proofTitle: "Was danach passiert ist",
  proofLine: (fulfilled, refunded, findings) =>
    `Treuhand-Bestellungen: ${fulfilled} erfüllt, ${refunded} erstattet. Bestätigte Fälschungsmeldungen gegen Verkäufer: ${findings}.`,
  devnet: "Das sind Testbestellungen im Solana-Devnet, keine echten Verkäufe.",
  proofLink: "Jede Bestellung und jeder Befund, auf Solana →",
  since: (d) => `Gezählt seit ${d}. Die Tage laufen nach Berliner Zeit.`,
  none: "Noch nichts gezählt.",
  off: "Die Zählung ist auf diesem Server nicht eingerichtet.",
  how: "Was gezählt wird und was nicht →",
};

export default async function StatsPage() {
  const lang = getLang();
  const t = lang === "de" ? de : en;
  const [days, first, chain] = await Promise.all([readStats(30).catch(() => null), countedSince().catch(() => null), proof().catch(() => null)]);
  // The usage table; how offers were judged gets its own section below.
  const TABLE = EVENTS.filter((e) => !e.startsWith("judged-"));
  const month = days ? totalOf(days, 30) : null;
  const judged = month ? month["judged-checked"] + month["judged-caution"] + month["judged-unchecked"] : 0;
  const share = (x: number) => (judged ? ((x / judged) * 100).toLocaleString(lang === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: 1 }) : "0");
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
                {TABLE.map((e) => (
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

          {/* The verdicts SigPath gave, in proportion: what "checked" means in practice. */}
          <h2>{t.outcomeTitle}</h2>
          {judged > 0 && month ? (
            <>
              <p>{t.outcomeLede(n(judged))}</p>
              <ul className="stats-shares">
                {(["judged-checked", "judged-caution", "judged-unchecked"] as const).map((e) => (
                  <li key={e} className={e}>
                    <b>{t.pct(share(month[e]))}</b> {t.labels[e]}
                    <span className="stats-bar" aria-hidden="true">
                      <i style={{ width: `${(month[e] / judged) * 100}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="hint">{t.outcomeNone}</p>
          )}
        </>
      )}

      {chain && (
        <>
          <h2>{t.proofTitle}</h2>
          <p>{t.proofLine(chain.orders.fulfilled, chain.orders.refunded, chain.findings.length)}</p>
          {ON_DEVNET && <p className="hint">{t.devnet}</p>}
          <p>
            <Link href="/proof">{t.proofLink}</Link>
          </p>
        </>
      )}
      <p>
        <Link href="/privacy#stats">{t.how}</Link>
      </p>
    </main>
  );
}
