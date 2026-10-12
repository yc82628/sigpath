const share = document.getElementById("share");
// Off unless the shopper turns it on.
chrome.storage.sync.get({ share: false }, (s) => {
  share.checked = s.share;
});
share.addEventListener("change", () => chrome.storage.sync.set({ share: share.checked }));

// "Check this page": SigPath's check on the open tab, whatever the shop (activeTab: only this tab, only on this click).
const status = document.getElementById("status");
document.getElementById("check").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https:\/\//.test(tab.url || "")) {
    status.textContent = "Open a shop's product page first.";
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__sigpathManual = true; } });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    window.close();
  } catch (e) {
    status.textContent = "This page can't be checked: " + (e && e.message ? e.message : e);
  }
});
