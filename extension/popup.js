// The extension's menu: this tab's check at a glance, "Show the check" / "Check this page", and the two settings.

const DE = (navigator.language || "").toLowerCase().startsWith("de");
const T = DE
  ? { intro: "Auf Amazon, AliExpress, OTTO, MediaMarkt und Saturn prüft SigPath jede Produktseite von selbst.",
      check: "Diese Seite prüfen", show: "Prüfung auf der Seite zeigen",
      autoTitle: "Das Fenster von selbst öffnen",
      autoNote: "Aus: das Ergebnis steht nur am Symbol (z. B. −22 %), bis du hier klickst. Warnungen öffnen es immer.",
      shareTitle: "Amazon.de-Preise teilen, die ich sehe", shareOff: "(aus, bis du es einschaltest)",
      shareNote: "Hilft anderen beim Vergleichen: Produkte und Preise auf Amazon.de-Seiten, die du öffnest, erscheinen in SigPaths Suche als „auf Amazon gesehen“. Nichts über dich wird gesendet.",
      more: "Was geteilt wird, im Detail", notShop: "Öffne zuerst die Produktseite eines Shops.", cant: "Diese Seite lässt sich nicht prüfen: ",
      pct: (n) => `${n} %`, good: "Gutes Angebot", fair: "Etwa der übliche Preis", high: "Anderswo vielleicht günstiger",
      usually: (lo, hi, mixed) => `${mixed ? "Neu und generalüberholt" : "Neu"} auf eBay meist ${lo} – ${hi}`, full: "Ganze Prüfung →",
      allow: "SigPath auf den Shop-Seiten erlauben", allowNote: "Ohne diese Erlaubnis kann die Prüfung auf Amazon, OTTO und den anderen nicht erscheinen." }
  : { intro: "On Amazon, AliExpress, OTTO, MediaMarkt and Saturn, SigPath checks every product page by itself.",
      check: "Check this page", show: "Show the check on the page",
      autoTitle: "Open the panel by itself",
      autoNote: "Off: the result shows on the icon only (e.g. −22%) until you click here. Warnings always open it.",
      shareTitle: "Share Amazon.de prices I see", shareOff: "(off unless you turn it on)",
      shareNote: "Helps other shoppers compare: the products and prices on Amazon.de pages you open go into SigPath's search as \"seen on Amazon\". Nothing about you is sent.",
      more: "What's shared, in full", notShop: "Open a shop's product page first.", cant: "This page can't be checked: ",
      pct: (n) => `${n}%`, good: "Good deal", fair: "About the usual price", high: "You may find it cheaper",
      usually: (lo, hi, mixed) => `${mixed ? "New and refurbished" : "New"} on eBay, usually ${lo} – ${hi}`, full: "Full check →",
      allow: "Allow SigPath on the shop sites", allowNote: "Without it, the check can't appear on Amazon, OTTO and the others." };

// Firefox names the extension API browser.*, Chrome, Brave and Edge chrome.*; both return promises.
const api = globalThis.browser ?? chrome;
const $ = (id) => document.getElementById(id);
document.documentElement.lang = DE ? "de" : "en";
$("intro").textContent = T.intro;
$("check").textContent = T.check;
$("autoTitle").textContent = T.autoTitle;
$("autoNote").textContent = T.autoNote;
$("shareTitle").textContent = T.shareTitle;
$("shareTitle").insertAdjacentText("afterend", " " + T.shareOff);
$("shareNote").textContent = T.shareNote;
$("more").textContent = T.more;
$("allow").textContent = T.allow;
$("allowNote").textContent = T.allowNote;

// Firefox lets people switch off an extension's access to sites (Chrome, Brave and Edge grant it at
// install). Without it the panel never appears and nothing says why, so the menu offers it back.
const manifest = api.runtime.getManifest();
const sites = [...new Set([...(manifest.host_permissions || []), ...manifest.content_scripts.flatMap((c) => c.matches)])];
api.permissions.contains({ origins: sites }).then((ok) => {
  $("allowBox").hidden = ok;
});
$("allow").addEventListener("click", () => {
  // Asked straight from the click: browsers only show the prompt for something the person just did.
  api.permissions.request({ origins: sites }).then((ok) => {
    $("allowBox").hidden = ok;
  });
});

// Off unless the shopper turns it on; the panel opens by itself unless they turn that off.
api.storage.sync.get({ share: false, auto: true }).then((s) => {
  $("share").checked = s.share;
  $("auto").checked = s.auto;
});
$("share").addEventListener("change", () => api.storage.sync.set({ share: $("share").checked }));
$("auto").addEventListener("change", () => api.storage.sync.set({ auto: $("auto").checked }));

const samePage = (a, b) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
};

/** The last check on this tab (background.js keeps it), built with textContent only: it came from a web page. */
function showResult(r) {
  const box = $("result");
  box.replaceChildren();
  const line = document.createElement("div");
  if (r.deal) {
    const d = r.deal;
    const big = document.createElement("span");
    big.className = `big ${d.tone}`;
    big.textContent = d.pct === 0 ? "±0" : `${d.pct > 0 ? "+" : "−"}${T.pct(Math.abs(d.pct))}`;
    const tone = document.createElement("span");
    tone.className = `tone ${d.tone}`;
    tone.textContent = T[d.tone] || "";
    line.append(big, tone);
  } else {
    const head = document.createElement("span");
    head.className = `tone ${r.verdict === "caution" ? "caution" : ""}`;
    head.textContent = r.headline || "";
    line.append(head);
  }
  box.append(line);
  if (r.market) {
    const p = document.createElement("p");
    p.textContent = `${r.price} · ${T.usually(r.market.low, r.market.high, r.market.basis === "new-refurbished")}`;
    box.append(p);
  } else if (r.deal && r.headline) {
    const p = document.createElement("p");
    p.textContent = r.headline;
    box.append(p);
  }
  if (/^https:\/\//.test(r.checkUrl || "")) {
    const a = document.createElement("a");
    a.href = r.checkUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = T.full;
    const p = document.createElement("p");
    p.append(a);
    box.append(p);
  }
  box.hidden = false;
}

const status = $("status");
(async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return;
  const key = `tab:${tab.id}`;
  const last = (await api.storage.session.get(key))[key];
  if (last && (!tab.url || !last.url || samePage(tab.url, last.url))) {
    showResult(last);
    $("check").textContent = T.show;
  }
})();

// "Check this page" / "Show the check": SigPath's check on the open tab, whatever the shop (activeTab: only this tab, only on this click).
$("check").addEventListener("click", async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https:\/\//.test(tab.url || "")) {
    status.textContent = T.notShop;
    return;
  }
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__sigpathManual = true; } });
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    window.close();
  } catch (e) {
    status.textContent = T.cant + (e && e.message ? e.message : e);
  }
});
