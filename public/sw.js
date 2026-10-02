/*
 * public/sw.js — SigPath's service worker. It exists for one thing: price alerts.
 *
 * Pushes from SigPath are EMPTY (see lib/alerts/push.ts): nothing about a deal
 * passes through the browser vendor's push service. When one arrives, this
 * asks SigPath's inbox what happened, presenting this browser's own push
 * endpoint, and shows what comes back. Browsers require a visible notification
 * for every push, so if the inbox can't be reached a generic one is shown.
 */

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let alerts = [];
      try {
        const sub = await self.registration.pushManager.getSubscription();
        if (sub) {
          const res = await fetch("/api/alerts/inbox", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
          if (res.ok) alerts = (await res.json()).alerts || [];
        }
      } catch (e) {
        /* fall through to the generic notification */
      }
      if (!alerts.length) {
        alerts = [{ title: "SigPath price alert", body: "A SigPath-checked deal you're watching dropped.", url: "/alerts" }];
      }
      await Promise.all(
        alerts.map((a) => self.registration.showNotification(a.title, { body: a.body, data: { url: a.url }, tag: a.url })),
      );
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/alerts", self.location.origin);
  // Same origin only: a notification can't send the shopper anywhere else.
  if (url.origin !== self.location.origin) return;
  event.waitUntil(self.clients.openWindow(url.href));
});
