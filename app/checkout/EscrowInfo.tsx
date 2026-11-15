"use client";

import { useMessages } from "../components/I18n";

/**
 * What happens to the shopper's money, worded for one item or several: shown by
 * the checkout form once a way that pays into the escrow is picked.
 */
export default function EscrowInfo({ count, windowDays, retentionDays }: { count: number; windowDays: number; retentionDays: number }) {
  const m = useMessages();
  const n = Math.max(1, count);
  return (
    <section className="guarantees">
      <h2>{m.checkout.moneyTitle}</h2>
      <ul>
        <li>{m.checkout.money1(n)}</li>
        <li>{m.checkout.money2(m.checkout.days(windowDays), n)}</li>
        <li>{m.checkout.money3(n)}</li>
      </ul>
      <p className="hint">{m.checkout.addressNote(m.checkout.days(retentionDays), n)}</p>
    </section>
  );
}
