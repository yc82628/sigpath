// Device key: an Ed25519 keypair generated once per browser/device and kept in
// localStorage. Signing the media hash is what gives "verified" its meaning —
// it proves the SAME device that registered the media is claiming this capture.
//
// Honest limit: a web app can't do hardware attestation (App Attest / Play
// Integrity are native-only), so this is a soft device identity, and the analog
// hole still applies (someone can photograph a screen). The UI must therefore
// claim custody ("captured by this device, unmodified"), never "this is real".
// Hardware-backed keys are a native-app roadmap item.

import nacl from "tweetnacl";

const STORAGE_KEY = "gillty.deviceKey.v1";

function toB64(bytes: Uint8Array): string {
  if (typeof window === "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

export function fromB64(b64: string): Uint8Array {
  if (typeof window === "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  return new Uint8Array(
    atob(b64)
      .split("")
      .map((c) => c.charCodeAt(0))
  );
}

export function getDeviceKeypair(): nacl.SignKeyPair {
  if (typeof window === "undefined") throw new Error("device key is browser-only");
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved) {
    return nacl.sign.keyPair.fromSecretKey(fromB64(saved));
  }
  const kp = nacl.sign.keyPair();
  window.localStorage.setItem(STORAGE_KEY, toB64(kp.secretKey));
  return kp;
}

export function devicePublicKeyB64(): string {
  return toB64(getDeviceKeypair().publicKey);
}

// Detached signature over the 32-byte hash alone (legacy / simple case).
export function signHash(hashBytes: Uint8Array): string {
  const kp = getDeviceKeypair();
  return toB64(nacl.sign.detached(hashBytes, kp.secretKey));
}

// CHALLENGE-BOUND SIGNING — the important one.
//
// Signing the hash alone proves "this device signed these bytes", but says
// nothing about WHEN. An attacker with a stolen/AI photo could sign it at any
// time. Binding a server-issued, single-use nonce into the signed payload proves
// the signature was produced AFTER the server issued that challenge — so the
// capture can't be a replay of something prepared earlier.
//
// Payload = media_hash (32 bytes) || capture_nonce (32 bytes).
export function bindChallenge(hashBytes: Uint8Array, nonceBytes: Uint8Array): Uint8Array {
  if (hashBytes.length !== 32 || nonceBytes.length !== 32) {
    throw new Error("hash and nonce must both be 32 bytes");
  }
  const payload = new Uint8Array(64);
  payload.set(hashBytes, 0);
  payload.set(nonceBytes, 32);
  return payload;
}

export function signChallengeBound(hashBytes: Uint8Array, nonceBytes: Uint8Array): string {
  const kp = getDeviceKeypair();
  return toB64(nacl.sign.detached(bindChallenge(hashBytes, nonceBytes), kp.secretKey));
}

export function verifyHashSignature(
  hashBytes: Uint8Array,
  signatureB64: string,
  publicKeyB64: string
): boolean {
  return nacl.sign.detached.verify(hashBytes, fromB64(signatureB64), fromB64(publicKeyB64));
}

export function verifyChallengeBound(
  hashBytes: Uint8Array,
  nonceBytes: Uint8Array,
  signatureB64: string,
  publicKeyB64: string
): boolean {
  return nacl.sign.detached.verify(
    bindChallenge(hashBytes, nonceBytes),
    fromB64(signatureB64),
    fromB64(publicKeyB64)
  );
}
