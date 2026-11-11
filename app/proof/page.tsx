import Link from "next/link";
import { redirect } from "next/navigation";
import PopIcon, { TONES } from "../components/PopIcon";
import type { IconName } from "../components/icon-paths";
import { ON_DEVNET, proof, type ProofFinding } from "@/lib/proof/ledger";
import { getLang } from "@/lib/i18n/server";

/**
 * app/proof — "Don't trust us. Check."
 *
 * A new site that takes crypto looks like a scam until it shows otherwise. This
 * page shows SigPath's record as Solana holds it (lib/proof/ledger.ts): the
 * escrow's orders, every upheld finding against a seller and every reversal,
 * each with a link to open it in an explorer. Nothing here comes from SigPath's
 * database. Then the escrow's rules in plain words, including what it can't
 * prove, and what SigPath will never ask for. In English and German.
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return { title: getLang() === "de" ? "Nachweis auf Solana — SigPath" : "Proof on Solana — SigPath" };
}

const CODE = "https://github.com/yc82628/sigpath";
const ESCROW_CODE = `${CODE}/blob/main/programs/sigpath_orders/src/lib.rs`;

type Rule = { icon: IconName; title: string; line: string };

const en = {
  title: "Don't trust us. Check.",
  lede: "Any site can say it's safe. Everything on this page is read live from the Solana blockchain, not from SigPath's database: SigPath can't edit it, and you can open every record yourself.",
  devnet:
    "SigPath runs on Solana's test network (devnet) while it's being built: the money is test USDC, and the records below were made while testing. The rules are the ones a launch will run.",
  liveTitle: "Live from Solana",
  readAt: (t: string) => `Read from Solana at ${t} UTC.`,
  unreadable: "Solana didn't answer just now. Every record is still there: open them through the links below.",
  stats: {
    paid: { label: "orders paid out", line: "Only once SigPath recorded the shop's order, before the deadline" },
    refunded: { label: "orders refunded", line: (usdc: string) => `${usdc} USDC back to the buyers' own wallets` },
    held: { label: "USDC in escrow now", line: "Held by the program: no person holds a key to it" },
    findings: { label: "findings against sellers", line: (n: number) => `${n} reversed since, and still on record` },
  },
  moneyTitle: "Your money follows rules, not promises",
  rules: [
    { icon: "vault", title: "Held by code", line: "Your USDC waits in a vault only the escrow program can move. Not SigPath, not anyone with a key." },
    { icon: "lock-key", title: "Paid out only for a real order", line: "SigPath is paid only when it records the shop's order or tracking number, and only before the deadline." },
    { icon: "wallet", title: "A refund no one can stop", line: "After the deadline anyone can trigger the refund, and it can only go to your own wallet." },
    { icon: "info", title: "What it can't prove", line: "A blockchain can't see a parcel arrive. If an order is recorded and never comes, that's a report, not an automatic refund." },
  ] as Rule[],
  readCode: "Read the escrow's code",
  openProgram: "Open the escrow program on Solana",
  ledgerTitle: "The record against sellers",
  ledgerLede:
    "Every fake-product finding SigPath has upheld, and every reversal. A seller appears as a fingerprint (hash) of their handle, as on the chain; a finding is never deleted, only marked reversed.",
  cols: { date: "Upheld", what: "Finding", seller: "Seller (hash)", status: "Status", record: "Record" },
  category: { counterfeit: "Not genuine", not_as_described: "Not as described", unknown: "Finding" } as Record<string, string>,
  nth: (i: number | null) => (i === null ? "" : ` · report #${i + 1}`),
  stands: "Stands",
  reversedOn: (d: string) => `Reversed ${d}`,
  open: "on Solana",
  none: "No finding has been upheld yet.",
  checkTitle: "Check a seller",
  checkLede: "SigPath hashes the handle the same way and looks up its record on Solana.",
  marketplace: "Marketplace",
  handle: "Seller's handle",
  check: "Check",
  neverTitle: "SigPath will never",
  never: [
    "ask for your recovery phrase or private key",
    "ask you to send USDC straight to a wallet: every payment goes into the escrow, and you sign it in your own wallet",
    "ask for a password: there are no accounts",
    "ask for card details",
  ],
  neverEnd: "Anyone asking for these in SigPath's name isn't SigPath. SigPath lives at sigpath.vercel.app.",
  openTitle: "Read every line",
  openLine: "SigPath's code is open source (MIT), including the escrow and the checks.",
  openCode: "The code on GitHub",
  addresses: "SigPath's addresses on Solana",
  addr: {
    issuer: "SigPath's key (signs every record, runs the escrow)",
    ordersProgram: "The escrow program",
    credential: "SigPath's credential in the Solana Attestation Service",
    reportSchema: "Schema: upheld findings",
    reversalSchema: "Schema: reversals",
    verifiedSchema: "Schema: verified-seller badges",
    businessSchema: "Schema: verified businesses",
  } as Record<string, string>,
  forSellers: "Selling? The rules for sellers →",
  impressum: "Impressum",
  privacy: "Privacy",
};

const de: typeof en = {
  title: "Vertrau uns nicht. Prüf es nach.",
  lede: "Sicher nennen kann sich jede Website. Alles auf dieser Seite wird live von der Solana-Blockchain gelesen, nicht aus der Datenbank von SigPath: SigPath kann es nicht ändern, und du kannst jeden Eintrag selbst öffnen.",
  devnet:
    "SigPath läuft während der Entwicklung im Testnetz von Solana (Devnet): Das Geld ist Test-USDC, und die Einträge unten sind beim Testen entstanden. Die Regeln sind die, mit denen SigPath startet.",
  liveTitle: "Live von Solana",
  readAt: (t) => `Von Solana gelesen um ${t} UTC.`,
  unreadable: "Solana hat gerade nicht geantwortet. Alle Einträge sind trotzdem da: Öffne sie über die Links unten.",
  stats: {
    paid: { label: "Bestellungen ausgezahlt", line: "Erst als SigPath die Bestellung beim Shop festgehalten hat, vor der Frist" },
    refunded: { label: "Bestellungen erstattet", line: (usdc) => `${usdc} USDC zurück in die eigenen Wallets der Käufer` },
    held: { label: "USDC jetzt in Treuhand", line: "Verwahrt vom Programm: Kein Mensch hat einen Schlüssel dazu" },
    findings: { label: "Befunde gegen Verkäufer", line: (n) => `${n} davon aufgehoben, und weiter sichtbar` },
  },
  moneyTitle: "Dein Geld folgt Regeln, nicht Versprechen",
  rules: [
    { icon: "vault", title: "Verwahrt von Code", line: "Deine USDC liegen in einem Tresor, den nur das Treuhandprogramm bewegen kann. Nicht SigPath, niemand mit einem Schlüssel." },
    { icon: "lock-key", title: "Ausgezahlt nur für eine echte Bestellung", line: "SigPath wird nur bezahlt, wenn es die Bestell- oder Sendungsnummer des Shops festhält, und nur vor der Frist." },
    { icon: "wallet", title: "Eine Erstattung, die niemand aufhalten kann", line: "Nach der Frist kann jeder die Erstattung auslösen, und sie geht nur an deine eigene Wallet." },
    { icon: "info", title: "Was sie nicht beweisen kann", line: "Eine Blockchain sieht kein Paket ankommen. Wird eine Bestellung festgehalten und kommt nie an, ist das eine Meldung, keine automatische Erstattung." },
  ],
  readCode: "Den Code der Treuhand lesen",
  openProgram: "Das Treuhandprogramm auf Solana öffnen",
  ledgerTitle: "Die Einträge gegen Verkäufer",
  ledgerLede:
    "Jeder Fälschungsbefund, den SigPath bestätigt hat, und jede Aufhebung. Ein Verkäufer erscheint als Fingerabdruck (Hash) seines Namens, wie auf der Blockchain; ein Befund wird nie gelöscht, nur als aufgehoben markiert.",
  cols: { date: "Bestätigt", what: "Befund", seller: "Verkäufer (Hash)", status: "Status", record: "Eintrag" },
  category: { counterfeit: "Nicht echt", not_as_described: "Nicht wie beschrieben", unknown: "Befund" },
  nth: (i) => (i === null ? "" : ` · Meldung Nr. ${i + 1}`),
  stands: "Gilt",
  reversedOn: (d) => `Aufgehoben am ${d}`,
  open: "auf Solana",
  none: "Noch wurde kein Befund bestätigt.",
  checkTitle: "Einen Verkäufer prüfen",
  checkLede: "SigPath bildet den Hash des Namens auf dieselbe Weise und sucht seinen Eintrag auf Solana.",
  marketplace: "Marktplatz",
  handle: "Name des Verkäufers",
  check: "Prüfen",
  neverTitle: "SigPath wird dich nie",
  never: [
    "nach deiner Wiederherstellungsphrase oder deinem privaten Schlüssel fragen",
    "bitten, USDC direkt an eine Wallet zu schicken: Jede Zahlung geht in die Treuhand, und du bestätigst sie in deiner eigenen Wallet",
    "nach einem Passwort fragen: Es gibt keine Konten",
    "nach Kartendaten fragen",
  ],
  neverEnd: "Wer im Namen von SigPath danach fragt, ist nicht SigPath. SigPath ist unter sigpath.vercel.app zu finden.",
  openTitle: "Jede Zeile lesen",
  openLine: "Der Code von SigPath ist Open Source (MIT), auch die Treuhand und die Prüfungen.",
  openCode: "Der Code auf GitHub",
  addresses: "Die Adressen von SigPath auf Solana",
  addr: {
    issuer: "Der Schlüssel von SigPath (signiert jeden Eintrag, betreibt die Treuhand)",
    ordersProgram: "Das Treuhandprogramm",
    credential: "Das Credential von SigPath im Solana Attestation Service",
    reportSchema: "Schema: bestätigte Befunde",
    reversalSchema: "Schema: Aufhebungen",
    verifiedSchema: "Schema: Abzeichen verifizierter Verkäufer",
    businessSchema: "Schema: verifizierte Unternehmen",
  },
  forSellers: "Du verkaufst? Die Regeln für Verkäufer →",
  impressum: "Impressum",
  privacy: "Datenschutz",
};

const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
const usdc = (base: number, lang: "en" | "de") =>
  (base / 1e6).toLocaleString(lang === "de" ? "de-DE" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (hex: string) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;
const explorer = (a: string) => `https://explorer.solana.com/address/${a}${ON_DEVNET ? "?cluster=devnet" : ""}`;

/** Only the marketplaces whose handles SigPath records, so a typo can't land on another path. */
const SOURCES = [
  ["ebay", "eBay"],
  ["etsy", "Etsy"],
] as const;

export default async function ProofPage({ searchParams }: { searchParams: { source?: string; handle?: string } }) {
  // The "check a seller" form: on to the seller's own page, which reads its record on Solana.
  const handle = searchParams.handle?.trim();
  const source = SOURCES.find(([k]) => k === searchParams.source)?.[0];
  if (handle && source) redirect(`/seller/${source}/${encodeURIComponent(handle)}`);

  const lang = getLang();
  const t = lang === "de" ? de : en;
  const p = await proof();
  const reversed = p?.findings.filter((f) => f.reversal).length ?? 0;

  return (
    <main className="container proof">
      <h1>{t.title}</h1>
      <p className="lede">{t.lede}</p>
      {ON_DEVNET && <p className="notice">{t.devnet}</p>}

      <h2>{t.liveTitle}</h2>
      {p ? (
        <>
          <ul className="proof-stats">
            <li>
              <b>{p.orders.fulfilled}</b>
              <strong>{t.stats.paid.label}</strong>
              <span>{t.stats.paid.line}</span>
            </li>
            <li>
              <b>{p.orders.refunded}</b>
              <strong>{t.stats.refunded.label}</strong>
              <span>{t.stats.refunded.line(usdc(p.orders.returned, lang))}</span>
            </li>
            <li>
              <b>{usdc(p.orders.heldNow, lang)}</b>
              <strong>{t.stats.held.label}</strong>
              <span>{t.stats.held.line}</span>
            </li>
            <li>
              <b>{p.findings.length}</b>
              <strong>{t.stats.findings.label}</strong>
              <span>{t.stats.findings.line(reversed)}</span>
            </li>
          </ul>
          <p className="hint">{t.readAt(new Date(p.readAt * 1000).toISOString().slice(11, 16))}</p>
        </>
      ) : (
        <p className="notice withheld">{t.unreadable}</p>
      )}

      <h2>{t.moneyTitle}</h2>
      <ul className="proof-rules">
        {t.rules.map((r, i) => (
          <li key={r.title}>
            <span className="promise-icon">
              <PopIcon name={r.icon} tone={TONES[i % 3]} size={22} />
            </span>
            <span>
              <strong>{r.title}</strong>
              <span>{r.line}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="proof-links">
        <a href={ESCROW_CODE} rel="noopener">
          {t.readCode}
        </a>
        <a href={p?.links.ordersProgram ?? explorer("3gWtrK2mxrW5udZuYxQaeAKwTFx2VbD8WfShBMpgHBwW")} rel="noopener">
          {t.openProgram}
        </a>
      </p>

      <h2>{t.ledgerTitle}</h2>
      <p className="hint">{t.ledgerLede}</p>
      {p && p.findings.length > 0 ? (
        <div className="proof-ledger-wrap">
          <table className="proof-ledger">
            <thead>
              <tr>
                <th>{t.cols.date}</th>
                <th>{t.cols.what}</th>
                <th>{t.cols.seller}</th>
                <th>{t.cols.status}</th>
                <th>{t.cols.record}</th>
              </tr>
            </thead>
            <tbody>
              {p.findings.map((f: ProofFinding) => (
                <tr key={f.address} className={f.reversal ? "reversed" : "stands"}>
                  <td>{day(f.upheldAt)}</td>
                  <td>
                    {t.category[f.category ?? "unknown"]}
                    <span className="hint">{t.nth(f.index)}</span>
                  </td>
                  <td>
                    <code title={f.subject}>{short(f.subject)}</code>
                  </td>
                  <td>{f.reversal ? t.reversedOn(day(f.reversal.at)) : <strong>{t.stands}</strong>}</td>
                  <td>
                    <a href={explorer(f.address)} rel="noopener">
                      {t.open}
                    </a>
                    {f.reversal && (
                      <>
                        {" · "}
                        <a href={explorer(f.reversal.address)} rel="noopener">
                          ↩
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        p && <p className="notice">{t.none}</p>
      )}

      <form className="proof-check" method="GET" action="/proof">
        <strong>{t.checkTitle}</strong>
        <span className="hint">{t.checkLede}</span>
        <div>
          <select name="source" aria-label={t.marketplace} defaultValue="ebay">
            {SOURCES.map(([k, name]) => (
              <option key={k} value={k}>
                {name}
              </option>
            ))}
          </select>
          <input name="handle" required maxLength={80} placeholder={t.handle} aria-label={t.handle} />
          <button type="submit">{t.check}</button>
        </div>
      </form>

      <h2>{t.neverTitle}</h2>
      <ul className="proof-never">
        {t.never.map((n) => (
          <li key={n}>
            <PopIcon name="prohibit" tone="purple" size={20} />
            <span>{n}</span>
          </li>
        ))}
      </ul>
      <p className="hint">{t.neverEnd}</p>

      <h2>{t.openTitle}</h2>
      <p>
        {t.openLine}{" "}
        <a href={CODE} rel="noopener">
          {t.openCode}
        </a>
        {" · "}
        <Link href="/impressum">{t.impressum}</Link>
        {" · "}
        <Link href="/privacy">{t.privacy}</Link>
      </p>
      {p && (
        <details className="legal-part proof-addresses">
          <summary>{t.addresses}</summary>
          <ul>
            {Object.entries(p.links).map(([k, url]) => (
              <li key={k}>
                {t.addr[k]}: <a href={url} rel="noopener"><code>{url.split("/address/")[1].split("?")[0]}</code></a>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="home-more">
        <Link href="/seller">{t.forSellers}</Link>
      </p>
    </main>
  );
}
