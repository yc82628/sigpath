import Link from "next/link";
import { checkReportable } from "@/lib/reports/reports";
import { reportDepsFromEnv } from "@/lib/reports/evidence";
import { getLang } from "@/lib/i18n/server";
import ReportForm from "./ReportForm";

/**
 * app/report/[order]/page.tsx — report a fake product from a SigPath order.
 *
 * Public URL, so it shows nothing about WHAT was bought — the buyer knows,
 * and anyone else with the order address has no business learning it. The
 * eligibility check here is a courtesy (so a buyer isn't asked to sign for an
 * order that can't be reported); every rule is enforced again by the API.
 */

export const dynamic = "force-dynamic";

const en = {
  title: "Report a fake product",
  lede: "If what arrived isn't what was listed, tell us. Reports come only from buyers who paid, with a live photo of the item — and a reviewer decides before anything happens to the seller.",
  notConfigured: "Reporting isn't configured on this server.",
  next: "What happens next",
  steps: [
    "Your report goes to a reviewer. Nothing is public while it's pending.",
    "If it's upheld, the seller is flagged on every SigPath search, SigPath stops buying from them, and the finding is recorded on Solana where any app can read it.",
  ],
  replyA: "The seller is told about the report and gets ",
  replyStrong: "7 days to reply",
  replyB: " before it can be upheld. They'll see your description of the problem — never your photo or your wallet — so write it about the item, not about yourself.",
  deleted: "Your photo, words and wallet are deleted as soon as it's decided. The public record names the seller, never you.",
  back: "Back to the order",
  /** lib/reports/reports.ts gives its reasons in English. */
  error: (e: string) => e,
};
const de: typeof en = {
  title: "Ein gefälschtes Produkt melden",
  lede: "Ist nicht angekommen, was angeboten wurde? Sag es uns. Meldungen kommen nur von Käufern, die bezahlt haben, mit einem Live-Foto des Artikels, und eine prüfende Person entscheidet, bevor dem Verkäufer etwas passiert.",
  notConfigured: "Meldungen sind auf diesem Server nicht eingerichtet.",
  next: "So geht es weiter",
  steps: [
    "Deine Meldung geht an eine prüfende Person. Solange sie offen ist, ist nichts öffentlich.",
    "Wird sie bestätigt, wird der Verkäufer in jeder SigPath-Suche markiert, SigPath kauft nicht mehr bei ihm, und der Befund wird auf Solana festgehalten, wo jede App ihn lesen kann.",
  ],
  replyA: "Der Verkäufer erfährt von der Meldung und hat ",
  replyStrong: "7 Tage Zeit zu antworten",
  replyB: ", bevor sie bestätigt werden kann. Er sieht deine Beschreibung des Problems, nie dein Foto oder deine Wallet: Schreib also über den Artikel, nicht über dich.",
  deleted: "Dein Foto, deine Worte und deine Wallet werden gelöscht, sobald entschieden ist. Der öffentliche Eintrag nennt den Verkäufer, nie dich.",
  back: "Zurück zur Bestellung",
  error: (e) =>
    ({
      "Invalid order address.": "Ungültige Bestelladresse.",
      "That isn't a SigPath order.": "Das ist keine SigPath-Bestellung.",
      "No such order.": "Diese Bestellung gibt es nicht.",
      "This order hasn't been fulfilled yet — if it never arrives, the escrow refunds you.":
        "Diese Bestellung ist noch nicht erfüllt. Kommt sie nie an, erstattet dir die Treuhand das Geld.",
      "This order was refunded, so there is nothing to report.": "Diese Bestellung wurde erstattet, es gibt also nichts zu melden.",
      "Only the wallet that paid for this order can report it.": "Nur die Wallet, die diese Bestellung bezahlt hat, kann sie melden.",
      "The 30-day window for reporting this order has closed.": "Die 30-Tage-Frist für eine Meldung zu dieser Bestellung ist abgelaufen.",
      "This order has already been reported.": "Diese Bestellung wurde bereits gemeldet.",
      "SigPath has no record of who sold this order, so it can't be reported.":
        "SigPath weiß nicht, wer diese Bestellung verkauft hat, daher kann sie nicht gemeldet werden.",
    })[e] ?? e,
};

export default async function ReportPage({ params }: { params: { order: string } }) {
  const t = getLang() === "de" ? de : en;
  const deps = reportDepsFromEnv();
  const check = deps ? await checkReportable(params.order, null, deps) : ({ ok: false, error: t.notConfigured } as const);

  return (
    <main className="container">
      <h1>{t.title}</h1>
      <p className="lede">{t.lede}</p>

      {!check.ok ? (
        <p className="notice withheld">{t.error(check.error)}</p>
      ) : (
        <>
          <section className="guarantees">
            <h2>{t.next}</h2>
            <ul>
              {t.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
              <li>
                {t.replyA}
                <strong>{t.replyStrong}</strong>
                {t.replyB}
              </li>
              <li>{t.deleted}</li>
            </ul>
          </section>
          <ReportForm order={params.order} />
        </>
      )}

      <p className="hint" style={{ marginTop: 24 }}>
        <Link href={`/order/${params.order}`}>{t.back}</Link>
      </p>
    </main>
  );
}
