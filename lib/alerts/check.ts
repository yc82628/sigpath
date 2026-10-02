/**
 * lib/alerts/check.ts — run the watched searches, alert on new checked lows.
 *
 * Run on a schedule (scripts/alerts-check.ts, or POST /api/alerts/run from a
 * hosted cron). Each distinct search runs ONCE per pass however many browsers
 * watch it — the marketplace APIs have daily quotas, and twenty people
 * watching "airpods" is one query, not twenty.
 *
 * An alert needs all of:
 *   - a complete search (a marketplace not answering means no price verdict,
 *     so nothing is "checked", so nothing can fire — by construction)
 *   - the best SigPath-checked deal in the watched condition at or under the
 *     target, in the target's currency
 *   - a NEW low: lower than the last price this watch alerted on, so a deal
 *     that sits at €340 for a week is one notification, not seven
 */

import { formatMoney, type Listing } from "../marketplace/types";
import type { Analysis } from "../marketplace/anomaly";
import { describeSaving, labelSearch } from "../marketplace/label";
import { listingKey } from "../marketplace/types";
import { normaliseQuery, type Watch, type WatchStore } from "./watches";
import type { PushResult } from "./push";

export interface CheckReport {
  watches: number;
  searches: number;
  alerted: number;
  gone: number;
  expired: number;
  errors: string[];
}

export async function checkWatches(deps: {
  store: WatchStore;
  search: (query: string) => Promise<{ listings: Listing[]; analysis: Analysis }>;
  notify: (endpoint: string) => Promise<PushResult>;
  now?: number;
}): Promise<CheckReport> {
  const nowS = Math.floor((deps.now ?? Date.now()) / 1000);
  const report: CheckReport = { watches: 0, searches: 0, alerted: 0, gone: 0, expired: await deps.store.sweep(nowS), errors: [] };

  const byQuery = new Map<string, Watch[]>();
  for (const w of Object.values(await deps.store.all())) {
    report.watches++;
    const q = normaliseQuery(w.query);
    byQuery.set(q, [...(byQuery.get(q) ?? []), w]);
  }

  const toTickle = new Set<string>();
  for (const [query, watches] of byQuery) {
    let result;
    try {
      result = await deps.search(query);
      report.searches++;
    } catch (err) {
      report.errors.push(`"${query}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const { deals } = labelSearch(result);

    for (const w of watches) {
      const deal = deals.find((d) => d.group === w.group);
      const isNewLow =
        deal &&
        deal.total.currency === w.target.currency &&
        deal.total.amount <= w.target.amount &&
        (!w.lastAlerted || deal.total.amount < w.lastAlerted.amount);

      if (!deal || !isNewLow) {
        await deps.store.update(w.id, { lastCheckedAt: nowS });
        continue;
      }
      const saving = describeSaving(deal);
      await deps.store.update(w.id, {
        lastCheckedAt: nowS,
        lastAlerted: deal.total,
        pending: {
          title: `${formatMoney(deal.total)} — ${w.query}`,
          body: `SigPath-checked ${w.group} deal on ${deal.listing.source}: ${deal.listing.title}${saving ? `. ${saving[0].toUpperCase()}${saving.slice(1)}.` : "."}`,
          url: `/search?q=${encodeURIComponent(w.query)}&checked=1#l-${listingKey(deal.listing)}`,
          at: nowS,
        },
      });
      report.alerted++;
      toTickle.add(w.endpoint);
    }
  }

  // One push per browser, however many of its alerts fired: the inbox hands over all of them.
  for (const endpoint of toTickle) {
    const r = await deps.notify(endpoint);
    if (r === "gone") report.gone += await deps.store.removeEndpoint(endpoint);
    else if (r !== "sent") report.errors.push(`push: ${r.error}`);
  }
  return report;
}
