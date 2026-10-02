/**
 * lib/alerts/push.ts — Web Push without a dependency, and without a payload.
 *
 * A browser that allows notifications gives SigPath a push SUBSCRIPTION: an
 * endpoint URL at its vendor's push service (Google's for Chrome, Mozilla's for
 * Firefox, Apple's for Safari). That is the whole "account": no email, no
 * name, nothing that identifies the person. The push service only accepts
 * messages signed with the VAPID key the subscription was created for, so a
 * leaked endpoint is useless to anyone without SigPath's private key.
 *
 * WHY THE PUSH CARRIES NOTHING
 * A push with a payload must be encrypted to the browser's keys (RFC 8291).
 * Instead SigPath sends an EMPTY push — a tickle — and the service worker
 * asks /api/alerts/inbox what happened, presenting its endpoint. So nothing
 * about the deal ever passes through the vendor's push service, and there is
 * no payload encryption to get wrong.
 *
 * VAPID (RFC 8292): a short-lived ES256 JWT for the push service's origin,
 * plus SigPath's public key, in the Authorization header. Signed here with
 * Node's own crypto.
 */

import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "crypto";

type Env = Record<string, string | undefined>;

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url — what the browser's subscribe() takes. */
  publicKey: string;
  privateKey: KeyObject;
  /** "mailto:…" or an https URL: push services want a contact for the sender. */
  subject: string;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** A fresh key pair, as the two base64url strings .env.local stores. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), fromB64url(pub.x!), fromB64url(pub.y!)]);
  return { publicKey: b64url(point), privateKey: priv.d! };
}

export function vapidFromEnv(env: Env = process.env): VapidKeys | null {
  const pub = env.VAPID_PUBLIC_KEY?.trim();
  const d = env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !d) return null;
  const point = fromB64url(pub);
  if (point.length !== 65 || point[0] !== 4) return null;
  try {
    const privateKey = createPrivateKey({
      key: { kty: "EC", crv: "P-256", x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)), d },
      format: "jwk",
    });
    return { publicKey: pub, privateKey, subject: env.VAPID_SUBJECT?.trim() || "mailto:alerts@sigpath.invalid" };
  } catch {
    return null;
  }
}

/** The VAPID JWT for one push service origin. ES256, raw r||s signature as JWS requires. */
export function vapidJwt(audience: string, keys: VapidKeys, nowS = Math.floor(Date.now() / 1000)): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // 12 hours: under the 24h maximum push services accept.
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: nowS + 12 * 3600, sub: keys.subject })));
  const sig = sign("sha256", Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(sig)}`;
}

export type PushResult = "sent" | "gone" | { error: string };

/** Only real push services: an endpoint is attacker-supplied, and this server must not be a request relay. */
export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return [
    /(^|\.)fcm\.googleapis\.com$/,
    /(^|\.)android\.googleapis\.com$/,
    /(^|\.)push\.services\.mozilla\.com$/,
    /(^|\.)notify\.windows\.com$/,
    /(^|\.)push\.apple\.com$/,
  ].some((re) => re.test(u.hostname));
}

/** Send an empty push. "gone" means the browser unsubscribed: delete its alerts. */
export async function sendTickle(endpoint: string, keys: VapidKeys, fetchImpl: typeof fetch = fetch): Promise<PushResult> {
  if (!isPushEndpoint(endpoint)) return { error: "not a push service endpoint" };
  const audience = new URL(endpoint).origin;
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `vapid t=${vapidJwt(audience, keys)}, k=${keys.publicKey}`,
        ttl: String(24 * 3600),
        urgency: "normal",
        "content-length": "0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) return "gone";
    if (res.status >= 200 && res.status < 300) return "sent";
    return { error: `push service returned ${res.status}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
