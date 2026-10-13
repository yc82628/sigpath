"use client";

/**
 * The supplier check form and its report. Nothing is kept: the details are
 * sent once to /api/suppliers/check and the report lives only on this page.
 */

import { useState } from "react";
import type { SupplierReport } from "@/lib/suppliers/check";
import { useLang } from "../components/I18n";
import { countryName } from "@/lib/i18n/countries";
import { translateSupplier } from "@/lib/i18n/supplier";

const COUNTRIES: [string, string][] = [
  ["AT", "Austria"], ["BE", "Belgium"], ["BG", "Bulgaria"], ["HR", "Croatia"], ["CY", "Cyprus"], ["CZ", "Czechia"],
  ["DK", "Denmark"], ["EE", "Estonia"], ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"], ["EL", "Greece"],
  ["HU", "Hungary"], ["IE", "Ireland"], ["IT", "Italy"], ["LV", "Latvia"], ["LT", "Lithuania"], ["LU", "Luxembourg"],
  ["MT", "Malta"], ["NL", "Netherlands"], ["XI", "Northern Ireland"], ["PL", "Poland"], ["PT", "Portugal"],
  ["RO", "Romania"], ["SK", "Slovakia"], ["SI", "Slovenia"], ["ES", "Spain"], ["SE", "Sweden"],
];

const ICON = { good: "✓", warn: "!", bad: "✕", unknown: "–" } as const;

export default function SupplierCheck() {
  const lang = useLang();
  const T = (en: string, german: string) => (lang === "de" ? german : en);
  const tr = (s: string) => translateSupplier(s, lang);
  const [f, setF] = useState({ name: "", vatCountry: "DE", vatNumber: "", domain: "", marketplace: "ebay", handle: "" });
  const [report, setReport] = useState<SupplierReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const res = await fetch("/api/suppliers/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, handle: f.handle.trim() || undefined, vatNumber: f.vatNumber.trim() || undefined }),
      });
      const json = await res.json();
      if (res.ok) setReport(json as SupplierReport);
      else setError(tr((json as { error?: string }).error ?? T("Something went wrong.", "Etwas ist schiefgelaufen.")));
    } catch {
      setError(T("Couldn't reach SigPath. Check your connection and try again.", "SigPath ist nicht erreichbar. Prüfe deine Verbindung und versuche es erneut."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="supplier-form" onSubmit={run}>
        <label>
          {T("Supplier name", "Name des Lieferanten")} <span className="hint">{T("(as they gave it)", "(wie angegeben)")}</span>
          <input value={f.name} onChange={set("name")} placeholder="Acme Trading GmbH" />
        </label>
        <label>
          {T("EU VAT number", "EU-USt-IdNr.")}
          <span className="form-row">
            <select value={f.vatCountry} onChange={set("vatCountry")} aria-label={T("VAT country", "Land der USt-IdNr.")}>
              {COUNTRIES.map(([c, n]) => (
                <option key={c} value={c}>
                  {countryName(c, n, lang)}
                </option>
              ))}
            </select>
            <input value={f.vatNumber} onChange={set("vatNumber")} placeholder="123456789" aria-label={T("VAT number", "USt-IdNr.")} />
          </span>
        </label>
        <label>
          {T("Website", "Website")}
          <input value={f.domain} onChange={set("domain")} placeholder="acme-trading.de" />
        </label>
        <label>
          {T("Marketplace account", "Marktplatzkonto")}
          <span className="form-row">
            <select value={f.marketplace} onChange={set("marketplace")} aria-label={T("Marketplace", "Marktplatz")}>
              <option value="ebay">eBay</option>
              <option value="amazon">Amazon</option>
            </select>
            <input
              value={f.handle}
              onChange={set("handle")}
              placeholder={T("seller name", "Verkäufername")}
              aria-label={T("Seller name on the marketplace", "Verkäufername auf dem Marktplatz")}
            />
          </span>
        </label>
        <p className="hint">{T("Fill in what you have; one detail is enough, more is better. Nothing is saved.", "Gib ein, was du hast: Eine Angabe reicht, mehr ist besser. Nichts wird gespeichert.")}</p>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? T("Checking…", "Wird geprüft…") : T("Check this supplier", "Diesen Lieferanten prüfen")}
        </button>
      </form>

      {error && (
        <p className="notice withheld" role="alert">
          {error}
        </p>
      )}

      {report && (
        <section className={`supplier-report ${report.summary.state}`} aria-live="polite">
          <h2>{tr(report.summary.headline)}</h2>
          <ul className="findings">
            {report.findings.map((x, i) => (
              <li key={i} className={x.state}>
                <span className="finding-icon" aria-hidden="true">
                  {ICON[x.state]}
                </span>
                <span>
                  <strong>{tr(x.title)}</strong>
                  <span className="finding-detail">{tr(x.detail)}</span>
                </span>
              </li>
            ))}
          </ul>
          {report.businessProfile && (
            <p>
              <a href={report.businessProfile}>{T("See their SigPath business profile →", "Zu ihrem SigPath-Unternehmensprofil →")}</a>
            </p>
          )}
          <p className="hint">
            {T("Checked ", "Geprüft am ")}
            {new Date(report.checkedAt).toLocaleString(lang === "de" ? "de-DE" : "en-GB")}.{" "}
            {T(
              "These checks confirm who you're dealing with, not that an order will arrive. For large orders, pay in a way you can reverse, and start with a small one.",
              "Diese Prüfungen bestätigen, mit wem du es zu tun hast, nicht, dass eine Bestellung ankommt. Zahle große Bestellungen so, dass du die Zahlung zurückholen kannst, und fang mit einer kleinen an.",
            )}
          </p>
        </section>
      )}
    </>
  );
}
