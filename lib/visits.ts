/**
 * lib/visits.ts — what the visit counter (Vercel Web Analytics) is allowed to see.
 *
 * The counter answers "how many visits, to which kind of page, from where" and
 * nothing more. So before a page view leaves the browser, its address is cut
 * down to the page type:
 *   - everything after "?" or "#" goes: search words, checkout quotes;
 *   - order numbers, seller handles and business ids become placeholders.
 * That keeps the privacy page's promise that SigPath stores no searches, and
 * no order can be looked up from the counts.
 */

/** Dynamic routes in app/, as [pattern, placeholder path]. */
const DYNAMIC: [RegExp, string][] = [
  [/^\/order\/[^/]+\/?$/, "/order/[order]"],
  [/^\/report\/[^/]+\/?$/, "/report/[order]"],
  [/^\/business\/[^/]+\/?$/, "/business/[id]"],
  // Two segments after /seller: /seller/verify and /seller/business have one.
  [/^\/seller\/[^/]+\/[^/]+\/?$/, "/seller/[source]/[handle]"],
];

/** The address a page view is counted under, or null if it can't be read. */
export function countedUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = DYNAMIC.find(([re]) => re.test(u.pathname))?.[1] ?? u.pathname;
  return `${u.origin}${path}`;
}

/** On when the site runs on Vercel, the only place the counter can report to. */
export const visitCounterOn = (env: Record<string, string | undefined> = process.env) => env.VERCEL === "1";
