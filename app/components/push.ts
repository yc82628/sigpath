"use client";

/**
 * Browser push, for price alerts. The subscription's endpoint is the only
 * "account" — it stays in this browser and is sent only in POST bodies.
 */

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(b64);
  // An explicit ArrayBuffer: subscribe() rejects a view that could be shared memory.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The existing subscription, without prompting. */
export async function existingSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ask permission (once), register the worker, subscribe. Throws with a message a shopper can act on. */
export async function subscribe(vapidPublicKey: string): Promise<PushSubscription> {
  if (!pushSupported()) throw new Error("This browser can't receive notifications from websites.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings to get alerts.");
  }
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  return (
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) }))
  );
}

/** "356", "356.5", "356,50" -> 35650 minor units; null if it isn't a price. */
export function toMinorUnits(input: string): number | null {
  const m = /^\s*(\d{1,6})(?:[.,](\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return v > 0 ? v : null;
}
