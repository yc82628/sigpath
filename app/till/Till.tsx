"use client";

import { useEffect, useState } from "react";
import { useLang } from "../components/I18n";
import { moneyText } from "@/lib/i18n/money";
import { cleanName, epcPayload, formatIban, normaliseIban, parseEuroCents, paymentReference, salesCsv, validIban, type TillSale } from "@/lib/till/epc";

/**
 * The shop till (lib/till/epc.ts): type an amount, show a bank QR code, the
 * customer pays from their banking app, the shop confirms once the money shows
 * in its own banking app. Everything stays on this device: the shop's details
 * and the day's list are in this browser's storage, and the code is drawn here.
 */

const SETUP_KEY = "sigpath-till-v1";
const SALES_KEY = "sigpath-till-sales-v1";
/** Older sales are dropped from the device. */
const KEEP_DAYS = 31;

type Setup = { shop: string; holder: string; iban: string };

const en = {
  setupTitle: "Set up your till",
  setupText: "Once per device. Your details stay on this device: SigPath stores nothing and never touches the money.",
  shop: "Shop name (shown in the payment reference)",
  holder: "Account holder, exactly as at your bank",
  holderHint: "Banks compare this name with the account before the customer pays. If it differs, the customer sees a warning.",
  iban: "IBAN",
  badIban: "That IBAN doesn't check out. Look at it again.",
  missing: "Fill in all three fields.",
  save: "Save",
  amount: "Amount",
  amountHint: "0,00",
  badAmount: "Enter an amount between 0,01 € and 1.000 €.",
  show: "Show QR code",
  making: "Creating the code…",
  scan: "The customer scans this code with their banking app and confirms the transfer.",
  wait: "Only confirm once the money shows in your banking app. Instant transfers arrive in seconds; a normal transfer only arrives the next banking day.",
  paidButton: "Payment has arrived",
  cancel: "Cancel",
  paid: (amount: string) => `${amount} paid.`,
  to: "To",
  reference: "Reference",
  today: "Today",
  none: "No sales yet today.",
  total: (amount: string, n: number) => `${amount} received in ${n} payment${n === 1 ? "" : "s"}`,
  statusWord: { paid: "paid", cancelled: "cancelled" },
  csv: "Download today as CSV",
  csvHeader: { number: "No.", time: "Time", amount: "Amount (EUR)", reference: "Reference", status: "Status" },
  edit: "Change account details",
  wipe: "Delete everything on this device",
  wipeConfirm: "Delete the account details and every sale stored on this device?",
  register: "This till doesn't replace a certified cash register: record every sale there too.",
  qrAlt: (amount: string) => `Bank QR code for ${amount}`,
};
const de: typeof en = {
  setupTitle: "Kasse einrichten",
  setupText: "Einmal pro Gerät. Deine Angaben bleiben auf diesem Gerät: SigPath speichert nichts und berührt das Geld nie.",
  shop: "Name des Ladens (steht im Verwendungszweck)",
  holder: "Kontoinhaber, genau wie bei deiner Bank",
  holderHint: "Banken gleichen diesen Namen vor der Zahlung mit dem Konto ab. Weicht er ab, sieht der Kunde eine Warnung.",
  iban: "IBAN",
  badIban: "Diese IBAN stimmt nicht. Prüfe sie noch einmal.",
  missing: "Fülle alle drei Felder aus.",
  save: "Speichern",
  amount: "Betrag",
  amountHint: "0,00",
  badAmount: "Gib einen Betrag zwischen 0,01 € und 1.000 € ein.",
  show: "QR-Code zeigen",
  making: "Code wird erstellt…",
  scan: "Der Kunde scannt diesen Code mit seiner Banking-App und bestätigt die Überweisung.",
  wait: "Bestätige erst, wenn das Geld in deiner Banking-App zu sehen ist. Echtzeitüberweisungen kommen in Sekunden an, eine normale Überweisung erst am nächsten Bankarbeitstag.",
  paidButton: "Zahlung ist angekommen",
  cancel: "Abbrechen",
  paid: (amount) => `${amount} bezahlt.`,
  to: "An",
  reference: "Verwendungszweck",
  today: "Heute",
  none: "Heute noch keine Verkäufe.",
  total: (amount, n) => `${amount} eingenommen in ${n} ${n === 1 ? "Zahlung" : "Zahlungen"}`,
  statusWord: { paid: "bezahlt", cancelled: "abgebrochen" },
  csv: "Heute als CSV herunterladen",
  csvHeader: { number: "Nr.", time: "Zeit", amount: "Betrag (EUR)", reference: "Verwendungszweck", status: "Status" },
  edit: "Kontodaten ändern",
  wipe: "Alles auf diesem Gerät löschen",
  wipeConfirm: "Die Kontodaten und alle auf diesem Gerät gespeicherten Verkäufe löschen?",
  register: "Diese Kasse ersetzt keine zertifizierte Registrierkasse: Buche jeden Verkauf auch dort.",
  qrAlt: (amount) => `Bank-QR-Code über ${amount}`,
};

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or storage blocked: the till still works for this visit */
  }
}

const dayOf = (ms: number) => new Date(ms).toDateString();

export default function Till() {
  const lang = useLang();
  const t = lang === "de" ? de : en;
  const euro = (cents: number) => moneyText({ amount: cents, currency: "EUR" }, lang);

  const [loaded, setLoaded] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Setup>({ shop: "", holder: "", iban: "" });
  const [formError, setFormError] = useState("");
  const [sales, setSales] = useState<TillSale[]>([]);
  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState("");
  const [open, setOpen] = useState<{ cents: number; reference: string; svg: string; n: number } | null>(null);
  const [done, setDone] = useState("");
  const [making, setMaking] = useState(false);

  useEffect(() => {
    const s = read<Setup>(SETUP_KEY);
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    const kept = (read<TillSale[]>(SALES_KEY) ?? []).filter((x) => x && typeof x.at === "number" && x.at > cutoff);
    setSetup(s && s.holder && validIban(s.iban) ? s : null);
    if (s) setForm(s);
    setSales(kept);
    setLoaded(true);
  }, []);

  // Load the QR drawing code ahead of the first sale, so the first code appears at once.
  useEffect(() => {
    if (setup) import("qrcode").catch(() => undefined);
  }, [setup]);

  const saveSales = (next: TillSale[]) => {
    setSales(next);
    write(SALES_KEY, next);
  };

  function saveSetup(e: React.FormEvent) {
    e.preventDefault();
    const next = { shop: cleanName(form.shop), holder: cleanName(form.holder), iban: normaliseIban(form.iban) };
    if (!next.shop || !next.holder || !next.iban) return setFormError(t.missing);
    if (!validIban(next.iban)) return setFormError(t.badIban);
    write(SETUP_KEY, next);
    setSetup(next);
    setEditing(false);
    setFormError("");
  }

  async function showCode(e: React.FormEvent) {
    e.preventDefault();
    if (!setup || making) return;
    const cents = parseEuroCents(amount);
    if (!cents) return setAmountError(t.badAmount);
    setAmountError("");
    setDone("");
    const now = new Date();
    const n = sales.filter((s) => dayOf(s.at) === now.toDateString()).length + 1;
    const reference = paymentReference(setup.shop, now, n);
    const payload = epcPayload({ name: setup.holder, iban: setup.iban, cents, text: reference });
    setMaking(true);
    try {
      const QR = await import("qrcode");
      // Level M is what the EPC guidelines ask for.
      const svg = await QR.toString(payload, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#0b0a1a", light: "#ffffff" } });
      setOpen({ cents, reference, svg, n });
    } finally {
      setMaking(false);
    }
  }

  function close(status: TillSale["status"]) {
    if (!open) return;
    saveSales([...sales, { n: open.n, cents: open.cents, at: Date.now(), reference: open.reference, status }]);
    if (status === "paid") setDone(t.paid(euro(open.cents)));
    setOpen(null);
    setAmount("");
  }

  function downloadCsv() {
    const today = sales.filter((s) => dayOf(s.at) === new Date().toDateString());
    const csv = salesCsv(today, t.csvHeader, (s) => t.statusWord[s]);
    // A byte-order mark, so spreadsheet programs read the umlauts as UTF-8.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kasse-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function wipe() {
    if (!window.confirm(t.wipeConfirm)) return;
    write(SETUP_KEY, null);
    write(SALES_KEY, null);
    setSetup(null);
    setSales([]);
    setForm({ shop: "", holder: "", iban: "" });
    setOpen(null);
  }

  if (!loaded) return null;

  if (!setup || editing) {
    return (
      <form className="till-setup" onSubmit={saveSetup} noValidate>
        <h2>{t.setupTitle}</h2>
        <p className="hint">{t.setupText}</p>
        <label>
          {t.shop}
          <input value={form.shop} onChange={(e) => setForm({ ...form, shop: e.target.value })} maxLength={80} autoComplete="organization" />
        </label>
        <label>
          {t.holder}
          <input value={form.holder} onChange={(e) => setForm({ ...form, holder: e.target.value })} maxLength={70} autoComplete="name" />
          <span className="hint">{t.holderHint}</span>
        </label>
        <label>
          {t.iban}
          <input
            value={form.iban}
            onChange={(e) => setForm({ ...form, iban: e.target.value })}
            maxLength={42}
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
          />
        </label>
        {formError && (
          <p className="notice withheld" role="alert">
            {formError}
          </p>
        )}
        <p>
          <button type="submit" className="primary">
            {t.save}
          </button>
        </p>
      </form>
    );
  }

  const today = sales.filter((s) => dayOf(s.at) === new Date().toDateString());
  const paidToday = today.filter((s) => s.status === "paid");
  const totalCents = paidToday.reduce((t2, s) => t2 + s.cents, 0);

  return (
    <div className="till">
      {open ? (
        <section className="till-qr" aria-live="polite">
          <p className="till-amount">{euro(open.cents)}</p>
          <div className="qr-code" role="img" aria-label={t.qrAlt(euro(open.cents))} dangerouslySetInnerHTML={{ __html: open.svg }} />
          <p>{t.scan}</p>
          <dl className="till-facts">
            <dt>{t.to}</dt>
            <dd>
              {setup.holder}
              <br />
              {formatIban(setup.iban)}
            </dd>
            <dt>{t.reference}</dt>
            <dd>{open.reference}</dd>
          </dl>
          <p className="hint">{t.wait}</p>
          <p className="till-actions">
            <button type="button" className="primary" onClick={() => close("paid")}>
              {t.paidButton}
            </button>
            <button type="button" className="button ghost" onClick={() => close("cancelled")}>
              {t.cancel}
            </button>
          </p>
        </section>
      ) : (
        <form className="till-entry" onSubmit={showCode} noValidate>
          <label htmlFor="till-amount">{t.amount}</label>
          <div className="till-entry-row">
            <input
              id="till-amount"
              className="till-input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder={t.amountHint}
              autoComplete="off"
              autoFocus
            />
            <span className="till-euro">€</span>
          </div>
          {amountError && (
            <p className="notice withheld" role="alert">
              {amountError}
            </p>
          )}
          {done && (
            <p className="notice till-done" role="status">
              ✓ {done}
            </p>
          )}
          <p>
            <button type="submit" className="primary" disabled={making} aria-busy={making}>
              {making ? t.making : t.show}
            </button>
          </p>
        </form>
      )}

      <section className="till-today">
        <h2>{t.today}</h2>
        {today.length === 0 ? (
          <p className="hint">{t.none}</p>
        ) : (
          <>
            <p>
              <strong>{t.total(euro(totalCents), paidToday.length)}</strong>
            </p>
            <ol className="till-list">
              {[...today].reverse().map((s) => (
                <li key={`${s.at}-${s.n}`} className={s.status}>
                  <span>Nr. {s.n}</span>
                  <span>{new Date(s.at).toLocaleTimeString(lang === "de" ? "de-DE" : "en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="till-sum">{euro(s.cents)}</span>
                  <span>{t.statusWord[s.status]}</span>
                </li>
              ))}
            </ol>
            <p>
              <button type="button" className="button ghost" onClick={downloadCsv}>
                {t.csv}
              </button>
            </p>
          </>
        )}
        <p className="hint">{t.register}</p>
        <p className="till-settings">
          <button type="button" className="link" onClick={() => setEditing(true)}>
            {t.edit}
          </button>
          <button type="button" className="link" onClick={wipe}>
            {t.wipe}
          </button>
        </p>
      </section>
    </div>
  );
}
