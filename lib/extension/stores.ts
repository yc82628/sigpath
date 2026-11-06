/**
 * lib/extension/stores.ts — where to add the SigPath extension with one click.
 *
 * Until a store lists it, the extension is installed by hand ("Load unpacked"),
 * which asks a shopper to download a zip and switch on developer mode. Once a
 * store has approved it, its page goes in an environment variable and /extension
 * shows an "Add to …" button instead, the visitor's own browser first:
 *
 *   EXTENSION_CHROME_URL   Chrome Web Store: Chrome, and Brave, Edge, Opera and
 *                          Vivaldi, which all install from it too
 *   EXTENSION_FIREFOX_URL  addons.mozilla.org
 *   EXTENSION_EDGE_URL     Microsoft Edge Add-ons, optional (Edge takes Chrome's)
 *
 * Only each store's own address is accepted, so a typo can't send shoppers
 * somewhere else.
 */

export type Store = "chrome" | "firefox" | "edge";

const STORES: { id: Store; env: string; host: RegExp }[] = [
  { id: "chrome", env: "EXTENSION_CHROME_URL", host: /^https:\/\/chromewebstore\.google\.com\/detail\// },
  { id: "firefox", env: "EXTENSION_FIREFOX_URL", host: /^https:\/\/addons\.mozilla\.org\/([a-z-]+\/)?firefox\/addon\// },
  { id: "edge", env: "EXTENSION_EDGE_URL", host: /^https:\/\/microsoftedge\.microsoft\.com\/addons\/detail\// },
];

/** The stores that list the extension, in a fixed order. */
export function extensionStores(env: Record<string, string | undefined> = process.env): { id: Store; url: string }[] {
  return STORES.flatMap(({ id, env: key, host }) => {
    const url = env[key]?.trim().replace(/^(["'])(.*)\1$/, "$2");
    return url && host.test(url) ? [{ id, url }] : [];
  });
}

/** Which store suits the browser a page was opened in. Brave, Opera and Vivaldi read as Chrome. */
export function storeFor(userAgent: string | null | undefined): Store {
  const ua = userAgent ?? "";
  if (/\bFirefox\//.test(ua)) return "firefox";
  if (/\bEdg\//.test(ua)) return "edge";
  return "chrome";
}

/**
 * The stores to show, the visitor's own first. Edge without its own listing
 * takes Chrome's, which it installs from.
 */
export function storesForVisitor(stores: { id: Store; url: string }[], userAgent: string | null | undefined): { id: Store; url: string }[] {
  const mine = storeFor(userAgent);
  const want = mine === "edge" && !stores.some((s) => s.id === "edge") ? "chrome" : mine;
  return [...stores].sort((a, b) => Number(b.id === want) - Number(a.id === want));
}
