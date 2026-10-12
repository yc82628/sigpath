const share = document.getElementById("share");
const server = document.getElementById("server");
chrome.storage.sync.get({ share: true, server: "https://sigpath.vercel.app" }, (s) => {
  share.checked = s.share;
  server.value = s.server;
});
share.addEventListener("change", () => chrome.storage.sync.set({ share: share.checked }));
server.addEventListener("change", () => chrome.storage.sync.set({ server: server.value }));
