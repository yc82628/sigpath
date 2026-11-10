import type { MetadataRoute } from "next";

/**
 * app/manifest.ts — SigPath as an app on a phone (/manifest.webmanifest).
 *
 * Installed from Chrome on Android ("Install app" or "Add to Home screen"),
 * SigPath opens like an app and, through `share_target`, appears in Android's
 * share menu: in the Amazon or eBay app, Share → SigPath sends the product to
 * /share, which searches every marketplace for it with a verdict on each offer.
 * Browser extensions don't run on phones; this is the phone's way to check a
 * price without leaving the shop's app for long.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SigPath — Deal Go, Scam Towed",
    short_name: "SigPath",
    description: "The real price of a product across marketplaces, with a scam check on every offer.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0a1a",
    theme_color: "#0b0a1a",
    categories: ["shopping"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // The Web Share Target shape (w3c.github.io/web-share-target): Next's type for it doesn't match the standard.
    share_target: {
      action: "/share",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    } as unknown as MetadataRoute.Manifest["share_target"],
  };
}
