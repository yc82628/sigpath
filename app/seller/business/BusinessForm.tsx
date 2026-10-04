"use client";

/**
 * The verified-business steps, in order:
 *   1. connect the wallet that holds the verified-seller badges
 *   2. see the accounts it links (verify one first if there are none)
 *   3. check the VAT number against the EU register (signed by the wallet)
 *   4. optionally, prove the website with a DNS record (signed again)
 */

import { useState } from "react";
import { bytesToBase64, getPhantom, walletErrorMessage } from "../../components/phantom";
// The browser-safe half: the server rebuilds exactly this text to verify the signature.
import { businessMessage, domainAction, vatAction } from "@/lib/sellers/business-message";
import type { BusinessStatus } from "@/lib/sellers/business-api";
import type { BusinessView } from "@/lib/sellers/business";

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
  const [wallet, setWallet] = useState<string | null>(null);
  const [status, setStatus] = useState<BusinessStatus | null>(null);
  const [business, setBusiness] = useState<BusinessView | null>(null);
  const [country, setCountry] = useState("DE");
  const [vatNumber, setVatNumber] = useState("");
  const [domain, setDomain] = useState("");
  const [record, setRecord] = useState<{ domain: string; record: { name: string; value: string } } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sign(action: string): Promise<{ time: string; signature: string } | null> {
    const phantom = getPhantom();
    if (!phantom || !wallet) return null;
    const time = new Date().toISOString();
    const { signature } = await phantom.signMessage(new TextEncoder().encode(businessMessage(action, wallet, time)), "utf8");
    return { time, signature: bytesToBase64(signature) };
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

  const connect = () =>
    run(async () => {
      const phantom = getPhantom();
      if (!phantom) {
        setError("Phantom wallet not found. Install it from phantom.app, set it to Devnet, and reload.");
        return;
      }
      const { publicKey } = await phantom.connect();
      const w = publicKey.toBase58();
      setWallet(w);
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
          <h2>1. Connect your wallet</h2>
          <p className="hint">The same wallet you used to verify your marketplace accounts.</p>
          <button type="button" className="primary" disabled={busy} onClick={connect}>
            Connect Phantom
          </button>
        </section>
      )}

      {wallet && status && (
        <section className="step">
          <h2>2. Your verified accounts</h2>
          {status.accounts.length === 0 ? (
            <p>
              This wallet hasn&apos;t verified any marketplace accounts yet. <a href="/seller/verify">Verify one first</a>, then
              come back.
            </p>
          ) : (
            <ul className="linked-accounts">
              {status.accounts.map((a) => (
                <li key={a.sellerKey}>
                  <strong>{a.handle}</strong> <span className="chip">{MARKET[a.source] ?? a.source}</span>{" "}
                  <span className="hint">{a.active ? "verified" : "badge not currently shown"}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">Verify more accounts with this wallet and they join your business automatically.</p>
        </section>
      )}

      {wallet && activeAccounts.length > 0 && (
        <section className="step">
          <h2>3. Your VAT number</h2>
          {business?.vatMasked ? (
            <p className="notice">
              ✓ <code>{business.vatMasked}</code> is valid in the EU register ({business.countryName})
              {business.registeredName ? <>, registered as <strong>{business.registeredName}</strong></> : <>; the register doesn&apos;t publish the name</>}.
            </p>
          ) : (
            <p className="hint">Checked live against the EU&apos;s VIES register. The name shown is the register&apos;s, not what you type.</p>
          )}
          <div className="form-row">
            <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country of registration">
              {COUNTRIES.map(([c, name]) => (
                <option key={c} value={c}>
                  {name}
                </option>
              ))}
            </select>
            <input value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} placeholder="VAT number" aria-label="VAT number" />
            <button type="button" className="primary" disabled={busy || vatNumber.trim().length < 2} onClick={checkVatNumber}>
              {business?.vatMasked ? "Check again" : "Check and sign"}
            </button>
          </div>
        </section>
      )}

      {wallet && activeAccounts.length > 0 && (
        <section className="step">
          <h2>4. Your website (optional)</h2>
          {business?.domain && <p className="notice">✓ Controls {business.domain}.</p>}
          {!record ? (
            <div className="form-row">
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example-shop.de" aria-label="Website domain" />
              <button type="button" disabled={busy || !domain.trim()} onClick={startWebsite}>
                Get the DNS record
              </button>
            </div>
          ) : (
            <>
              <p>Add this TXT record at your domain provider, then check it:</p>
              <dl className="dns-record">
                <dt>Name</dt>
                <dd><code>{record.record.name}</code></dd>
                <dt>Type</dt>
                <dd><code>TXT</code></dd>
                <dt>Value</dt>
                <dd><code>{record.record.value}</code></dd>
              </dl>
              <button type="button" className="primary" disabled={busy} onClick={verifyWebsite}>
                I&apos;ve added it: check and sign
              </button>
            </>
          )}
        </section>
      )}

      {business && business.status !== "verified" && (
        <p className="hint">
          Your <a href={`/business/${encodeURIComponent(business.id)}`}>public profile</a> shows what's verified so far.
        </p>
      )}
      {business?.status === "verified" && (
        <p className="notice">
          🎉 Your business is verified. <a href={`/business/${encodeURIComponent(business.id)}`}>See your public profile</a>, and link to it from
          your shop.
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
