// SigPath check — runs on the shop page the shopper opened.
//
// It reads what the page shows (the product's name and price, on Amazon also
// its ASIN, photo and seller), asks SigPath about it through the background
// worker, and shows the answer in a small panel at the bottom right. On an
// Amazon.de results page, with "share prices" on, it reports the products and
// prices listed there. It reads only this page, only what's on screen, and
// sends nothing about the shopper.

(() => {
  if (window.top !== window) return; // not inside the shop's own frames

  const DE = (navigator.language || "").toLowerCase().startsWith("de");
  const T = DE
    ? { checking: "SigPath prüft …", typical: "Typisch auf eBay", listings: "Angebote", below: "unter", above: "über", same: "genau der typische Preis",
        best: "Bestes geprüftes eBay-Angebot", full: "Ganze Prüfung auf SigPath →", soldBy: "Verkauf durch", ebayDown: "eBay hat gerade nicht geantwortet: kein Vergleich.",
        error: "SigPath ist gerade nicht erreichbar.", close: "Schließen", reload: "Die Erweiterung wurde neu geladen: lade diese Seite neu.",
        noAnswer: "Keine Antwort von der Erweiterung.", noPrice: "Den Preis auf dieser Seite konnte SigPath nicht lesen: vielleicht ist der Artikel nicht verfügbar, oder erst eine Variante (Farbe, Größe) wählen.", checked: "Geprüft", caution: "Vorsicht", unchecked: "Nicht geprüft", newW: "neu", usedW: "gebraucht" }
    : { checking: "SigPath is checking…", typical: "Typical on eBay", listings: "listings", below: "below", above: "above", same: "exactly the typical price",
        best: "Best checked eBay deal", full: "Full check on SigPath →", soldBy: "Sold by", ebayDown: "eBay didn't answer just now: no comparison.",
        error: "SigPath can't be reached right now.", close: "Close", reload: "The extension was reloaded: reload this page.",
        noAnswer: "No answer from the extension.", noPrice: "SigPath couldn't read the price on this page: the item may be unavailable, or choose an option (colour, size) first.", checked: "Checked", caution: "Caution", unchecked: "Not checked", newW: "new", usedW: "used" };

  const host = location.hostname;
  const SHOP = /amazon\.de$/.test(host) ? "amazon" : /aliexpress\.com$/.test(host) ? "aliexpress" : /otto\.de$/.test(host) ? "otto"
    : /mediamarkt\.de$/.test(host) ? "mediamarkt" : /saturn\.de$/.test(host) ? "saturn" : null;
  if (!SHOP) return;

  const $ = (s, root = document) => root.querySelector(s);
  const text = (el) => (el ? (el.getAttribute("content") || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");
  // After the extension is reloaded, this page's copy of the script is cut off from it until the page is reloaded.
  const ask = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          const lost = chrome.runtime.lastError;
          resolve(r || { ok: false, error: lost ? T.reload : T.noAnswer });
        });
      } catch {
        resolve({ ok: false, error: T.reload });
      }
    });

  /** "1.299,00 €" or "€1,299.00" -> 129900 (cents); null if it isn't a price. */
  function cents(t) {
    const num = (t || "").match(/\d[\d.,\s]*/)?.[0].replace(/\s/g, "");
    if (!num) return null;
    const dec = num.match(/[.,](\d{1,2})$/);
    const whole = (dec ? num.slice(0, -dec[0].length) : num).replace(/[.,]/g, "");
    const n = Number(whole) * 100 + (dec ? Number(dec[1].padEnd(2, "0")) : 0);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // ---- Reading the product page -------------------------------------------

  /** The schema.org Product most shops publish for search engines. */
  function jsonLdProduct() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent);
        for (const o of [].concat(j["@graph"] || j)) {
          const types = [].concat(o && o["@type"]);
          if (!types.includes("Product")) continue;
          const offer = [].concat(o.offers || [])[0] || {};
          const price = offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price;
          if (o.name && price) {
            return { title: String(o.name), price: `${price} ${offer.priceCurrency || "EUR"}`, imageUrl: [].concat(o.image || [])[0] };
          }
        }
      } catch {
        // not JSON, or not ours to read
      }
    }
    return null;
  }

  /** Amazon shows its price in several layouts; the first that has one wins. */
  function amazonPrice() {
    const boxes = ["#corePrice_feature_div", "#corePriceDisplay_desktop_feature_div", "#corePrice_desktop", "#apex_desktop",
      "#apex_offerDisplay_desktop", "#tp_price_block_total_price_ww", "#booksHeaderSection", "#buybox", "#ppd"];
    for (const box of boxes) {
      const root = $(box);
      if (!root) continue;
      const off = [...root.querySelectorAll(".priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, .a-price .a-offscreen")]
        .map((e) => (e.textContent || "").trim()).find((t) => /\d/.test(t));
      if (off) return off;
      // Some layouts leave the hidden text empty: the whole and fraction parts are shown instead.
      const whole = $(".a-price-whole", root);
      if (whole && /\d/.test(whole.textContent)) {
        return `${whole.textContent.replace(/[^\d.]/g, "")},${($(".a-price-fraction", root)?.textContent || "00").replace(/\D/g, "")} €`;
      }
    }
    for (const sel of ["#priceblock_ourprice", "#priceblock_dealprice", "#priceblock_saleprice", "#price_inside_buybox", "#kindle-price", "#price"]) {
      const t = text($(sel));
      if (/\d/.test(t)) return t;
    }
    // Amazon's own hidden field for the price shown to the customer.
    const field = $('input[name*="customerVisiblePrice"][name*="amount"]');
    return field && /\d/.test(field.value) ? `${field.value} €` : "";
  }

  function amazonProduct() {
    const title = text($("#productTitle"));
    if (!title) return null;
    const price = amazonPrice();
    const asin = ($("#ASIN")?.value || location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)?.[1] || "").toUpperCase();
    const seller = text($("#sellerProfileTriggerId")) || text($("#merchantInfoFeature_feature_div .offer-display-feature-text-message")) || text($("#merchant-info"));
    const img = $("#landingImage");
    const imageUrl = img?.getAttribute("data-old-hires") || img?.src;
    return { title, price, asin, seller: seller.slice(0, 80), imageUrl };
  }

  function otherProduct() {
    const ld = jsonLdProduct();
    if (ld) return ld;
    const title = text($('h1[data-pl="product-title"]')) || text($("h1")) || text($('meta[property="og:title"]'));
    const price = text($(".product-price-current")) || text($('[class*="price--current"]')) || text($('[class*="price-default--current"]')) ||
      text($('[itemprop="price"]')) || text($('meta[property="product:price:amount"]'));
    return title && /\d/.test(price) ? { title, price } : null;
  }

  // ---- Amazon results pages: the prices on screen -------------------------

  const reported = new Set();
  function reportSearchResults() {
    const items = [];
    for (const r of document.querySelectorAll('div[data-component-type="s-search-result"][data-asin]')) {
      const asin = r.getAttribute("data-asin");
      if (!asin || reported.has(asin)) continue;
      const title = text($("h2", r)) || $("h2", r)?.getAttribute("aria-label") || "";
      const amount = cents(text($(".a-price:not(.a-text-price) .a-offscreen", r)));
      if (!title || !amount) continue;
      reported.add(asin);
      items.push({ asin, title, price: { amount, currency: "EUR" }, imageUrl: $("img.s-image", r)?.src });
    }
    if (items.length) ask({ type: "seen", items: items.slice(0, 60) });
  }

  // ---- The panel ----------------------------------------------------------

  let panel = null;
  function showPanel() {
    if (panel) return panel;
    const hostEl = document.createElement("div");
    hostEl.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = hostEl.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .card { width: 300px; max-height: 70vh; overflow: auto; box-sizing: border-box; padding: 12px 14px; border-radius: 14px;
        background: #fff; color: #16132b; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 2px 4px rgba(22,19,43,.08), 0 12px 28px rgba(22,19,43,.18); border: 1px solid #e3e0f0; }
      .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .brand { font-weight: 800; letter-spacing: .02em; background: linear-gradient(90deg,#9945ff,#00c2ff,#14f195); -webkit-background-clip: text; color: transparent; }
      button { border: 0; background: transparent; font-size: 18px; line-height: 1; cursor: pointer; color: #5b5875; }
      .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 700; font-size: 12px; margin-bottom: 6px; }
      .checked { background: #e2f4e8; color: #22703d; } .caution { background: #fdf0d8; color: #8a5a00; } .unchecked { background: #eeedf4; color: #5b5875; }
      .headline { font-weight: 700; margin: 0 0 6px; } ul { margin: 0 0 8px; padding-left: 18px; } li { margin: 2px 0; } li.warn { color: #a3361f; }
      .muted { color: #5b5875; font-size: 12px; } a { color: #6a2fe0; } p { margin: 6px 0; }
      @media (prefers-color-scheme: dark) { .card { background: #151230; color: #f4f3fb; border-color: #2a2550; } .muted, button { color: #b9b5d6; } a { color: #b48cff; } li.warn { color: #ff9a85; } }
    </style><div class="card" role="dialog" aria-label="SigPath"><div class="head"><span class="brand">SigPath</span><button aria-label="${T.close}">×</button></div><div class="body"></div></div>`;
    root.querySelector("button").addEventListener("click", () => { hostEl.remove(); panel = null; });
    document.documentElement.appendChild(hostEl);
    panel = { body: root.querySelector(".body"), host: hostEl };
    return panel;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https:\/\//.test(u || "") ? esc(u) : "#");

  function render(r, product) {
    const p = showPanel();
    const label = { checked: T.checked, caution: T.caution, unchecked: T.unchecked }[r.verdict] || r.verdict;
    let html = `<span class="pill ${esc(r.verdict)}">${r.verdict === "checked" ? "✓ " : r.verdict === "caution" ? "! " : ""}${esc(label)}</span>
      <p class="headline">${esc(r.headline)}</p><ul>${r.points.slice(0, 4).map((x) => `<li class="${esc(x.tone)}">${esc(x.text)}</li>`).join("")}</ul>`;
    if (r.typical) {
      const d = r.typical.diffPct;
      const rel = d === 0 ? T.same : `${Math.abs(d)} % ${d < 0 ? T.below : T.above}`;
      html += `<p><strong>${T.typical}:</strong> ${esc(r.typical.price)} <span class="muted">(${r.typical.listings} ${T.listings}) · ${esc(r.price)} = ${esc(rel)}</span></p>`;
    } else if (!r.ebayOk) {
      html += `<p class="muted">${T.ebayDown}</p>`;
    }
    if (r.bestEbay?.length) {
      const b = r.bestEbay[0];
      html += `<p><strong>${T.best}:</strong> <a href="${safeUrl(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.title)}</a> — ${esc(b.price)} (${b.group === "used" ? T.usedW : T.newW})</p>`;
    }
    if (product.seller) html += `<p class="muted">${T.soldBy}: ${esc(product.seller)}</p>`;
    html += `<p><a href="${safeUrl(r.checkUrl)}" target="_blank" rel="noopener">${T.full}</a></p>`;
    p.body.innerHTML = html;
  }

  // ---- Running it ---------------------------------------------------------

  let lastChecked = "";
  async function run() {
    if (SHOP === "amazon" && /^\/s$|^\/s\//.test(location.pathname)) {
      reportSearchResults();
      return;
    }
    const product = SHOP === "amazon" ? amazonProduct() : otherProduct();
    if (!product) return;
    const key = `${product.title}|${product.price}`;
    if (key === lastChecked) return;
    lastChecked = key;
    const p = showPanel();
    if (!product.price) {
      // A product page, but no price SigPath can read: say so rather than stay silent.
      p.body.innerHTML = `<p class="muted">${T.noPrice}</p>`;
      return;
    }
    p.body.innerHTML = `<p class="muted">${T.checking}</p>`;
    const res = await ask({
      type: "check",
      product: {
        from: SHOP,
        title: product.title.slice(0, 300),
        price: product.price.slice(0, 40),
        url: location.origin + location.pathname,
        asin: product.asin,
        imageUrl: product.imageUrl,
        lang: DE ? "de" : "en",
      },
    });
    if (!res.ok) {
      // The reason, as the background worker gave it: no server, an old SigPath, a reloaded extension.
      p.body.innerHTML = `<p class="muted">${T.error}</p><p class="muted">${esc(res.error)}</p>`;
      return;
    }
    render(res.data, product);
  }

  run();
  // Shops that change page without reloading (OTTO, MediaMarkt), and Amazon results that load more as you scroll.
  let href = location.href;
  let timer = 0;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (location.href !== href) {
        href = location.href;
        lastChecked = "";
        if (panel) { panel.host.remove(); panel = null; }
      }
      run();
    }, 1200);
  }).observe(document.body, { childList: true, subtree: true });
})();
