"use client";

/**
 * The supplier check form and its report. Nothing is kept: the details are
 * sent once to /api/suppliers/check and the report lives only on this page.
 */

import { useState } from "react";
import type { SupplierReport } from "@/lib/suppliers/check";

const COUNTRIES: [string, string][] = [
  ["AT", "Austria"], ["BE", "Belgium"], ["BG", "Bulgaria"], ["HR", "Croatia"], ["CY", "Cyprus"], ["CZ", "Czechia"],
  ["DK", "Denmark"], ["EE", "Estonia"], ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"], ["EL", "Greece"],
  ["HU", "Hungary"], ["IE", "Ireland"], ["IT", "Italy"], ["LV", "Latvia"], ["LT", "Lithuania"], ["LU", "Luxembourg"],
  ["MT", "Malta"], ["NL", "Netherlands"], ["XI", "Northern Ireland"], ["PL", "Poland"], ["PT", "Portugal"],
  ["RO", "Romania"], ["SK", "Slovakia"], ["SI", "Slovenia"], ["ES", "Spain"], ["SE", "Sweden"],
];

const ICON = { good: "✓", warn: "!", bad: "✕", unknown: "–" } as const;

export default function SupplierCheck() {
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
      else setError((json as { error?: string }).error ?? "Something went wrong.");
    } catch {
      setError("Couldn't reach SigPath. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="supplier-form" onSubmit={run}>
        <label>
          Supplier name <span className="hint">(as they gave it)</span>
          <input value={f.name} onChange={set("name")} placeholder="Acme Trading GmbH" />
        </label>
        <label>
          EU VAT number
          <span className="form-row">
            <select value={f.vatCountry} onChange={set("vatCountry")} aria-label="VAT country">
              {COUNTRIES.map(([c, n]) => (
                <option key={c} value={c}>
                  {n}
                </option>
              ))}
            </select>
            <input value={f.vatNumber} onChange={set("vatNumber")} placeholder="123456789" aria-label="VAT number" />
          </span>
        </label>
        <label>
          Website
          <input value={f.domain} onChange={set("domain")} placeholder="acme-trading.de" />
        </label>
        <label>
          Marketplace account
          <span className="form-row">
            <select value={f.marketplace} onChange={set("marketplace")} aria-label="Marketplace">
              <option value="ebay">eBay</option>
              <option value="etsy">Etsy</option>
              <option value="amazon">Amazon</option>
            </select>
            <input value={f.handle} onChange={set("handle")} placeholder="seller name" aria-label="Seller name on the marketplace" />
          </span>
        </label>
        <p className="hint">Fill in what you have; one detail is enough, more is better. Nothing is saved.</p>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Checking…" : "Check this supplier"}
        </button>
      </form>

      {error && (
        <p className="notice withheld" role="alert">
          {error}
        </p>
      )}

      {report && (
        <section className={`supplier-report ${report.summary.state}`} aria-live="polite">
          <h2>{report.summary.headline}</h2>
          <ul className="findings">
            {report.findings.map((x, i) => (
              <li key={i} className={x.state}>
                <span className="finding-icon" aria-hidden="true">
                  {ICON[x.state]}
                </span>
                <span>
                  <strong>{x.title}</strong>
                  <span className="finding-detail">{x.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          {report.businessProfile && (
            <p>
              <a href={report.businessProfile}>See their SigPath business profile &rarr;</a>
            </p>
          )}
          <p className="hint">
            Checked {new Date(report.checkedAt).toLocaleString()}. These checks confirm who you&apos;re dealing with, not that an
            order will arrive. For large orders, pay in a way you can reverse, and start with a small one.
          </p>
        </section>
      )}
    </>
  );
}
