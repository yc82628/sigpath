/**
 * lib/alerts/api.ts — what the /api/alerts routes do, testable without HTTP.
 *
 * Every route that touches existing alerts takes the push ENDPOINT as its only
 * credential (see watches.ts). Request bodies are never logged: the endpoint
 * is a credential and the query is the shopper's.
 */

import { searchAll } from "../marketplace/search";
import { defaultSources } from "../marketplace/sources";
import { DecisionLog } from "../reports/reports";
import { checkWatches, type CheckReport } from "./check";
import { isPushEndpoint, sendTickle, vapidFromEnv } from "./push";
import { QUERY_MAX, WatchLimitError, WatchStore, type PendingAlert, type Watch } from "./watches";

type Env = Record<string, string | undefined>;
type Refusal = { ok: false; status: number; error: string };

export function endpointFrom(body: unknown): string | null {
  const e = (body as { endpoint?: unknown; subscription?: { endpoint?: unknown } } | null) ?? {};
  const raw = typeof e.endpoint === "string" ? e.endpoint : typeof e.subscription?.endpoint === "string" ? e.subscription.endpoint : null;
  return raw && raw.length <= 1000 && isPushEndpoint(raw) ? raw : null;
}

/** What a browser may see of its own alerts: never the endpoint. */
export function publicWatch(w: Watch) {
  return { id: w.id, query: w.query, group: w.group, target: w.target, expiresAt: w.expiresAt, lastAlerted: w.lastAlerted };
}

export async function createWatch(
  body: Record<string, unknown>,
  deps: { store: WatchStore; env?: Env; now?: number },
): Promise<{ ok: true; watch: ReturnType<typeof publicWatch> } | Refusal> {
  if (!vapidFromEnv(deps.env ?? process.env)) return { ok: false, status: 503, error: "Price alerts aren't configured on this server (VAPID keys)." };
  const endpoint = endpointFrom(body);
  if (!endpoint) return { ok: false, status: 400, error: "That isn't a browser push subscription." };
  const query = typeof body.query === "string" ? body.query.trim().replace(/\s+/g, " ") : "";
  if (!query || query.length > QUERY_MAX) return { ok: false, status: 400, error: `Search text must be 1 to ${QUERY_MAX} characters.` };
  const group = body.group === "used" ? "used" : body.group === "new" ? "new" : null;
  if (!group) return { ok: false, status: 400, error: "Choose new or used." };
  const t = body.target as { amount?: unknown; currency?: unknown } | undefined;
  const amount = t?.amount;
  const currency = typeof t?.currency === "string" ? t.currency.toUpperCase() : "";
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > 10_000_000 || !/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, status: 400, error: "Enter a target price." };
  }
  try {
    const w = await deps.store.add({ endpoint, query, group, target: { amount, currency } }, Math.floor((deps.now ?? Date.now()) / 1000));
    return { ok: true, watch: publicWatch(w) };
  } catch (err) {
    if (err instanceof WatchLimitError) return { ok: false, status: 409, error: err.message };
    throw err;
  }
}

export async function listWatches(body: unknown, store: WatchStore) {
  const endpoint = endpointFrom(body);
  if (!endpoint) return { ok: false as const, status: 400, error: "That isn't a browser push subscription." };
  return { ok: true as const, watches: (await store.forEndpoint(endpoint)).map(publicWatch) };
}

export async function deleteWatch(body: Record<string, unknown>, store: WatchStore) {
  const endpoint = endpointFrom(body);
  if (!endpoint) return { ok: false as const, status: 400, error: "That isn't a browser push subscription." };
  if (body.all === true) return { ok: true as const, deleted: await store.removeEndpoint(endpoint) };
  const removed = typeof body.id === "string" && (await store.remove(body.id, endpoint));
  return removed ? { ok: true as const, deleted: 1 } : { ok: false as const, status: 404, error: "No such alert for this browser." };
}

export async function collectInbox(body: unknown, store: WatchStore): Promise<{ ok: true; alerts: PendingAlert[] } | Refusal> {
  const endpoint = endpointFrom(body);
  if (!endpoint) return { ok: false, status: 400, error: "That isn't a browser push subscription." };
  return { ok: true, alerts: await store.collect(endpoint) };
}

/** The scheduled pass, wired to the real search and the real push services. */
export async function runAlertCheck(env: Env = process.env): Promise<CheckReport | Refusal> {
  const vapid = vapidFromEnv(env);
  if (!vapid) return { ok: false, status: 503, error: "VAPID keys are not configured." };
  const decisions = DecisionLog.fromEnv(env);
  return checkWatches({
    store: WatchStore.fromEnv(env),
    // The same search, sources and upheld-report flags as the search page.
    search: async (q) => searchAll(q, defaultSources(env), { limit: 20 }, { upheldReports: await decisions.upheldCounts() }),
    notify: (endpoint) => sendTickle(endpoint, vapid),
  });
}
