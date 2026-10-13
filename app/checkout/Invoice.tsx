"use client";

import type { Lang } from "@/lib/i18n/lang";
import type { Money } from "@/lib/marketplace/types";
import { decimalText, moneyText } from "@/lib/i18n/money";
import { useLang, useMessages } from "../components/I18n";

/**
 * The checkout's invoice: what is being bought, at what price, and every
 * conversion to USDC (the item, SigPath's fee, the total), as computed on the
 * server by the same code that builds the payment (invoiceFor in
 * lib/checkout/checkout.ts). After paying it gains the order numbers and a
 * print button. A summary of the payment, labelled as not a VAT invoice.
 */

export interface InvoiceData {
  lines: {
    source: string;
    id: string;
    title: string;
    url: string;
    amount: number;
    currency: string;
    itemUsdc: string;
    feeUsdc: string;
    totalUsdc: string;
    feeBps: number;
  }[];
  totalUsdc: string;
  localTotals: { amount: number; currency: string }[];
  rate: { display: string; source: string } | null;
}

/** USDC base units (6 decimals) as "283.0383": the same rule as the payment's own display. */
export function usdcNumber(base: string): string {
  const b = BigInt(base);
  const whole = b / 1_000_000n;
  let frac = (b % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}
export const usdc = (base: string, lang: Lang = "en") => `${decimalText(usdcNumber(base), lang)} USDC`;


const MARKET: Record<string, string> = { ebay: "eBay", amazon: "Amazon", aliexpress: "AliExpress", stub: "Demo", feed: "Partner feed" };

export default function Invoice({
  data,
  paid,
}: {
  data: InvoiceData;
  /** Once paid: each line's order, the paying wallet, and when. */
  paid?: { orders: Record<string, string>; wallet?: string; at: number };
}) {
  const m = useMessages();
  const lang = useLang();
  const formatMoney = (x: Money) => moneyText(x, lang);
  const num = (base: string) => decimalText(usdcNumber(base), lang);
  const pct = (bps: number) => `${(bps / 100).toLocaleString(lang === "de" ? "de-DE" : "en", { maximumFractionDigits: 2 })} %`;
  const currencies = [...new Set(data.lines.map((l) => l.currency))];
  const oneCurrency = currencies.length === 1 ? currencies[0] : null;
  const feeBps = data.lines[0]?.feeBps ?? 0;
  const sameFee = data.lines.every((l) => l.feeBps === feeBps);
  const date = new Date(paid?.at ?? Date.now()).toLocaleString(lang === "de" ? "de-DE" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
  const feeTotal = data.lines.reduce((t, l) => t + BigInt(l.feeUsdc), 0n);
  // Column names, also shown beside each value when a phone stacks the table.
  const cols = {
    price: m.invoice.price(oneCurrency ?? "EUR"),
    item: m.invoice.inUsdc,
    fee: m.invoice.fee(sameFee ? pct(feeBps) : "%"),
    total: `${m.invoice.total} (USDC)`,
  };
  const itemTotal = data.lines.reduce((t, l) => t + BigInt(l.itemUsdc), 0n);

  return (
    <section className="invoice" aria-label={m.invoice.title}>
      <header className="invoice-head">
        <div>
          <h2>{m.invoice.title}</h2>
          <p className="hint">{m.invoice.note}</p>
        </div>
        <dl>
          <dt>{m.invoice.date}</dt>
          <dd>{date}</dd>
          <dt>{m.invoice.paidTo}</dt>
          <dd>{m.invoice.escrow}</dd>
          {paid?.wallet && (
            <>
              <dt>{m.invoice.wallet}</dt>
              <dd>
                <code>
                  {paid.wallet.slice(0, 4)}…{paid.wallet.slice(-4)}
                </code>
              </dd>
            </>
          )}
        </dl>
      </header>

      <div className="invoice-table-wrap">
        <table className="invoice-table">
          <thead>
            <tr>
              <th scope="col">{m.invoice.item}</th>
              <th scope="col" className="num">
                {cols.price}
              </th>
              <th scope="col" className="num">
                {cols.item}
              </th>
              <th scope="col" className="num">
                {cols.fee}
              </th>
              <th scope="col" className="num">
                {cols.total}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => {
              const order = paid?.orders[`${l.source}:${l.id}`];
              return (
                <tr key={`${l.source}:${l.id}`}>
                  <th scope="row">
                    <a href={l.url} target="_blank" rel="noopener noreferrer">
                      {l.title}
                    </a>
                    <span className="hint">
                      {" "}
                      {MARKET[l.source] ?? l.source}
                      {order && (
                        <>
                          {" "}
                          &middot; {m.invoice.order} <a href={`/order/${order}`}>{order.slice(0, 6)}…</a>
                        </>
                      )}
                    </span>
                  </th>
                  <td className="num" data-label={cols.price}>{formatMoney({ amount: l.amount, currency: l.currency })}</td>
                  <td className="num" data-label={cols.item}>{num(l.itemUsdc)}</td>
                  <td className="num" data-label={cols.fee}>{num(l.feeUsdc)}</td>
                  <td className="num" data-label={cols.total}>
                    <strong>{num(l.totalUsdc)}</strong>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{m.invoice.subtotal}</th>
              <td className="num" data-label={cols.price}>{data.localTotals.map(formatMoney).join(" + ")}</td>
              <td className="num" data-label={cols.item}>{num(itemTotal.toString())}</td>
              <td className="num" data-label={cols.fee}>{num(feeTotal.toString())}</td>
              <td className="num invoice-total" data-label={cols.total}>{num(data.totalUsdc)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="invoice-pay">
        <span>{m.invoice.totalUsdc}</span> <strong>{usdc(data.totalUsdc, lang)}</strong>
      </p>
      <p className="hint">{data.rate ? m.invoice.rate(data.rate.display, m.invoice.rateSource(data.rate.source)) : m.invoice.usdOnly}</p>
      {feeBps > 0 && <p className="hint">{m.invoice.fees}</p>}
      {paid && (
        <p className="invoice-actions">
          <button type="button" className="button ghost" onClick={() => window.print()}>
            {m.invoice.print}
          </button>
        </p>
      )}
    </section>
  );
}
