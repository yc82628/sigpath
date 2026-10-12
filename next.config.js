/**
 * Security headers on every response.
 *
 * The Content-Security-Policy allows only what SigPath's pages use: its own
 * scripts and styles (Next.js inlines some, hence 'unsafe-inline'; React's dev
 * server also needs 'unsafe-eval', in development only), listing photos from
 * any https host (eBay, AliExpress), fonts self-hosted by next/font, and
 * fetches to https and wss (the Solana RPC the wallet talks to). No plugins,
 * no <base> rewriting, forms only to SigPath itself, and no other site may
 * frame it, which is what stops clickjacking a "Pay with USDC" button.
 *
 * Permissions-Policy: the camera is SigPath's own (the live-photo check);
 * microphone, location, payment and the rest are off. The referrer sent to
 * eBay or AliExpress is the origin only, never the search in the URL.
 */
const dev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()",
  },
  // A popup SigPath opens (MoonPay) stays usable; no other window gets a handle on SigPath's.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  // No "X-Powered-By: Next.js": nothing gained by announcing it.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
