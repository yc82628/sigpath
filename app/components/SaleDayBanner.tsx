"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { berlinDate, MESSAGES_DE, saleDayOn, saleDayPreview, type SaleDay } from "@/lib/sale-days";
import { useLang, useMessages } from "./I18n";

/**
 * On the big sale days, a line at the top of every page (lib/sale-days.ts).
 * Worked out in the browser, so a cached page never shows yesterday's banner.
 * `?saleday=black-friday` previews one on any day.
 */
export default function SaleDayBanner() {
  const [sale, setSale] = useState<SaleDay | null>(null);
  const lang = useLang();
  const m = useMessages();

  useEffect(() => {
    const preview = saleDayPreview(new URLSearchParams(window.location.search).get("saleday"));
    const { year, month, day } = berlinDate();
    setSale(preview ?? saleDayOn(year, month, day));
  }, []);

  if (!sale) return null;
  return (
    <div className="sale-day" role="note">
      <p>
        <strong>{lang === "de" ? MESSAGES_DE[sale.id] : sale.message}</strong> <Link href="/how">{m.saleDay.how}</Link>
      </p>
    </div>
  );
}
