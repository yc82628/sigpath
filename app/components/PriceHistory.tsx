import type { Messages } from "@/lib/i18n/messages";
import type { HistorySummary } from "@/lib/marketplace/history";

/**
 * A product's last 30 days on eBay (lib/marketplace/history.ts): the trend,
 * a small line of the typical price day by day, and the lowest of them. With
 * a price being checked, a dashed line marks it against the history.
 */
export default function PriceHistory({
  h,
  t,
  lang,
  money,
  price,
}: {
  h: HistorySummary;
  t: Messages["history"];
  lang: "en" | "de";
  money: (amount: number) => string;
  /** The price being judged, minor units, to mark on the line. */
  price?: number;
}) {
  const values = price ? [...h.series, price] : h.series;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || hi * 0.1 || 1;
  const W = 200;
  const H = 40;
  const y = (v: number) => (H - 4 - ((v - lo) / span) * (H - 8)).toFixed(1);
  const x = (i: number) => (h.series.length === 1 ? W / 2 : (i / (h.series.length - 1)) * W).toFixed(1);
  const points = h.series.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const day = new Date(`${h.low.day}T12:00:00Z`).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const arrow = h.trend === "falling" ? "↘" : h.trend === "rising" ? "↗" : "→";
  return (
    <div className="price-history">
      <p className="price-history-head">
        <b>{t.title}</b>
        {h.trend && (
          <span className={`price-history-trend ${h.trend}`}>
            {arrow} {t.trend[h.trend]}
          </span>
        )}
      </p>
      <svg className="price-history-line" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={t.chart(money(Math.min(...h.series)), money(Math.max(...h.series)))}>
        {price !== undefined && <line x1="0" x2={W} y1={y(price)} y2={y(price)} className="price-history-now" />}
        <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="hint">
        {t.low(money(h.low.amount), day)} · {t.days(h.days)}
        {price !== undefined && price < h.low.amount && <> · {t.below}</>}
      </p>
    </div>
  );
}
