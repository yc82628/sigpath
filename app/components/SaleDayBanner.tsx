"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { berlinDate, saleDayOn, saleDayPreview, type SaleDay } from "@/lib/sale-days";

/**
 * On the big sale days, a line at the top of every page (lib/sale-days.ts).
 * Worked out in the browser, so a cached page never shows yesterday's banner.
 * `?saleday=black-friday` previews one on any day.
 */
export default function SaleDayBanner() {
  const [sale, setSale] = useState<SaleDay | null>(null);

  useEffect(() => {
    const preview = saleDayPreview(new URLSearchParams(window.location.search).get("saleday"));
    const { year, month, day } = berlinDate();
    setSale(preview ?? saleDayOn(year, month, day));
  }, []);

  if (!sale) return null;
  return (
    <div className="sale-day" role="note">
      <p>
        <strong>{sale.message}</strong> <Link href="/how">How SigPath checks →</Link>
      </p>
    </div>
  );
}
