// SigPath check — the extension's background worker.
//
// The page script (content.js) can't call SigPath itself: a request from a
// shop's page carries the shop's origin. It asks here, and this worker calls
// SigPath, which host_permissions allow. Only what the page script read from
// the product page is sent; nothing about the shopper.

// The only server it talks to. Sharing Amazon prices is off until the shopper turns it on.
const SERVER = "https://sigpath.vercel.app";
const DEFAULTS = { share: false };

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
    });
  } catch {
    throw new Error(`Can't reach ${server}. Check your connection and try again.`);
  }
  const data = await res.json().catch(() => null);
  // A SigPath without the extension's routes answers its "page not found" page.
  if (res.status === 404 || data === null) {
    throw new Error(`${server} didn't answer as expected. Try again in a minute.`);
  }
  if (!res.ok) throw new Error(data.error || `SigPath answered ${res.status}.`);
  return data;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    const { share } = await settings();
    if (msg.type === "check") return post("/api/extension/check", { ...msg.product, share });
    if (msg.type === "seen") return share ? post("/api/extension/seen", { items: msg.items }) : { kept: 0, off: true };
    if (msg.type === "settings") return settings();
    if (msg.type === "badge" && _sender.tab && _sender.tab.id !== undefined) {
      const tabId = _sender.tab.id;
      await chrome.action.setBadgeBackgroundColor({ color: msg.text === "✓" ? "#22703d" : msg.text === "!" ? "#b45309" : "#6b7280", tabId });
      await chrome.action.setBadgeText({ text: msg.text, tabId });
      return {};
    }
    throw new Error("unknown message");
  })().then(
    (data) => reply({ ok: true, data }),
    (err) => reply({ ok: false, error: String(err && err.message ? err.message : err) }),
  );
  return true; // the answer comes later
});

// First install: the welcome page, which says what is shared and how to turn it off.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  const { server } = await settings();
  chrome.tabs.create({ url: server + "/extension" });
});
