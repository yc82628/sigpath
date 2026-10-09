/**
 * lib/marketplace/photo.ts — "is this the same photograph?"
 *
 * WHY
 * A scammer rarely owns the thing they sell, so they copy someone else's
 * photo. Two different sellers showing the same photograph of a USED item is
 * worth saying out loud: a used item's photo should be its seller's own.
 *
 * HOW
 * A difference hash (dHash): the photo is shrunk to 9×8 greys and each pixel
 * is compared with its right-hand neighbour, one bit each, 64 bits in all.
 * Re-encoding and resizing barely move it; a different photo of the same
 * product moves it a lot. Two hashes within MAX_DISTANCE bits are treated as
 * the same photograph. The bar is deliberately tight: a false "this photo is
 * someone else's" accuses an honest seller, so a near miss stays silent.
 *
 * WHAT IT DOES NOT CHECK
 *   - new items: sellers commonly show the maker's own product photo, so a
 *     match there means nothing
 *   - a marketplace's stock photo: eBay attaches its catalogue picture to many
 *     listings under ONE image id, which is not copying
 *   - a studio picture on a plain white background, even on a used item:
 *     refurbishers routinely show the maker's render (found on live eBay.de:
 *     two honest AirPods dealers, one with 588,819 ratings, each showing
 *     Apple's own picture). A photo of the actual item rarely has a pure
 *     white border.
 * Each listing says which of these applied (Listing.photoNote).
 */

import { decode } from "jpeg-js";

export const MAX_DISTANCE = 2;

/** Grey value of one pixel, ITU-R BT.601 weights. */
function grey(rgba: Uint8Array, i: number): number {
  return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
}

/** 64-bit difference hash of an RGBA image, as 16 hex characters. */
export function dHash(rgba: Uint8Array, width: number, height: number): string {
  // Box-average into a 9×8 grid: every source pixel counts once.
  const cells = new Float64Array(9 * 8);
  const counts = new Uint32Array(9 * 8);
  for (let y = 0; y < height; y++) {
    const cy = Math.min(7, Math.floor((y * 8) / height));
    for (let x = 0; x < width; x++) {
      const cx = Math.min(8, Math.floor((x * 9) / width));
      cells[cy * 9 + cx] += grey(rgba, (y * width + x) * 4);
      counts[cy * 9 + cx]++;
    }
  }
  let bits = 0n;
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      const left = cells[cy * 9 + cx] / Math.max(1, counts[cy * 9 + cx]);
      const right = cells[cy * 9 + cx + 1] / Math.max(1, counts[cy * 9 + cx + 1]);
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

/** How many of the 64 bits differ. */
export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/**
 * Map each hash to one representative of its group, so that photographs within
 * MAX_DISTANCE of each other end up with the same key. Greedy in input order;
 * with a bar this tight, groups do not chain in practice.
 */
export function groupHashes(hashes: string[]): Map<string, string> {
  const reps: string[] = [];
  const out = new Map<string, string>();
  for (const h of hashes) {
    if (out.has(h)) continue;
    const rep = reps.find((r) => hamming(r, h) <= MAX_DISTANCE);
    if (rep) out.set(h, rep);
    else {
      reps.push(h);
      out.set(h, h);
    }
  }
  return out;
}

/**
 * Share of the outermost strip that must be near-white for a studio picture.
 * Measured on eBay.de thumbnails (9 October 2026): Apple's own AirPods and
 * Watch renders, which fill the frame, 63-75% white; a seller's real photo of
 * a laptop, 0.4%. A real photo on a white sheet may also pass the bar and then
 * goes unchecked, which is the safe direction.
 */
export const STUDIO_BORDER = 0.4;

/**
 * Is this a studio picture: a product on a plain white background? Looks at
 * the outer 3% of the image on every side.
 */
export function isStudioShot(rgba: Uint8Array, width: number, height: number): boolean {
  const bx = Math.max(1, Math.round(width * 0.03));
  const by = Math.max(1, Math.round(height * 0.03));
  let border = 0;
  let white = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= bx && x < width - bx && y >= by && y < height - by) continue;
      const i = (y * width + x) * 4;
      border++;
      if (rgba[i] > 235 && rgba[i + 1] > 235 && rgba[i + 2] > 235) white++;
    }
  }
  return border > 0 && white / border >= STUDIO_BORDER;
}

/** Fetch a JPEG and hash it. Null when it can't be fetched or decoded. */
export async function photoHash(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2500,
): Promise<{ hash: string; studio: boolean } | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "image/jpeg" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Thumbnails only: refuse anything big enough to cost real memory.
    if (bytes.length > 2_000_000) return null;
    const img = decode(bytes, { useTArray: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
    if (!img.width || !img.height) return null;
    return { hash: dHash(img.data, img.width, img.height), studio: isStudioShot(img.data, img.width, img.height) };
  } catch {
    return null;
  }
}
