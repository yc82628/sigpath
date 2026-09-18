/**
 * lib/crypto/hash.ts — subject commitments.
 *
 * Subjects are hashed before they touch the chain. A hash is stable and
 * re-derivable, so anyone who already knows the subject can find the record;
 * anyone who does not learns nothing from reading the chain. That is the whole
 * privacy model — do not put raw handles or emails in a PDA seed.
 *
 * Uses Web Crypto so the same code runs in the browser and in Node 20+.
 */

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(bytes));
}

/**
 * Commit to a subject identifier.
 *
 * The namespace prefix stops a handle on one platform colliding with the same
 * string on another — "alice" on GitHub and "alice" on X must not produce the
 * same subject hash, or an attestation about one would read as being about the
 * other.
 */
export async function subjectHash(namespace: string, identifier: string): Promise<Uint8Array> {
  const canonical = `${namespace.toLowerCase()}:${identifier.trim().toLowerCase()}`;
  return sha256(new TextEncoder().encode(canonical));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Hex string must have an even length.");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) throw new Error(`Invalid hex at byte ${i}.`);
    out[i] = byte;
  }
  return out;
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
