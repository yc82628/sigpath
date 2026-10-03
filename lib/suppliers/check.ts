/**
 * lib/suppliers/check.ts — check a supplier before ordering in bulk.
 *
 * A business gives what it knows: the supplier's VAT number, name, website
 * and/or marketplace account. Each is checked against an independent source,
 * and each finding says what was checked, what came back, and what it means:
 *
 *   vat        the EU's VIES register: is the number registered?
 *   name       does the name the supplier gave match the register's?
 *   website    the domain's registry (RDAP): does it exist, and since when?
 *              Scam shops are typically weeks old.
 *   sigpath    SigPath's own records: a verified seller or business? Any
 *              upheld fake-product reports? Does the account belong to a
 *              verified business with a DIFFERENT VAT number or website?
 *
 * WHAT IT NEVER SAYS
 * "Safe". The summary reports warning signs found, or none in the checks that
 * ran, and lists the checks that couldn't run. A clean report means nothing
 * contradicted the supplier's details, not that the goods will arrive.
 */

import { checkVat, normaliseDomain, normaliseVat, maskVat, VIES_COUNTRIES, businessView, type Business } from "../sellers/business";
import { badgeFor, type BadgeEntry } from "../sellers/verified-log";
import { sellerKey } from "../marketplace/types";
import { domainRegistration, type DomainRegistration } from "./rdap";

export type FindingState = "good" | "warn" | "bad" | "unknown";

export interface Finding {
  check: "vat" | "name" | "website" | "sigpath";
  state: FindingState;
  title: string;
  detail: string;
}

export type SummaryState = "concerns" | "warnings" | "verified" | "clear" | "insufficient";

export interface SupplierReport {
  checkedAt: number;
  summary: { state: SummaryState; headline: string };
  findings: Finding[];
  /** The SigPath business profile this supplier matched, if any. */
  businessProfile: string | null;
}

export interface SupplierInput {
  vatCountry?: string;
  vatNumber?: string;
  name?: string;
  domain?: string;
  marketplace?: string;
  handle?: string;
}

export interface SupplierDeps {
  fetchImpl?: typeof fetch;
  businesses: () => Promise<Record<string, Business>>;
  badges: () => Promise<Record<string, BadgeEntry>>;
  upheld: () => Promise<ReadonlyMap<string, number>>;
  /** Injected so tests needn't reach a registry. */
  registration?: (domain: string) => Promise<DomainRegistration>;
  now?: () => number;
}

const MARKET: Record<string, string> = { ebay: "eBay", etsy: "Etsy", amazon: "Amazon", stub: "the demo marketplace" };
const DAY = 86400 * 1000;

/** Legal forms and filler that differ between how a company writes its name and how a register does. */
const LEGAL_WORDS = new Set([
  "gmbh", "ag", "kg", "ohg", "ug", "ev", "mbh", "co", "company", "ltd", "limited", "llc", "inc", "plc", "llp", "lp",
  "sa", "sas", "sarl", "srl", "spa", "bv", "nv", "ab", "as", "oy", "aps", "sp", "zoo", "the", "and", "und", "et",
  "haftungsbeschrankt",
]);

export function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !LEGAL_WORDS.has(w));
}

/**
 * Does the name a supplier gave match the register's? Every distinctive word
 * the supplier used must appear in the registered name, ignoring legal forms
 * ("Acme Trading" matches "ACME TRADING GMBH"). Words only: no fuzzy spelling,
 * because a near-miss name is exactly what an impersonator registers.
 */
export function namesMatch(given: string, registered: string): boolean {
  const g = nameTokens(given);
  const r = new Set(nameTokens(registered));
  return g.length > 0 && g.every((w) => r.has(w));
}

function age(ms: number): string {
  const days = Math.floor(ms / DAY);
  if (days >= 730) return `${Math.floor(days / 365)} years`;
  if (days >= 60) return `${Math.floor(days / 30)} months`;
  return `${days} day${days === 1 ? "" : "s"}`;
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function checkSupplier(input: SupplierInput, deps: SupplierDeps): Promise<{ ok: true; report: SupplierReport } | { ok: false; error: string }> {
  const now = deps.now?.() ?? Date.now();
  const wantsVat = !!input.vatNumber?.trim();
  const vat = wantsVat ? normaliseVat(input.vatCountry ?? "", input.vatNumber ?? "") : null;
  const domain = input.domain?.trim() ? normaliseDomain(input.domain) : null;
  const handle = input.handle?.trim();
  const market = input.marketplace?.trim().toLowerCase();
  const name = input.name?.trim();

  if (wantsVat && !vat) return { ok: false, error: "That doesn't look like an EU VAT number. Pick the country and enter the number." };
  if (input.domain?.trim() && !domain) return { ok: false, error: "Enter the website as a domain, like example-shop.de." };
  if (handle && (!market || !MARKET[market])) return { ok: false, error: "Pick the marketplace the account is on." };
  if (!vat && !domain && !handle) return { ok: false, error: "Enter at least a VAT number, a website or a marketplace account." };

  const findings: Finding[] = [];
  const [businesses, badges, upheld] = await Promise.all([deps.businesses(), deps.badges(), deps.upheld()]);
  const nowS = Math.floor(now / 1000);

  // --- VAT and name, against the EU register -----------------------------------------
  let registeredName: string | null = null;
  if (vat) {
    const label = maskVat(vat.country, vat.number);
    const check = await checkVat(vat.country, vat.number, deps.fetchImpl);
    if (check.status === "valid") {
      registeredName = check.registeredName;
      findings.push({
        check: "vat",
        state: "good",
        title: "Registered business",
        detail: `VAT number ${label} is valid in the EU's VIES register (${VIES_COUNTRIES[vat.country]}).`,
      });
    } else if (check.status === "invalid") {
      findings.push({
        check: "vat",
        state: "bad",
        title: "VAT number not registered",
        detail: `The EU's VIES register says ${label} isn't a valid VAT number. Ask the supplier to confirm it: a real EU business trading with other businesses has one.`,
      });
    } else {
      findings.push({ check: "vat", state: "unknown", title: "VAT number not checked", detail: "The EU's VIES register isn't answering right now. Try again in a few minutes." });
    }
  }
  if (name) {
    if (!vat) {
      findings.push({ check: "name", state: "unknown", title: "Name not checked", detail: "A name can only be checked against the register together with a VAT number." });
    } else if (registeredName) {
      findings.push(
        namesMatch(name, registeredName)
          ? { check: "name", state: "good", title: "Name matches the register", detail: `The register gives the name as ${registeredName}.` }
          : {
              check: "name",
              state: "warn",
              title: "Name doesn't match the register",
              detail: `The register gives the name for this VAT number as ${registeredName}, not "${name}". Someone may be using another company's VAT number.`,
            },
      );
    } else if (findings.some((f) => f.check === "vat" && f.state === "good")) {
      findings.push({
        check: "name",
        state: "unknown",
        title: "Name not confirmed",
        detail: `${VIES_COUNTRIES[vat.country]} doesn't publish business names through the register, so "${name}" couldn't be compared.`,
      });
    }
  }

  // --- website, against its registry ------------------------------------------------------
  if (domain) {
    const reg = await (deps.registration ?? ((d) => domainRegistration(d, deps.fetchImpl, now)))(domain);
    if (reg.status === "not_registered") {
      findings.push({
        check: "website",
        state: "bad",
        title: "Website domain doesn't exist",
        detail: `${domain} isn't registered (checked with ${reg.registry}). A supplier's website that doesn't exist is a serious warning sign.`,
      });
    } else if (reg.status === "registered" && reg.registeredAt !== null) {
      const young = now - reg.registeredAt < 90 * DAY;
      findings.push({
        check: "website",
        state: young ? "warn" : "good",
        title: young ? "Very new website" : "Established website",
        detail: young
          ? `${domain} was registered on ${date(reg.registeredAt)}, only ${age(now - reg.registeredAt)} ago. Scam shops are typically weeks old.`
          : `${domain} was registered on ${date(reg.registeredAt)}, ${age(now - reg.registeredAt)} ago.`,
      });
    } else if (reg.status === "registered") {
      findings.push({
        check: "website",
        state: "unknown",
        title: "Website exists, age unknown",
        detail: `${domain} is registered, but its registry (${reg.registry}) doesn't publish when.`,
      });
    } else {
      findings.push({ check: "website", state: "unknown", title: "Website not checked", detail: reg.reason });
    }
  }

  // --- SigPath's own records ------------------------------------------------------------------
  const views = Object.values(businesses).map((b) => ({ b, v: businessView(b, badges, upheld, nowS) }));
  const byVat = vat ? views.find(({ b }) => b.vat?.country === vat.country && b.vat.number === vat.number) : undefined;
  const byDomain = domain ? views.find(({ b }) => b.domain?.name === domain) : undefined;
  const key = handle && market ? sellerKey(market, handle) : null;
  const byAccount = key ? views.find(({ v }) => v.accounts.some((a) => a.sellerKey === key)) : undefined;
  const matched = byVat ?? byDomain ?? byAccount;

  if (key) {
    const reports = upheld.get(key) ?? 0;
    const seller = badgeFor(key, badges, upheld, nowS);
    const where = `${handle} on ${MARKET[market!]}`;
    if (reports > 0) {
      findings.push({
        check: "sigpath",
        state: "bad",
        title: "Upheld fake-product reports",
        detail: `${reports} verified buyer${reports === 1 ? "'s" : "s'"} fake-product report${reports === 1 ? " was" : "s were"} upheld against ${where} after review.`,
      });
    } else if (seller) {
      findings.push({ check: "sigpath", state: "good", title: "Verified seller on SigPath", detail: `${where} proved control of the account and passed a live check. No upheld reports.` });
    } else {
      findings.push({ check: "sigpath", state: "unknown", title: "No SigPath record for this account", detail: `${where} isn't a verified seller, and has no upheld reports.` });
    }
  }

  if (matched) {
    const { v } = matched;
    // An account, VAT number or website that belongs to a DIFFERENT verified business than the other details.
    const conflicts = [
      byVat && byVat !== matched ? "VAT number" : null,
      byDomain && byDomain !== matched ? "website" : null,
      byAccount && byAccount !== matched ? "marketplace account" : null,
      vat && matched.b.vat && (matched.b.vat.country !== vat.country || matched.b.vat.number !== vat.number) ? "VAT number" : null,
      domain && matched.b.domain && matched.b.domain.name !== domain ? "website" : null,
    ].filter((x): x is string => x !== null);
    if (conflicts.length) {
      findings.push({
        check: "sigpath",
        state: "bad",
        title: "Details belong to a different business",
        detail: `The ${[...new Set(conflicts)].join(" and ")} you gave don't match the verified business these other details belong to. Someone may be borrowing a real business's identity.`,
      });
    } else if (v.status === "verified") {
      findings.push({
        check: "sigpath",
        state: "good",
        title: "Verified business on SigPath",
        detail: `${v.registeredName ?? `A business registered in ${v.countryName}`}: VAT checked ${date(v.vatCheckedAt! * 1000)}${v.domain ? `, controls ${v.domain}` : ""}, ${v.accounts.length} linked marketplace account${v.accounts.length === 1 ? "" : "s"}.`,
      });
    } else if (v.status === "suspended") {
      findings.push({ check: "sigpath", state: "bad", title: "SigPath business verification suspended", detail: v.statusReason ?? "" });
    }
  } else if (!key) {
    findings.push({ check: "sigpath", state: "unknown", title: "Not a verified business on SigPath", detail: "That isn't a warning sign on its own: most businesses haven't verified with SigPath." });
  }

  // --- the summary: never "safe" -------------------------------------------------------------
  const has = (s: FindingState) => findings.some((f) => f.state === s);
  const verified = findings.some((f) => f.check === "sigpath" && f.title === "Verified business on SigPath");
  const summary: SupplierReport["summary"] = has("bad")
    ? { state: "concerns", headline: "Warning signs found. Read these before ordering." }
    : has("warn")
      ? { state: "warnings", headline: "Some details don't add up. Check them with the supplier." }
      : verified
        ? { state: "verified", headline: "Verified business on SigPath, and nothing contradicts it." }
        : has("good")
          ? { state: "clear", headline: "No warning signs in the checks that ran." }
          : { state: "insufficient", headline: "Not enough could be checked to say anything." };

  return {
    ok: true,
    report: { checkedAt: now, summary, findings, businessProfile: matched && matched.v.status === "verified" ? `/business/${matched.b.id}` : null },
  };
}
