/**
 * lib/legal/site.ts — what the Impressum and the privacy page say, read from
 * the deployment's own settings.
 *
 * WHY FROM SETTINGS
 * The operator's name and service address belong on the site, not in a public
 * repository, so the Impressum reads them from the environment. And a privacy
 * page is only true if it lists the services the site actually uses: each
 * outside provider below is named only when the feature that sends it data is
 * switched on, and named from the same setting the feature itself reads, so
 * the page cannot drift from the code.
 */

import { assistantConfig } from "../assistant/models";

type Env = Record<string, string | undefined>;

export interface Operator {
  name: string;
  /** Postal address, one line each: an Impressum service's address is fine. */
  address: string[];
  email: string;
  phone?: string;
  vatId?: string;
}

const clean = (v?: string) => v?.trim().replace(/^["']|["']$/g, "").trim() || undefined;

/** Null until name, address and email are all set. */
export function operator(env: Env = process.env): Operator | null {
  const name = clean(env.IMPRESSUM_NAME);
  const email = clean(env.IMPRESSUM_EMAIL);
  // One setting, lines separated by "|" or a newline (Vercel keeps either).
  const address = (clean(env.IMPRESSUM_ADDRESS) ?? "")
    .split(/\||\\n|\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!name || !email || !address.length || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return { name, address, email, phone: clean(env.IMPRESSUM_PHONE), vatId: clean(env.IMPRESSUM_VAT_ID) };
}

export const OWN_SERVER = "SigPath's own server";

const KNOWN_HOSTS: [RegExp, string][] = [
  [/(^|\.)googleapis\.com$/, "Google (Gemini API), USA"],
  [/(^|\.)anthropic\.com$/, "Anthropic PBC, USA"],
  [/(^|\.)openrouter\.ai$/, "OpenRouter, Inc., USA"],
  [/(^|\.)openai\.com$/, "OpenAI, USA"],
  [/(^|\.)groq\.com$/, "Groq, Inc., USA"],
  [/(^|\.)together\.(xyz|ai)$/, "Together AI, USA"],
  [/^(localhost|127\.0\.0\.1|\[::1\])$/, OWN_SERVER],
];

/** "an AI model from Google (Gemini API), USA", or "an AI model on SigPath's own server". */
export function modelPhrase(provider: string): string {
  return provider === OWN_SERVER ? "an AI model on SigPath's own server" : `an AI model from ${provider}`;
}

/** "Google (Gemini API), USA" for a known API host, else the host name itself. */
export function providerFor(url?: string): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return KNOWN_HOSTS.find(([re]) => re.test(host))?.[1] ?? host;
}

/** Who answers Ai-chan, when Ai-chan is on: the very config the chat itself uses. */
export function assistantProvider(env: Env = process.env): string | null {
  const config = assistantConfig(env);
  if (!config) return null;
  return config.provider === "anthropic" ? "Anthropic PBC, USA" : providerFor(config.baseUrl);
}

/** Who looks at live photos (reports, seller badges), when photo checks can run (lib/liveness/vision.ts). */
export function photoCheckProvider(env: Env = process.env): string | null {
  const b = (clean(env.VISION_BACKEND) ?? "anthropic").toLowerCase();
  if (b === "ollama") return providerFor(clean(env.OLLAMA_HOST) ?? "http://localhost:11434");
  if (b === "remote" || b === "openai" || b === "openrouter") {
    return clean(env.VISION_API_BASE) && clean(env.VISION_API_KEY) && clean(env.VISION_MODEL) ? providerFor(clean(env.VISION_API_BASE)) : null;
  }
  return clean(env.ANTHROPIC_API_KEY) ? "Anthropic PBC, USA" : null;
}

export const hasDatabase = (env: Env = process.env) =>
  !!(clean(env.KV_REST_API_URL) || clean(env.UPSTASH_REDIS_REST_URL));
export const hasPriceAlerts = (env: Env = process.env) => !!(clean(env.VAPID_PUBLIC_KEY) && clean(env.VAPID_PRIVATE_KEY));
export const hasCheckout = (env: Env = process.env) => !!(clean(env.ADDRESS_KEY) && clean(env.QUOTE_SECRET));
/** Reports need the same encryption key (app/api/reports/*). */
export const hasReports = (env: Env = process.env) => !!clean(env.ADDRESS_KEY);

/** The Associates tracking id, when set and well formed (lib/marketplace/registry.ts uses the same rule). */
export function amazonTag(env: Env = process.env): string | null {
  const tag = clean(env.AMAZON_PARTNER_TAG);
  return tag && /^[A-Za-z0-9-]{1,64}$/.test(tag) ? tag : null;
}

/** The Solana RPC host the site reads and sends transactions through. */
export function solanaRpcProvider(env: Env = process.env): string {
  const url = clean(env.NEXT_PUBLIC_RPC_URL) ?? "https://api.devnet.solana.com";
  try {
    const host = new URL(url).hostname;
    return /(^|\.)solana\.com$/.test(host) ? "the Solana Foundation's public RPC service" : host;
  } catch {
    return "a Solana RPC service";
  }
}
