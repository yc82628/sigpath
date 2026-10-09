/**
 * lib/suppliers/rdap.ts — when was a domain registered? (RDAP)
 *
 * RDAP is the registries' own public lookup, the successor to WHOIS, with
 * JSON answers. IANA publishes which server answers for each top-level domain;
 * asking THAT server means "not found" really means "not registered", rather
 * than "this lookup service doesn't cover that TLD".
 *
 * Some registries don't publish the registration date (DENIC, for .de, gives
 * only "last changed"). Then the domain is confirmed to exist and the date is
 * reported as not published. Never guessed.
 *
 * Only registry servers are ever contacted, with the domain as a path segment:
 * nothing here fetches a URL a user typed.
 */

const IANA_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";

/** Registries missing from IANA's file that do run RDAP. */
const EXTRA_SERVERS: Record<string, string> = { de: "https://rdap.denic.de/" };

export type DomainRegistration =
  | { status: "registered"; registeredAt: number | null; registry: string }
  | { status: "not_registered"; registry: string }
  | { status: "unknown"; reason: string };

let bootstrap: { at: number; servers: Map<string, string> } | null = null;

async function serverFor(tld: string, fetchImpl: typeof fetch, now: number): Promise<string | null> {
  if (EXTRA_SERVERS[tld]) return EXTRA_SERVERS[tld];
  if (!bootstrap || now - bootstrap.at > 24 * 3600 * 1000) {
    const res = await fetchImpl(IANA_BOOTSTRAP, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`IANA bootstrap answered ${res.status}`);
    const json = (await res.json()) as { services: [string[], string[]][] };
    const servers = new Map<string, string>();
    for (const [tlds, urls] of json.services) {
      const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];
      for (const t of tlds) servers.set(t.toLowerCase(), url);
    }
    bootstrap = { at: now, servers };
  }
  return bootstrap.servers.get(tld) ?? null;
}

export async function domainRegistration(domain: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<DomainRegistration> {
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  let server: string | null;
  try {
    server = await serverFor(tld, fetchImpl, now);
  } catch {
    return { status: "unknown", reason: "The registry directory couldn't be reached." };
  }
  if (!server) return { status: "unknown", reason: `The .${tld} registry doesn't offer public lookups.` };
  const registry = new URL(server).hostname;
  try {
    const res = await fetchImpl(`${server.replace(/\/?$/, "/")}domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json, application/json" },
      // A domain registered since the last check must not read as missing.
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return { status: "not_registered", registry };
    if (!res.ok) return { status: "unknown", reason: `The registry answered ${res.status}.` };
    const body = (await res.json()) as { events?: { eventAction?: string; eventDate?: string }[] };
    const reg = body.events?.find((e) => e.eventAction === "registration")?.eventDate;
    const at = reg ? Date.parse(reg) : NaN;
    return { status: "registered", registeredAt: Number.isFinite(at) ? at : null, registry };
  } catch {
    return { status: "unknown", reason: "The registry didn't answer in time." };
  }
}

/** Tests only. */
export function _resetRdapCache() {
  bootstrap = null;
}
