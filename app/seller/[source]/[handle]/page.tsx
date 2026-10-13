import Link from "next/link";
import { publicFindings } from "@/lib/reports/seller";
import { DecisionLog } from "@/lib/reports/reports";
import { CaseLog } from "@/lib/reports/cases";
import { sellerKey } from "@/lib/marketplace/types";
import { VerifiedSellerLog, badgeFor } from "@/lib/sellers/verified-log";
import { sellerSubject } from "@/lib/sellers/badges";
import { sasConfigFromEnv, signer } from "@/lib/chains/solana/sas";
import { readVerifiedSeller, type OnChainBadge } from "@/lib/chains/solana/sas-verified";
import { BusinessLog, businessIndex } from "@/lib/sellers/business";
import { getLang } from "@/lib/i18n/server";
import { sellerFindingsOnChain } from "@/lib/chains/solana/sas-reports";
import { ISSUER } from "@/lib/proof/ledger";
import { SOLANA_RPC_URL } from "@/lib/config";

/**
 * app/seller/[source]/[handle] — the public record of a seller.
 *
 * Only upheld findings appear — never pending reports — and every one is shown
 * with the seller's own reply and appeal beside it. A finding reversed on
 * appeal stays listed, marked reversed: the record shows that a mistake was
 * made and corrected, rather than quietly disappearing it. In English and German.
 */

export const dynamic = "force-dynamic";

const en = {
  category: { counterfeit: "Item reported as not genuine", not_as_described: "Item materially different from the listing" },
  on: "on",
  verified: "✓ Verified seller",
  since: (d: string) => ` since ${d} — this seller proved control of the account and passed a live check. The badge is a non-transferable token`,
  heldBy: " held by ",
  onChain: "on chain",
  validUntil: (d: string) => `, valid until ${d}. It vouches for the account, not for any item.`,
  business: "✓ Verified business",
  registeredAs: "Registered as ",
  inCountry: " in ",
  vatIn: (c: string) => `VAT number registered in ${c}`,
  controls: (d: string) => `, controls ${d}`,
  profile: "See the business profile",
  noneStand: "No findings currently stand against this seller.",
  none: "No fake-product findings against this seller.",
  stand: (n: number) => `${n} fake-product finding${n === 1 ? "" : "s"} currently stand${n === 1 ? "s" : ""} against this seller.`,
  meaning:
    "A finding means a buyer who paid through SigPath reported the item with a live photo, the seller was given the chance to reply, and a reviewer upheld it. Reports still under review are never shown here.",
  upheld: (d: string) => `Upheld ${d}`,
  reversed: (d: string) => `reversed ${d}`,
  noLonger: " — no longer counts against the seller",
  record: "on-chain record",
  replied: (d: string) => `The seller replied (${d}):`,
  appealed: (d: string) => `The seller appealed (${d}):`,
  noReply: "The seller did not respond.",
  areYou: "Are you this seller? SigPath contacts sellers through the marketplace's own messages on the order it placed, with a private link to respond.",
  alsoA: "You can also ",
  alsoLink: "become a verified seller",
  back: "Back to search",
  chainNone: "On Solana: no finding recorded against this handle.",
  chainSome: (n: number, r: number) =>
    `On Solana: ${n} finding${n === 1 ? "" : "s"} recorded against this handle${r ? `, ${r} reversed` : ""}.`,
  chainWhy: " Read from the chain, not from SigPath's database.",
  chainProof: "How to check",
};
const de: typeof en = {
  category: { counterfeit: "Artikel als nicht echt gemeldet", not_as_described: "Artikel weicht wesentlich vom Angebot ab" },
  on: "auf",
  verified: "✓ Verifizierter Verkäufer",
  since: (d) => ` seit ${d}: Dieser Verkäufer hat die Kontrolle über das Konto nachgewiesen und eine Live-Prüfung bestanden. Das Abzeichen ist ein nicht übertragbares Token`,
  heldBy: " im Besitz von ",
  onChain: "auf der Blockchain",
  validUntil: (d) => `, gültig bis ${d}. Es bürgt für das Konto, nicht für einen bestimmten Artikel.`,
  business: "✓ Verifiziertes Unternehmen",
  registeredAs: "Eingetragen als ",
  inCountry: " in ",
  vatIn: (c) => `USt-IdNr. eingetragen in ${c}`,
  controls: (d) => `, verwaltet ${d}`,
  profile: "Zum Unternehmensprofil",
  noneStand: "Derzeit liegen keine Befunde gegen diesen Verkäufer vor.",
  none: "Keine Fälschungsbefunde gegen diesen Verkäufer.",
  stand: (n) => `${n} ${n === 1 ? "Fälschungsbefund liegt" : "Fälschungsbefunde liegen"} derzeit gegen diesen Verkäufer vor.`,
  meaning:
    "Ein Befund heißt: Ein Käufer, der über SigPath bezahlt hat, hat den Artikel mit einem Live-Foto gemeldet, der Verkäufer konnte antworten, und eine prüfende Person hat die Meldung bestätigt. Meldungen in Prüfung werden hier nie gezeigt.",
  upheld: (d) => `Bestätigt am ${d}`,
  reversed: (d) => `aufgehoben am ${d}`,
  noLonger: ": zählt nicht mehr gegen den Verkäufer",
  record: "Eintrag auf der Blockchain",
  replied: (d) => `Der Verkäufer hat geantwortet (${d}):`,
  appealed: (d) => `Der Verkäufer hat Einspruch eingelegt (${d}):`,
  noReply: "Der Verkäufer hat nicht geantwortet.",
  areYou: "Bist du dieser Verkäufer? SigPath kontaktiert Verkäufer über die Nachrichten des Marktplatzes zur Bestellung, die es aufgegeben hat, mit einem privaten Link zum Antworten.",
  alsoA: "Du kannst auch ",
  alsoLink: "verifizierter Verkäufer werden",
  back: "Zurück zur Suche",
  chainNone: "Auf Solana: kein Befund gegen diesen Namen festgehalten.",
  chainSome: (n, r) =>
    `Auf Solana: ${n} ${n === 1 ? "Befund" : "Befunde"} gegen diesen Namen festgehalten${r ? `, ${r} aufgehoben` : ""}.`,
  chainWhy: " Von der Blockchain gelesen, nicht aus der Datenbank von SigPath.",
  chainProof: "So prüfst du es",
};

function day(s: number) {
  return new Date(s * 1000).toISOString().slice(0, 10);
}

export default async function SellerPage({ params }: { params: { source: string; handle: string } }) {
  const t = getLang() === "de" ? de : en;
  const source = decodeURIComponent(params.source);
  const handle = decodeURIComponent(params.handle);
  const findings = await publicFindings(sellerKey(source, handle), {
    decisions: DecisionLog.fromEnv(),
    cases: CaseLog.fromEnv(),
  });
  const active = findings.filter((f) => f.status === "upheld").length;

  // The badge is shown only when SigPath's log AND the chain agree: issued,
  // not revoked or lapsed, no upheld report — and the token still held.
  const key = sellerKey(source, handle);
  const decisions = DecisionLog.fromEnv();
  const badgeEntries = await VerifiedSellerLog.fromEnv().all();
  const upheld = await decisions.upheldCounts();
  const local = badgeFor(key, badgeEntries, upheld);
  const business = businessIndex(await BusinessLog.fromEnv().all(), badgeEntries, upheld).get(key) ?? null;
  let onChain: OnChainBadge | null = null;
  const cfg = sasConfigFromEnv();
  if (local && cfg) {
    onChain = await readVerifiedSeller((await signer(cfg)).address, await sellerSubject(key), cfg.rpcUrl).catch(() => null);
  }
  const verified = local && (!cfg || onChain?.status === "valid") ? local : null;
  // The count as Solana holds it, found from the handle alone, exactly as any other app would.
  const chain = await sellerFindingsOnChain(ISSUER, await sellerSubject(key), SOLANA_RPC_URL).catch(() => null);

  return (
    <main className="container">
      <h1>
        {handle}{" "}
        <span className="hint">
          {t.on} {source}
        </span>
      </h1>

      {verified && (
        <p className="notice">
          <span className="verified">{t.verified}</span>
          {t.since(day(verified.verifiedAt))}
          {onChain?.status === "valid" ? (
            <>
              {t.heldBy}
              <code>
                {onChain.holder.slice(0, 4)}…{onChain.holder.slice(-4)}
              </code>
            </>
          ) : null}{" "}
          (
          <a href={`https://explorer.solana.com/address/${verified.attestation}?cluster=devnet`} target="_blank" rel="noopener noreferrer">
            {t.onChain}
          </a>
          ){t.validUntil(day(verified.expiresAt))}
        </p>
      )}

      {verified && business && (
        <p className="notice">
          <a className="verified business" href={`/business/${encodeURIComponent(business.id)}`}>
            {t.business}
          </a>{" "}
          {business.name ? (
            <>
              {t.registeredAs}
              <strong>{business.name}</strong>
              {t.inCountry}
              {business.country}
            </>
          ) : (
            <>{t.vatIn(business.country)}</>
          )}
          {business.domain ? <>{t.controls(business.domain)}</> : null}.{" "}
          <a href={`/business/${encodeURIComponent(business.id)}`}>{t.profile}</a>.
        </p>
      )}

      <p className={active ? "notice withheld" : "notice"}>{active === 0 ? (findings.length ? t.noneStand : t.none) : t.stand(active)}</p>
      <p className="hint">{t.meaning}</p>
      {chain && (
        <p className="hint chain-count">
          {chain.upheld ? t.chainSome(chain.upheld, chain.reversed.length) : t.chainNone}
          {t.chainWhy} <Link href="/proof">{t.chainProof}</Link>
        </p>
      )}

      {findings.map((f, i) => (
        <article key={i} className="listing">
          <div className="body">
            <h3>{t.category[f.category]}</h3>
            <p className="meta">
              {f.status === "reversed" ? (
                <>
                  {t.upheld(day(f.decidedAt))}, <strong>{t.reversed(day(f.reversedAt!))}</strong>
                  {t.noLonger}
                </>
              ) : (
                <>{t.upheld(day(f.decidedAt))}</>
              )}
              {f.attestation && (
                <>
                  {" "}
                  &middot;{" "}
                  <a href={`https://explorer.solana.com/address/${f.attestation}?cluster=devnet`} target="_blank" rel="noopener noreferrer">
                    {t.record}
                  </a>
                </>
              )}
            </p>
            {f.reply && (
              <blockquote className="quote">
                <span className="hint">{t.replied(day(f.reply.at))}</span>
                <br />
                {f.reply.text}
              </blockquote>
            )}
            {f.appeal && (
              <blockquote className="quote">
                <span className="hint">{t.appealed(day(f.appeal.at))}</span>
                <br />
                {f.appeal.text}
              </blockquote>
            )}
            {!f.reply && !f.appeal && <p className="hint">{t.noReply}</p>}
          </div>
        </article>
      ))}

      <p className="hint" style={{ marginTop: 24 }}>
        {t.areYou}{" "}
        {!verified && !active && (
          <>
            {t.alsoA}
            <Link href="/seller/verify">{t.alsoLink}</Link>.{" "}
          </>
        )}
        <Link href="/search">{t.back}</Link>
      </p>
    </main>
  );
}
