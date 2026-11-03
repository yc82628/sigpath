// SigPath check — the extension's background worker.
//
// The page script (content.js) can't call SigPath itself: a request from a
// shop's page carries the shop's origin. It asks here, and this worker calls
// SigPath, which host_permissions allow. Only what the page script read from
// the product page is sent; nothing about the shopper.

// The only server it talks to. Sharing Amazon prices is off until the shopper turns it on.
// The panel opens by itself unless the shopper chose the icon only (warnings always open it).
const SERVER = "https://sigpath.vercel.app";
const DEFAULTS = { share: false, auto: true };
// A check is an eBay and an AliExpress search; past this, the shopper gets "try again", not a spinner forever.
const TIMEOUT_MS = 20000;

const DE = (navigator.language || "").toLowerCase().startsWith("de");
const SAY = DE
  ? { offline: (s) => `${s} ist nicht erreichbar. Prüfe deine Verbindung und versuche es noch einmal.`,
      slow: "SigPath hat zu lange gebraucht. Versuche es noch einmal.",
      odd: (s) => `${s} hat nicht wie erwartet geantwortet. Versuche es in einer Minute noch einmal.` }
  : { offline: (s) => `Can't reach ${s}. Check your connection and try again.`,
      slow: "SigPath took too long to answer. Try again.",
      odd: (s) => `${s} didn't answer as expected. Try again in a minute.` };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))), server: SERVER };
}

async function post(path, body) {
  const { server } = await settings();
  let res;
  try {
    res = await fetch(server + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(e && e.name === "TimeoutError" ? SAY.slow : SAY.offline(server));
  }
  const data = await res.json().catch(() => null);
  // A SigPath without the extension's routes answers its "page not found" page.
  if (res.status === 404 || data === null) throw new Error(SAY.odd(server));
  if (!res.ok) throw new Error(data.error || `SigPath answered ${res.status}.`);
  return data;
}

// What the last check on each tab said, for the menu (popup.js): kept only while the browser is open.
const tabKey = (tabId) => `tab:${tabId}`;
async function forget(tabId) {
  await chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
  await chrome.storage.session.remove(tabKey(tabId));
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const { share } = await settings();
    if (msg.type === "check") return post("/api/extension/check", { ...msg.product, share });
    if (msg.type === "seen") return share ? post("/api/extension/seen", { items: msg.items }) : { kept: 0, off: true };
    if (msg.type === "settings") return settings();
    const tabId = sender.tab && sender.tab.id;
    if (tabId === undefined) throw new Error("unknown message");
    if (msg.type === "badge") {
      await chrome.action.setBadgeBackgroundColor({ color: msg.color || "#6b7280", tabId });
      await chrome.action.setBadgeText({ text: String(msg.text || "").slice(0, 4), tabId });
      if (msg.summary) await chrome.storage.session.set({ [tabKey(tabId)]: { ...msg.summary, url: sender.tab.url || "" } });
      return {};
    }
    if (msg.type === "forget") return forget(tabId);
    throw new Error("unknown message");
  })().then(
    (data) => reply({ ok: true, data }),
    (err) => reply({ ok: false, error: String(err && err.message ? err.message : err) }),
  );
  return true; // the answer comes later
});

// A new page in the tab, or the tab closed: the last check no longer applies.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") forget(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(tabKey(tabId)));

// First install: the welcome page, which says what is shared and how to turn it off.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  const { server } = await settings();
  chrome.tabs.create({ url: server + "/extension" });
});
