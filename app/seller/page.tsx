import Link from "next/link";
import PopIcon from "../components/PopIcon";
import type { IconName } from "../components/icon-paths";
import { proof } from "@/lib/proof/ledger";
import { getLang } from "@/lib/i18n/server";

/**
 * app/seller — the rules for sellers, before anything happens to one.
 *
 * Deterrence works only if it's known in advance. This page says plainly what an
 * honest seller gets from SigPath (a badge, a fair comparison, a right of reply)
 * and what a seller who ships a fake gets: a finding on Solana under their
 * handle, for good. Each step matches what the code does (lib/reports,
 * lib/chains/solana/sas-reports.ts); the count at the bottom is read from Solana.
 * In English and German.
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return { title: getLang() === "de" ? "Die Regeln für Verkäufer — SigPath" : "The rules for sellers — SigPath" };
}

type Item = { icon: IconName; title: string; line: string };

const en = {
  title: "The rules for sellers",
  lede: "SigPath checks every listing before a shopper buys. Honest sellers stand out. Sellers who ship fakes get a record that follows them to every shop.",
  honestTitle: "Sell honestly",
  honest: [
    { icon: "seal-check", title: "A verified-seller badge", line: "Prove the account is yours with a live check, and get a badge beside your listings on every SigPath search. It's a token on Solana that can't be bought, sold or passed on." },
    { icon: "tag", title: "A fair comparison", line: "A price in line with identical listings is marked SigPath-checked. Only a price far below the market raises a flag." },
    { icon: "shield-check", title: "Protection from rivals", line: "Only the wallet that paid for an order can report it, once, within 30 days, with a live photo of the item. A rival would have to buy from you first, and a reviewer still decides." },
    { icon: "gavel", title: "A right of reply", line: "You hear about every report and get 7 days to answer before a reviewer decides. Your reply is published with any finding, and you can appeal." },
  ] as Item[],
  fakeTitle: "Ship a fake",
  steps: [
    { title: "The buyer reports it", line: "With a live photo of what arrived, beside a code issued on the spot, so an old photo won't do." },
    { title: "You get 7 days", line: "To reply. A reviewer reads both sides." },
    { title: "The finding is upheld", line: "And written to Solana under your handle." },
  ],
  thenTitle: "From then on",
  then: [
    "Every SigPath search flags your listings.",
    "SigPath stops buying from you: its checkout closes to your listings.",
    "Your verified-seller badge is burned.",
    "Any other shop, wallet or app can read the finding from your handle alone, without asking SigPath.",
    "It never expires. A finding that's reversed is marked reversed, never deleted.",
  ],
  live: (n: number) => `${n} finding${n === 1 ? "" : "s"} on record on Solana`,
  liveLink: "See the record →",
  ctaTitle: "Start on the right side",
  verify: "Become a verified seller",
  business: "Verify your business",
  how: "How SigPath checks listings",
};

const de: typeof en = {
  title: "Die Regeln für Verkäufer",
  lede: "SigPath prüft jedes Angebot, bevor jemand kauft. Ehrliche Verkäufer fallen positiv auf. Wer Fälschungen verschickt, bekommt einen Eintrag, der ihm in jeden Shop folgt.",
  honestTitle: "Ehrlich verkaufen",
  honest: [
    { icon: "seal-check", title: "Ein Abzeichen als verifizierter Verkäufer", line: "Weise mit einer Live-Prüfung nach, dass das Konto dir gehört, und erhalte ein Abzeichen neben deinen Angeboten in jeder SigPath-Suche. Es ist ein Token auf Solana, das man nicht kaufen, verkaufen oder weitergeben kann." },
    { icon: "tag", title: "Ein fairer Vergleich", line: "Ein Preis im Rahmen identischer Angebote wird als von SigPath geprüft markiert. Nur ein Preis weit unter dem Markt löst eine Warnung aus." },
    { icon: "shield-check", title: "Schutz vor Konkurrenten", line: "Nur die Wallet, die eine Bestellung bezahlt hat, kann sie melden, einmal, innerhalb von 30 Tagen, mit einem Live-Foto des Artikels. Ein Konkurrent müsste erst bei dir kaufen, und eine prüfende Person entscheidet trotzdem." },
    { icon: "gavel", title: "Ein Recht auf Antwort", line: "Du erfährst von jeder Meldung und hast 7 Tage Zeit zu antworten, bevor eine prüfende Person entscheidet. Deine Antwort wird mit jedem Befund veröffentlicht, und du kannst Einspruch einlegen." },
  ],
  fakeTitle: "Eine Fälschung verschicken",
  steps: [
    { title: "Der Käufer meldet es", line: "Mit einem Live-Foto der Ware neben einem Code, der vor Ort erzeugt wird, damit ein altes Foto nicht reicht." },
    { title: "Du hast 7 Tage", line: "Zum Antworten. Eine prüfende Person liest beide Seiten." },
    { title: "Der Befund wird bestätigt", line: "Und auf Solana unter deinem Namen festgehalten." },
  ],
  thenTitle: "Ab dann",
  then: [
    "Jede SigPath-Suche markiert deine Angebote.",
    "SigPath kauft nicht mehr bei dir: Der Checkout ist für deine Angebote geschlossen.",
    "Dein Abzeichen als verifizierter Verkäufer wird vernichtet.",
    "Jeder andere Shop, jede Wallet und jede App kann den Befund allein anhand deines Namens lesen, ohne SigPath zu fragen.",
    "Er läuft nie ab. Ein aufgehobener Befund wird als aufgehoben markiert, nie gelöscht.",
  ],
  live: (n) => `${n} ${n === 1 ? "Befund" : "Befunde"} auf Solana festgehalten`,
  liveLink: "Zu den Einträgen →",
  ctaTitle: "Auf der richtigen Seite anfangen",
  verify: "Verifizierter Verkäufer werden",
  business: "Dein Unternehmen verifizieren",
  how: "So prüft SigPath Angebote",
};

export default async function SellerRules() {
  const t = getLang() === "de" ? de : en;
  const p = await proof();
  return (
    <main className="container seller-rules">
      <h1>{t.title}</h1>
      <p className="lede">{t.lede}</p>

      <div className="rules-split">
        <section className="rules-honest" aria-labelledby="honest">
          <h2 id="honest">{t.honestTitle}</h2>
          <ul className="proof-rules">
            {t.honest.map((h) => (
              <li key={h.title}>
                <span className="promise-icon">
                  <PopIcon name={h.icon} tone="green" size={22} />
                </span>
                <span>
                  <strong>{h.title}</strong>
                  <span>{h.line}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rules-fake" aria-labelledby="fake">
          <h2 id="fake">{t.fakeTitle}</h2>
          <ol className="qs-steps rules-steps">
            {t.steps.map((s, i) => (
              <li key={s.title}>
                <span className="qs-num">{i + 1}</span>
                <strong>{s.title}</strong>
                <span>{s.line}</span>
              </li>
            ))}
          </ol>
          <h3>{t.thenTitle}</h3>
          <ul className="proof-never">
            {t.then.map((x) => (
              <li key={x}>
                <PopIcon name="prohibit" tone="purple" size={20} />
                <span>{x}</span>
              </li>
            ))}
          </ul>
          {p && (
            <p className="proof-strip">
              <span className="proof-live">
                <i aria-hidden="true" />
                {t.live(p.findings.length)}
              </span>
              <Link href="/proof">{t.liveLink}</Link>
            </p>
          )}
        </section>
      </div>

      <h2>{t.ctaTitle}</h2>
      <p className="diff-links">
        <Link className="button" href="/seller/verify">
          {t.verify}
        </Link>
        <Link href="/seller/business">{t.business}</Link>
        <Link href="/how">{t.how}</Link>
      </p>
    </main>
  );
}
