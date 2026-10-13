import Link from "next/link";
import { notFound } from "next/navigation";
import { DecisionLog } from "@/lib/reports/reports";
import { VerifiedSellerLog } from "@/lib/sellers/verified-log";
import { BusinessLog, businessView, type BusinessStatus } from "@/lib/sellers/business";
import { sasConfigFromEnv, signer } from "@/lib/chains/solana/sas";
import { readVerifiedBusiness, type OnChainBusiness } from "@/lib/chains/solana/sas-business";
import { getLang } from "@/lib/i18n/server";
import { countryName } from "@/lib/i18n/countries";

/**
 * app/business/[id] — a business's public trust profile.
 *
 * Exactly what was verified, by what evidence, and when; what wasn't; and
 * every linked account with its on-chain badge and any upheld reports. A
 * business can link here from its own shop. It says what the verification
 * doesn't mean, as plainly as what it does. In English and German.
 */

export const dynamic = "force-dynamic";

const MARKET: Record<string, string> = { ebay: "eBay", etsy: "Etsy", amazon: "Amazon", stub: "Demo" };
const CLASS: Record<BusinessStatus, string> = {
  verified: "verified business",
  suspended: "status-chip warn",
  expired: "status-chip",
  incomplete: "status-chip",
};

const en = {
  status: { verified: "✓ Verified business", suspended: "Suspended", expired: "Expired", incomplete: "Not verified yet" } as Record<BusinessStatus, string>,
  /** lib/sellers/business.ts writes the reason in English. */
  reason: (r: string) => r,
  profileHint: "SigPath business profile",
  registeredIn: (c: string) => `Business registered in ${c}`,
  business: "Business",
  validUntil: (d: string) => ` · valid until ${d}`,
  verifiedTitle: "What was verified",
  registered: "Registered business:",
  vatValid: (vat: string, country: string, d: string): [string, string, string] => [`VAT number `, vat, ` is valid in the EU's VIES register (${country}), checked ${d}. `],
  nameIs: "The register gives its name as ",
  noName: (c: string) => `${c} doesn't publish business names through the register, so the name isn't confirmed.`,
  notChecked: "not checked yet.",
  website: "Website:",
  controls: "controls ",
  provedDns: (d: string) => `, proved through its DNS on ${d}.`,
  noneProved: "none proved.",
  accounts: "Marketplace accounts:",
  accountsText: (n: number) =>
    ` ${n} linked by one wallet. Each proved control of the account and passed a live check, and holds a non-transferable badge on Solana.`,
  onSolana: "On Solana",
  recorded: "Recorded as a Solana attestation by SigPath (",
  viewOnChain: "view on chain",
  recordedRest: (d: string) => `), valid until ${d}. Any app can find it from the business wallet `,
  hashes:
    ". The VAT number and website are stored only as hashes, so someone who already has the VAT number can check it, and nobody else learns it.",
  noChain: "This server isn't connected to Solana, so the business is verified in SigPath's records only.",
  unreadable: "Solana couldn't be read just now.",
  chainExpired: "The on-chain record has expired.",
  notYet: "Not recorded on Solana yet.",
  noRecord: "No current record on Solana.",
  linked: "Linked accounts",
  noLinked: "No verified marketplace accounts are linked.",
  verifiedOn: (d: string) => `verified ${d}`,
  notShown: " · badge not currently shown",
  upheld: (n: number) => ` · ${n} upheld report${n === 1 ? "" : "s"}`,
  onChain: "on chain",
  notMeanTitle: "What this doesn't mean",
  notMeanA: "It answers ",
  who: "who runs these accounts",
  notMeanB: ", not ",
  genuine: "whether an item is genuine",
  notMeanC:
    ". A registered business can still sell a bad item. That's why every listing is still price-checked, and why one upheld fake-product report against any linked account suspends this verification for all of them.",
  back: "Back to search",
  verifyYours: "Verify your business",
  title: (name?: string | null) => (name ? `${name} — SigPath business profile` : "Business profile — SigPath"),
};
const de: typeof en = {
  status: { verified: "✓ Verifiziertes Unternehmen", suspended: "Ausgesetzt", expired: "Abgelaufen", incomplete: "Noch nicht verifiziert" },
  reason: (r) =>
    ({
      "A verified buyer's fake-product report against one of its accounts was upheld.":
        "Eine Fälschungsmeldung eines verifizierten Käufers gegen eines seiner Konten wurde bestätigt.",
      "No VAT number has been checked yet.": "Es wurde noch keine USt-IdNr. geprüft.",
      "The VAT check is more than a year old.": "Die Prüfung der USt-IdNr. ist älter als ein Jahr.",
      "None of its marketplace accounts currently holds a verified-seller badge.":
        "Keines seiner Marktplatzkonten trägt derzeit ein Abzeichen als verifizierter Verkäufer.",
    })[r] ?? r,
  profileHint: "SigPath-Unternehmensprofil",
  registeredIn: (c) => `Unternehmen eingetragen in ${c}`,
  business: "Unternehmen",
  validUntil: (d) => ` · gültig bis ${d}`,
  verifiedTitle: "Was verifiziert wurde",
  registered: "Eingetragenes Unternehmen:",
  vatValid: (vat, country, d) => [`Die USt-IdNr. `, vat, ` ist im VIES-Register der EU gültig (${country}), geprüft am ${d}. `],
  nameIs: "Laut Register lautet der Name ",
  noName: (c) => `${c} veröffentlicht über das Register keine Firmennamen, daher ist der Name nicht bestätigt.`,
  notChecked: "noch nicht geprüft.",
  website: "Website:",
  controls: "verwaltet ",
  provedDns: (d) => `, nachgewiesen über ihr DNS am ${d}.`,
  noneProved: "keine nachgewiesen.",
  accounts: "Marktplatzkonten:",
  accountsText: (n) =>
    ` ${n} über eine Wallet verknüpft. Jedes hat die Kontrolle über das Konto nachgewiesen, eine Live-Prüfung bestanden und trägt ein nicht übertragbares Abzeichen auf Solana.`,
  onSolana: "Auf Solana",
  recorded: "Von SigPath als Solana-Attestierung festgehalten (",
  viewOnChain: "auf der Blockchain ansehen",
  recordedRest: (d) => `), gültig bis ${d}. Jede App findet sie über die Unternehmens-Wallet `,
  hashes:
    ". USt-IdNr. und Website sind nur als Hashwerte gespeichert: Wer die USt-IdNr. schon hat, kann sie prüfen, und sonst erfährt sie niemand.",
  noChain: "Dieser Server ist nicht mit Solana verbunden, daher ist das Unternehmen nur in SigPaths Daten verifiziert.",
  unreadable: "Solana konnte gerade nicht gelesen werden.",
  chainExpired: "Der Eintrag auf der Blockchain ist abgelaufen.",
  notYet: "Noch nicht auf Solana festgehalten.",
  noRecord: "Kein aktueller Eintrag auf Solana.",
  linked: "Verknüpfte Konten",
  noLinked: "Es sind keine verifizierten Marktplatzkonten verknüpft.",
  verifiedOn: (d) => `verifiziert am ${d}`,
  notShown: " · Abzeichen derzeit nicht angezeigt",
  upheld: (n) => ` · ${n} ${n === 1 ? "bestätigte Meldung" : "bestätigte Meldungen"}`,
  onChain: "auf der Blockchain",
  notMeanTitle: "Was das nicht bedeutet",
  notMeanA: "Es beantwortet, ",
  who: "wer diese Konten führt",
  notMeanB: ", nicht, ",
  genuine: "ob ein Artikel echt ist",
  notMeanC:
    ". Auch ein eingetragenes Unternehmen kann einen schlechten Artikel verkaufen. Deshalb wird jedes Angebot trotzdem preisgeprüft, und eine einzige bestätigte Fälschungsmeldung gegen ein verknüpftes Konto setzt diese Verifizierung für alle aus.",
  back: "Zurück zur Suche",
  verifyYours: "Dein Unternehmen verifizieren",
  title: (name) => (name ? `${name} — SigPath-Unternehmensprofil` : "Unternehmensprofil — SigPath"),
};

function day(s: number) {
  return new Date(s * 1000).toISOString().slice(0, 10);
}

export async function generateMetadata({ params }: { params: { id: string } }) {
  const b = await BusinessLog.fromEnv().byId(decodeURIComponent(params.id));
  return { title: (getLang() === "de" ? de : en).title(b?.vat?.registeredName) };
}

export default async function BusinessProfile({ params }: { params: { id: string } }) {
  const lang = getLang();
  const t = lang === "de" ? de : en;
  const business = await BusinessLog.fromEnv().byId(decodeURIComponent(params.id));
  if (!business) notFound();
  const v = businessView(business, await VerifiedSellerLog.fromEnv().all(), await DecisionLog.fromEnv().upheldCounts());
  const country = countryName(v.country, v.countryName, lang);
  // Read from Solana itself, as any other app would: SigPath's copy is not the proof.
  const cfg = sasConfigFromEnv();
  const chain: OnChainBusiness | null = cfg ? await readVerifiedBusiness((await signer(cfg)).address, business.wallet, cfg.rpcUrl).catch(() => null) : null;
  const vat = v.vatMasked ? t.vatValid(v.vatMasked, country ?? "", v.vatCheckedAt ? day(v.vatCheckedAt) : "") : null;

  return (
    <main className="container business-profile">
      <p className="hint">{t.profileHint}</p>
      <h1>{v.registeredName ?? (country ? t.registeredIn(country) : t.business)}</h1>
      <p>
        <span className={CLASS[v.status]}>{t.status[v.status]}</span>
        {v.status === "verified" && v.expiresAt && <span className="hint">{t.validUntil(day(v.expiresAt))}</span>}
      </p>
      {v.statusReason && <p className="notice withheld">{t.reason(v.statusReason)}</p>}

      <h2>{t.verifiedTitle}</h2>
      <ul className="evidence">
        <li className={v.vatMasked ? "good" : "info"}>
          <strong>{t.registered}</strong>{" "}
          {vat ? (
            <>
              {vat[0]}
              <code>{vat[1]}</code>
              {vat[2]}
              {v.registeredName ? (
                <>
                  {t.nameIs}
                  <strong>{v.registeredName}</strong>.
                </>
              ) : (
                <>{t.noName(country ?? "")}</>
              )}
            </>
          ) : (
            t.notChecked
          )}
        </li>
        <li className={v.domain ? "good" : "info"}>
          <strong>{t.website}</strong>{" "}
          {v.domain ? (
            <>
              {t.controls}
              <strong>{v.domain}</strong>
              {t.provedDns(day(v.domainVerifiedAt!))}
            </>
          ) : (
            t.noneProved
          )}
        </li>
        <li className={v.accounts.some((a) => a.active) ? "good" : "info"}>
          <strong>{t.accounts}</strong>
          {t.accountsText(v.accounts.length)}
        </li>
      </ul>

      <h2>{t.onSolana}</h2>
      {chain?.status === "valid" ? (
        <p className="notice">
          {t.recorded}
          <a href={`https://explorer.solana.com/address/${chain.attestation}?cluster=devnet`} target="_blank" rel="noopener noreferrer">
            {t.viewOnChain}
          </a>
          {t.recordedRest(day(chain.expiresAt))}
          <code>
            {business.wallet.slice(0, 4)}…{business.wallet.slice(-4)}
          </code>
          {t.hashes}
        </p>
      ) : (
        <p className="hint">
          {!cfg
            ? t.noChain
            : chain === null
              ? t.unreadable
              : chain.status === "expired"
                ? t.chainExpired
                : v.status === "verified"
                  ? t.notYet
                  : t.noRecord}
        </p>
      )}

      <h2>{t.linked}</h2>
      {v.accounts.length === 0 ? (
        <p className="hint">{t.noLinked}</p>
      ) : (
        <ul className="linked-accounts">
          {v.accounts.map((a) => (
            <li key={a.sellerKey}>
              <Link href={`/seller/${encodeURIComponent(a.source)}/${encodeURIComponent(a.handle)}`}>
                <strong>{a.handle}</strong>
              </Link>{" "}
              <span className="chip">{MARKET[a.source] ?? a.source}</span>{" "}
              <span className="hint">
                {t.verifiedOn(day(a.verifiedAt))}
                {!a.active && t.notShown}
                {a.upheldReports > 0 && t.upheld(a.upheldReports)}
                {" · "}
                <a href={`https://explorer.solana.com/address/${a.attestation}?cluster=devnet`} target="_blank" rel="noopener noreferrer">
                  {t.onChain}
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>{t.notMeanTitle}</h2>
      <p className="hint">
        {t.notMeanA}
        <em>{t.who}</em>
        {t.notMeanB}
        <em>{t.genuine}</em>
        {t.notMeanC}
      </p>
      <p className="hint">
        <Link href="/search">{t.back}</Link> &middot; <Link href="/seller/business">{t.verifyYours}</Link>
      </p>
    </main>
  );
}
