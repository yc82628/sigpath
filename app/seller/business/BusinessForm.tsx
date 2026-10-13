"use client";

/**
 * The verified-business steps, in order:
 *   1. connect the wallet that holds the verified-seller badges
 *   2. see the accounts it links (verify one first if there are none)
 *   3. check the VAT number against the EU register (signed by the wallet)
 *   4. optionally, prove the website with a DNS record (signed again)
 */

import { useState } from "react";
import WalletButton from "../../components/WalletButton";
import { walletErrorMessage, type ConnectedWallet } from "../../components/wallet";
// The browser-safe half: the server rebuilds exactly this text to verify the signature.
import { businessMessage, domainAction, vatAction } from "@/lib/sellers/business-message";
import type { BusinessStatus } from "@/lib/sellers/business-api";
import type { BusinessView } from "@/lib/sellers/business";
import { useLang } from "../../components/I18n";
import { countryName } from "@/lib/i18n/countries";

const COUNTRIES: [string, string][] = [
  ["AT", "Austria"], ["BE", "Belgium"], ["BG", "Bulgaria"], ["HR", "Croatia"], ["CY", "Cyprus"], ["CZ", "Czechia"],
  ["DK", "Denmark"], ["EE", "Estonia"], ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"], ["EL", "Greece"],
  ["HU", "Hungary"], ["IE", "Ireland"], ["IT", "Italy"], ["LV", "Latvia"], ["LT", "Lithuania"], ["LU", "Luxembourg"],
  ["MT", "Malta"], ["NL", "Netherlands"], ["XI", "Northern Ireland"], ["PL", "Poland"], ["PT", "Portugal"],
  ["RO", "Romania"], ["SK", "Slovakia"], ["SI", "Slovenia"], ["ES", "Spain"], ["SE", "Sweden"],
];
const MARKET: Record<string, string> = { ebay: "eBay", etsy: "Etsy", amazon: "Amazon", stub: "Demo" };

function normaliseVatInput(country: string, number: string): string {
  let n = number.toUpperCase().replace(/[\s.\-]/g, "");
  if (n.startsWith(country)) n = n.slice(country.length);
  if (country === "EL" && n.startsWith("GR")) n = n.slice(2);
  return n;
}

async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: json as T } : { ok: false, error: (json as { error?: string }).error ?? "Something went wrong." };
}

export default function BusinessForm() {
  const lang = useLang();
  const T = (en: string, german: string) => (lang === "de" ? german : en);
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const wallet = connected?.address ?? null;
  const [status, setStatus] = useState<BusinessStatus | null>(null);
  const [business, setBusiness] = useState<BusinessView | null>(null);
  const [country, setCountry] = useState("DE");
  const [vatNumber, setVatNumber] = useState("");
  const [domain, setDomain] = useState("");
  const [record, setRecord] = useState<{ domain: string; record: { name: string; value: string } } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sign(action: string): Promise<{ time: string; signature: string } | null> {
    if (!connected || !wallet) return null;
    const time = new Date().toISOString();
    const signature = await connected.signMessage(businessMessage(action, wallet, time));
    return { time, signature };
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(walletErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const connect = (c: ConnectedWallet) =>
    run(async () => {
      const w = c.address;
      setConnected(c);
      const res = await fetch(`/api/business/status?wallet=${encodeURIComponent(w)}`);
      const s = (await res.json()) as BusinessStatus;
      setStatus(s);
      setBusiness(s.business);
    });

  const checkVatNumber = () =>
    run(async () => {
      const number = normaliseVatInput(country, vatNumber);
      const signed = await sign(vatAction(country, number));
      if (!signed) return;
      const r = await postJson<BusinessView>("/api/business/vat", { wallet, country, vatNumber: number, ...signed });
      if (r.ok) setBusiness(r.value);
      else setError(r.error);
    });

  const startWebsite = () =>
    run(async () => {
      const r = await postJson<{ domain: string; record: { name: string; value: string } }>("/api/business/domain/start", { wallet, domain });
      if (r.ok) setRecord(r.value);
      else setError(r.error);
    });

  const verifyWebsite = () =>
    run(async () => {
      if (!record) return;
      const signed = await sign(domainAction(record.domain));
      if (!signed) return;
      const r = await postJson<BusinessView>("/api/business/domain/verify", { wallet, domain: record.domain, ...signed });
      if (r.ok) {
        setBusiness(r.value);
        setRecord(null);
      } else setError(r.error);
    });

  const activeAccounts = status?.accounts.filter((a) => a.active) ?? [];

  return (
    <div className="business-form">
      {!wallet && (
        <section className="step">
          <h2>{T("1. Connect your wallet", "1. Wallet verbinden")}</h2>
          <p className="hint">{T("The same wallet you used to verify your marketplace accounts.", "Dieselbe Wallet, mit der du deine Marktplatzkonten verifiziert hast.")}</p>
          <WalletButton label={T("Connect wallet", "Wallet verbinden")} disabled={busy} onConnect={connect} onError={setError} />
        </section>
      )}

      {wallet && status && (
        <section className="step">
          <h2>{T("2. Your verified accounts", "2. Deine verifizierten Konten")}</h2>
          {status.accounts.length === 0 ? (
            <p>
              {T("This wallet hasn't verified any marketplace accounts yet. ", "Diese Wallet hat noch keine Marktplatzkonten verifiziert. ")}
              <a href="/seller/verify">{T("Verify one first", "Verifiziere zuerst eines")}</a>
              {T(", then come back.", " und komm dann zurück.")}
            </p>
          ) : (
            <ul className="linked-accounts">
              {status.accounts.map((a) => (
                <li key={a.sellerKey}>
                  <strong>{a.handle}</strong> <span className="chip">{MARKET[a.source] ?? a.source}</span>{" "}
                  <span className="hint">{a.active ? T("verified", "verifiziert") : T("badge not currently shown", "Abzeichen derzeit nicht angezeigt")}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">{T("Verify more accounts with this wallet and they join your business automatically.", "Verifiziere weitere Konten mit dieser Wallet, und sie werden automatisch deinem Unternehmen zugeordnet.")}</p>
        </section>
      )}

      {wallet && activeAccounts.length > 0 && (
        <section className="step">
          <h2>{T("3. Your VAT number", "3. Deine USt-IdNr.")}</h2>
          {business?.vatMasked ? (
            <p className="notice">
              ✓ <code>{business.vatMasked}</code> {T("is valid in the EU register", "ist im EU-Register gültig")} (
              {countryName(business.country, business.countryName, lang)})
              {business.registeredName ? (
                <>
                  {T(", registered as ", ", eingetragen als ")}
                  <strong>{business.registeredName}</strong>
                </>
              ) : (
                <>{T("; the register doesn't publish the name", "; das Register veröffentlicht den Namen nicht")}</>
              )}
              .
            </p>
          ) : (
            <p className="hint">{T("Checked live against the EU's VIES register. The name shown is the register's, not what you type.", "Live im VIES-Register der EU geprüft. Der angezeigte Name stammt aus dem Register, nicht aus deiner Eingabe.")}</p>
          )}
          <div className="form-row">
            <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label={T("Country of registration", "Land der Eintragung")}>
              {COUNTRIES.map(([c, name]) => (
                <option key={c} value={c}>
                  {countryName(c, name, lang)}
                </option>
              ))}
            </select>
            <input value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} placeholder={T("VAT number", "USt-IdNr.")} aria-label={T("VAT number", "USt-IdNr.")} />
            <button type="button" className="primary" disabled={busy || vatNumber.trim().length < 2} onClick={checkVatNumber}>
              {business?.vatMasked ? T("Check again", "Erneut prüfen") : T("Check and sign", "Prüfen und signieren")}
            </button>
          </div>
        </section>
      )}

      {wallet && activeAccounts.length > 0 && (
        <section className="step">
          <h2>{T("4. Your website (optional)", "4. Deine Website (optional)")}</h2>
          {business?.domain && <p className="notice">✓ {T("Controls", "Verwaltet")} {business.domain}.</p>}
          {!record ? (
            <div className="form-row">
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example-shop.de" aria-label={T("Website domain", "Domain der Website")} />
              <button type="button" disabled={busy || !domain.trim()} onClick={startWebsite}>
                {T("Get the DNS record", "DNS-Eintrag anzeigen")}
              </button>
            </div>
          ) : (
            <>
              <p>{T("Add this TXT record at your domain provider, then check it:", "Lege diesen TXT-Eintrag bei deinem Domain-Anbieter an und prüfe ihn dann:")}</p>
              <dl className="dns-record">
                <dt>Name</dt>
                <dd><code>{record.record.name}</code></dd>
                <dt>Type</dt>
                <dd><code>TXT</code></dd>
                <dt>Value</dt>
                <dd><code>{record.record.value}</code></dd>
              </dl>
              <button type="button" className="primary" disabled={busy} onClick={verifyWebsite}>
                {T("I've added it: check and sign", "Ist angelegt: prüfen und signieren")}
              </button>
            </>
          )}
        </section>
      )}

      {business && business.status !== "verified" && (
        <p className="hint">
          {T("Your ", "Dein ")}
          <a href={`/business/${encodeURIComponent(business.id)}`}>{T("public profile", "öffentliches Profil")}</a>
          {T(" shows what's verified so far.", " zeigt, was bisher verifiziert ist.")}
        </p>
      )}
      {business?.status === "verified" && (
        <p className="notice">
          🎉 {T("Your business is verified. ", "Dein Unternehmen ist verifiziert. ")}
          <a href={`/business/${encodeURIComponent(business.id)}`}>{T("See your public profile", "Sieh dir dein öffentliches Profil an")}</a>
          {T(", and link to it from your shop.", " und verlinke es in deinem Shop.")}
        </p>
      )}
      {error && (
        <p className="notice withheld" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
