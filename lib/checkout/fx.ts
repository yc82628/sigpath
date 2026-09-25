/**
 * lib/checkout/fx.ts — euro prices to USDC.
 *
 * USDC tracks the US dollar, and most listings here are priced in euros, so
 * every checkout needs an exchange rate. The rate is the European Central
 * Bank's daily reference rate (via Frankfurter, free and keyless), and the
 * checkout SHOWS it — rate and date — rather than burying a conversion inside
 * the number. A shopper paying 283.43 USDC for a 249.00 EUR item should be able
 * to see why.
 *
 * ECB rates publish once per working day, so the rate is cached for an hour.
 * If the fetch fails, EUR_USD_RATE from the environment is used AND the quote
 * says it is a fallback. If neither is available the checkout refuses to
 * price: a made-up rate is worse than no checkout.
 *
 * All arithmetic is integer. The rate is held in millionths (1.1367 ->
 * 1_136_700), because a float rate times a float price is exactly how a
 * checkout ends up charging 283.4299999 and then rounding the wrong way.
 */

const ECB_URL = "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD";
const CACHE_MS = 60 * 60 * 1000;

export interface FxRate {
  /** USD per 1 EUR, in millionths. 1.1367 -> 1_136_700. */
  micro: bigint;
  /** Shown to the shopper. */
  display: string;
  /** e.g. "ECB reference rate, 2026-09-24" or "fallback rate from configuration". */
  source: string;
}

let cache: { rate: FxRate; at: number } | null = null;

/** "1.1367" -> 1_136_700n. Up to six decimals; anything else is refused. */
export function rateToMicro(rate: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(rate.trim());
  if (!m) return null;
  const micro = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return micro > 0n ? micro : null;
}

export async function eurUsdRate(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<FxRate | null> {
  if (cache && now - cache.at < CACHE_MS) return cache.rate;

  try {
    const res = await fetchImpl(ECB_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = (await res.json()) as { date?: string; rates?: { USD?: number } };
      const usd = body.rates?.USD;
      // Via toFixed(6) so the float from JSON becomes a clean decimal string
      // before it ever reaches integer arithmetic.
      const micro = typeof usd === "number" && usd > 0 ? rateToMicro(usd.toFixed(6)) : null;
      if (micro) {
        const rate: FxRate = {
          micro,
          display: usd!.toFixed(4),
          source: `ECB reference rate${body.date ? `, ${body.date}` : ""}`,
        };
        cache = { rate, at: now };
        return rate;
      }
    }
  } catch {
    /* fall through to the configured fallback */
  }

  const fallback = env.EUR_USD_RATE?.trim();
  const micro = fallback ? rateToMicro(fallback) : null;
  if (!micro) return null;
  // Not cached: try the live rate again on the next checkout.
  return { micro, display: fallback!, source: "fallback rate from configuration (live rate unavailable)" };
}

/**
 * Minor units of a currency -> USDC base units (6 decimals).
 *
 *   USD: 1 cent = 10_000 base units, no conversion.
 *   EUR: cents * rate. With the rate in millionths:
 *        (cents / 100) EUR * (micro / 1e6) USD/EUR * 1e6 base/USD
 *        = cents * micro / 100
 *
 * Rounded UP to the base unit, so the escrow never holds less than the item
 * costs. The difference is at most one millionth of a dollar.
 *
 * Returns null for any other currency — there is no rate for it, and guessing
 * one is not an option.
 */
export function toUsdcBaseUnits(minorUnits: number, currency: string, rate: FxRate | null): bigint | null {
  if (!Number.isInteger(minorUnits) || minorUnits <= 0) return null;
  const cents = BigInt(minorUnits);
  switch (currency.toUpperCase()) {
    case "USD":
      return cents * 10_000n;
    case "EUR": {
      if (!rate) return null;
      const num = cents * rate.micro;
      return (num + 99n) / 100n;
    }
    default:
      return null;
  }
}

/** Test hook: forget the cached rate. */
export function _resetFxCache() {
  cache = null;
}
