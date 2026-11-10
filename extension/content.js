// SigPath check — runs on the shop page the shopper opened.
//
// It reads what the page shows (the product's name and price, on Amazon also
// its ASIN, photo and seller), asks SigPath about it through the background
// worker, and shows the answer on the toolbar icon (the deal score, or "!")
// and in a small panel at the bottom right: by itself, or only when asked from
// the menu if the shopper chose the icon only. A warning always opens it. On an
// Amazon results page it puts a "Check with SigPath" button on every result: a
// click checks that product right there, in the same panel (a Ctrl- or
// middle-click opens SigPath's own check page instead), and on Amazon.de, with
// "share prices" on, it reports the products and prices listed there. It reads only this page, only what's on screen, and sends nothing
// about the shopper. On any other shop it runs when the shopper presses "Check
// this page" in the extension's menu.

(() => {
  if (window.top !== window) return; // not inside the shop's own frames
  // Already running here: the menu's "Check this page" on a covered page asks it to look again.
  if (window.__sigpathRunning) {
    if (window.__sigpathRerun) window.__sigpathRerun();
    return;
  }
  window.__sigpathRunning = true;

  const DE = (navigator.language || "").toLowerCase().startsWith("de");
  const T = DE
    ? { checking: "SigPath prüft …", typical: "Typisch auf eBay", listings: "Angebote", below: "unter", above: "über", same: "genau der typische Preis",
        best: "Bestes geprüftes eBay-Angebot", full: "Ganze Prüfung auf SigPath →", soldBy: "Verkauf durch", ebayDown: "eBay hat gerade nicht geantwortet: kein Vergleich.",
        error: "SigPath ist gerade nicht erreichbar.", close: "Schließen", reload: "Die Erweiterung wurde neu geladen: lade diese Seite neu.",
        noAnswer: "Keine Antwort von der Erweiterung.", button: "Mit SigPath prüfen →", on: "SigPath ist an: „Mit SigPath prüfen“ bei jedem Ergebnis, oder ein Produkt öffnen.",
        nothing: "Auf dieser Seite hat SigPath kein Produkt mit Preis gefunden.", noPrice: "Den Preis auf dieser Seite konnte SigPath nicht lesen: vielleicht ist der Artikel nicht verfügbar, oder erst eine Variante (Farbe, Größe) wählen.", checked: "Geprüft", caution: "Vorsicht", unchecked: "Nicht geprüft", newW: "neu", usedW: "gebraucht", refurbW: "generalüberholt",
        retry: "Erneut versuchen", pct: (n) => `${n} %`, under: (p) => `${p} unter dem Markt`, over: (p) => `${p} über dem Markt`,
        good: "Gutes Angebot", fair: "Etwa der übliche Preis", high: "Anderswo vielleicht günstiger",
        usually: (lo, hi, n, basis) => `${basis === "used" ? "Gebraucht" : basis === "new-refurbished" ? "Neu und generalüberholt" : "Neu"} auf eBay meist ${lo} – ${hi} (${n} Angebote).`, also: "Auch auf", notChecked: "nicht von SigPath geprüft",
        cheaper: "Günstigeres geprüftes Angebot", variations: "Dieses Angebot hat mehrere Varianten (Größe, Farbe) mit eigenen Preisen: wähle eine, oder sieh dir die ganze Suche auf SigPath an.",
        gone: "eBay kennt dieses Angebot nicht mehr: vielleicht verkauft oder beendet.", search: "Auf SigPath suchen →",
        ref: { rrp: "UVP", was: "dem früheren Preis", lowest30: "dem 30-Tage-Tiefstpreis", unknown: "dem Streichpreis" },
        discInflated: (c, from, ref, real, typ) => `Rabatt aufgebläht: Die −${c} % zählen ab ${from} (${ref}), aber meist kostet das Produkt ${typ}. ${real >= 0 ? `Echte Ersparnis: etwa ${real} %.` : `Es liegt sogar ${-real} % über dem Markt.`}`,
        discNotLower: (low) => `Kein echter Rabatt: nicht günstiger als der niedrigste Preis der letzten 30 Tage (${low}).`,
        discReal: (c) => `Der Rabatt von −${c} % hält dem Marktvergleich stand.` }
    : { checking: "SigPath is checking…", typical: "Typical on eBay", listings: "listings", below: "below", above: "above", same: "exactly the typical price",
        best: "Best checked eBay deal", full: "Full check on SigPath →", soldBy: "Sold by", ebayDown: "eBay didn't answer just now: no comparison.",
        error: "SigPath can't be reached right now.", close: "Close", reload: "The extension was reloaded: reload this page.",
        noAnswer: "No answer from the extension.", button: "Check with SigPath →", on: "SigPath is on: “Check with SigPath” on any result, or open a product.",
        nothing: "SigPath found no product with a price on this page.", noPrice: "SigPath couldn't read the price on this page: the item may be unavailable, or choose an option (colour, size) first.", checked: "Checked", caution: "Caution", unchecked: "Not checked", newW: "new", usedW: "used", refurbW: "refurbished",
        retry: "Try again", pct: (n) => `${n}%`, under: (p) => `${p} under the market`, over: (p) => `${p} over the market`,
        good: "Good deal", fair: "About the usual price", high: "You may find it cheaper",
        usually: (lo, hi, n, basis) => `${basis === "used" ? "Used" : basis === "new-refurbished" ? "New and refurbished" : "New"} on eBay, usually ${lo} – ${hi} (${n} listings).`, also: "Also on", notChecked: "not checked by SigPath",
        cheaper: "Cheaper checked listing", variations: "This listing has several variations (size, colour) with their own prices: pick one, or see the whole search on SigPath.",
        gone: "eBay no longer has this listing: it may have sold or ended.", search: "Search on SigPath →",
        ref: { rrp: "RRP", was: "the earlier price", lowest30: "the 30-day low", unknown: "the struck-out price" },
        discInflated: (c, from, ref, real, typ) => `Inflated discount: the −${c}% counts from ${from} (${ref}), but it usually sells for ${typ}. ${real >= 0 ? `Real saving: about ${real}%.` : `It's even ${-real}% above the market.`}`,
        discNotLower: (low) => `Not a real discount: no cheaper than its lowest price in the last 30 days (${low}).`,
        discReal: (c) => `The −${c}% discount holds up against the market.` };

  const host = location.hostname;
  const manual = () => !!window.__sigpathManual; // "Check this page" in the extension's menu
  const SHOP = /(^|\.)amazon\.(de|com|co\.uk|fr|it|es|nl)$/.test(host) ? "amazon" : /aliexpress\.com$/.test(host) ? "aliexpress"
    : /(^|\.)ebay\.de$/.test(host) ? "ebay"
    : /otto\.de$/.test(host) ? "otto" : /mediamarkt\.de$/.test(host) ? "mediamarkt" : /saturn\.de$/.test(host) ? "saturn" : manual() ? "other" : null;
  if (!SHOP) return;
  // Sightings are euro prices from Amazon.de only (lib/extension/seen.ts).
  const AMAZON_DE = /(^|\.)amazon\.de$/.test(host);

  const $ = (s, root = document) => root.querySelector(s);
  const text = (el) => (el ? (el.getAttribute("content") || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");
  // Firefox names the extension API browser.*, Chrome, Brave and Edge chrome.*; both return promises.
  const api = globalThis.browser ?? chrome;
  // After the extension is reloaded, this page's copy of the script is cut off from it until the page is reloaded.
  const ask = (msg) => {
    try {
      return api.runtime.sendMessage(msg).then((r) => r || { ok: false, error: T.noAnswer }, () => ({ ok: false, error: T.reload }));
    } catch {
      return Promise.resolve({ ok: false, error: T.reload });
    }
  };

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

  /**
   * The struck-out price beside Amazon's price, with its label ("RRP:", "UVP:",
   * "Was:", "Niedrigster Preis …"), and the 30-day low when the page states it.
   * Only inside the product's own price box: the carousels below have their own.
   */
  function amazonDiscount() {
    let was = "", wasLabel = "", lowest30 = "";
    for (const box of ["#corePriceDisplay_desktop_feature_div", "#corePrice_feature_div", "#apex_desktop", "#corePrice_desktop"]) {
      const root = $(box);
      if (!root) continue;
      for (const b of root.querySelectorAll(".basisPrice, .a-price[data-a-strike='true']")) {
        const strike = b.matches("[data-a-strike='true']") ? b : $("[data-a-strike='true']", b);
        if (!strike) continue;
        const shown = [$(".a-offscreen", strike)?.textContent, $("[aria-hidden='true']", strike)?.textContent].map((t) => (t || "").trim()).find((t) => /\d/.test(t));
        if (!shown) continue;
        const label = text(b.closest(".basisPrice") || strike.parentElement).replace(shown, "").slice(0, 80);
        if (/niedrigst|lowest|30\s*(tage|days)/i.test(label)) lowest30 = lowest30 || shown;
        else if (!was) { was = shown; wasLabel = label; }
      }
      if (was || lowest30) break;
    }
    return { was, wasLabel, lowest30 };
  }

  function amazonProduct() {
    const title = text($("#productTitle"));
    if (!title) return null;
    const price = amazonPrice();
    const asin = ($("#ASIN")?.value || location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)?.[1] || "").toUpperCase();
    const seller = text($("#sellerProfileTriggerId")) || text($("#merchantInfoFeature_feature_div .offer-display-feature-text-message")) || text($("#merchant-info"));
    const img = $("#landingImage");
    const imageUrl = img?.getAttribute("data-old-hires") || img?.src;
    return { title, price, asin, seller: seller.slice(0, 80), imageUrl, ...amazonDiscount() };
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
  let server = "https://sigpath.vercel.app";
  // Whether the panel opens by itself (the menu's setting), and whether the shopper asked for it from the menu.
  let auto = true;
  let forced = false;
  // On a shop it doesn't cover, it only runs because the shopper asked from the menu.
  const visible = () => auto || forced || SHOP === "other";
  const ready = ask({ type: "settings" }).then((r) => {
    if (r.ok && r.data) {
      if (r.data.server) server = r.data.server;
      auto = r.data.auto !== false;
    }
  });
  let notePill = false;

  /**
   * A "Check with SigPath" button on each result. A click checks that product
   * here, without leaving Amazon (checkResult); a Ctrl- or middle-click opens
   * SigPath's check page in a new tab, as the link it is. On Amazon.de the
   * prices are reported.
   */
  function searchResults() {
    const items = [];
    for (const r of document.querySelectorAll('div[data-component-type="s-search-result"][data-asin]')) {
      const asin = r.getAttribute("data-asin");
      if (!asin || reported.has(asin)) continue;
      const title = text($("h2", r)) || $("h2", r)?.getAttribute("aria-label") || "";
      const priceText = text($(".a-price:not(.a-text-price) .a-offscreen", r));
      const amount = cents(priceText);
      if (!title || !amount) continue;
      reported.add(asin);
      if (AMAZON_DE) items.push({ asin, title, price: { amount, currency: "EUR" }, imageUrl: $("img.s-image", r)?.src });
      const a = document.createElement("a");
      // A link to the check, not a verdict: no ✓ until SigPath has actually checked something.
      a.textContent = T.button;
      a.target = "_blank";
      a.rel = "noopener";
      a.href = `${server}/check?${new URLSearchParams({ title: title.slice(0, 200), price: priceText, from: "amazon", url: `${location.origin}/dp/${asin}` })}`;
      a.style.cssText = "display:inline-block;margin:6px 0 2px;padding:3px 10px;border-radius:999px;background:#6a2fe0;color:#fff;font:600 12px/1.6 system-ui,sans-serif;text-decoration:none;";
      const strike = $(".a-text-price[data-a-strike='true']", r);
      const was = text($(".a-offscreen", strike)) || text($("[aria-hidden='true']", strike));
      const item = { asin, title, price: priceText, imageUrl: $("img.s-image", r)?.src, was: /\d/.test(was) ? was : "", wasLabel: text(strike?.parentElement).replace(was, "").slice(0, 80) };
      a.addEventListener("click", (e) => {
        // A new tab or window was asked for: SigPath's own page, as the link says.
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        checkResult(a, item);
      });
      const where = $(".a-price", r)?.closest(".a-row") || $("h2", r)?.parentElement || r;
      where.appendChild(document.createElement("br"));
      where.appendChild(a);
    }
    if (items.length) ask({ type: "seen", items: items.slice(0, 60) });
    if (reported.size && !notePill && visible()) {
      notePill = true;
      showPanel().body.innerHTML = `<p class="muted">${T.on}</p>`;
    }
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
      .deal { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 0 0 4px; }
      .deal .big { font-size: 22px; font-weight: 800; letter-spacing: -.01em; }
      .deal .tone { font-weight: 700; }
      .good .big, .good .tone { color: #22703d; } .high .big, .high .tone { color: #9a3412; }
      .disc { margin: 4px 0 8px; } .disc.warn { color: #a3361f; font-weight: 600; }
      button.retry { font: 700 12px system-ui, sans-serif; color: #fff; background: #6a2fe0; border-radius: 999px; padding: 6px 12px; margin-top: 4px; }
      @media (prefers-color-scheme: dark) { .card { background: #151230; color: #f4f3fb; border-color: #2a2550; } .muted, button { color: #b9b5d6; } a { color: #b48cff; } li.warn, .disc.warn { color: #ff9a85; }
        .good .big, .good .tone { color: #6fd894; } .high .big, .high .tone { color: #ffb37a; } button.retry { color: #fff; } }
    </style><div class="card" role="dialog" aria-label="SigPath"><div class="head"><span class="brand">SigPath</span><button aria-label="${T.close}">×</button></div><div class="body"></div></div>`;
    root.querySelector("button").addEventListener("click", () => { hostEl.remove(); panel = null; forced = false; });
    document.documentElement.appendChild(hostEl);
    panel = { body: root.querySelector(".body"), host: hostEl };
    return panel;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https:\/\//.test(u || "") ? esc(u) : "#");
  // Marketplace titles run to a paragraph; the panel stays small.
  const short = (t) => (String(t ?? "").length > 70 ? `${String(t).slice(0, 68).trimEnd()}…` : String(t ?? ""));

  /** The toolbar icon: the deal score on a checked price, "!" on a warning, "?" when it couldn't be checked. */
  function badgeOf(r) {
    if (r.verdict === "caution") return { text: "!", color: "#b45309" };
    if (r.verdict !== "checked") return { text: "?", color: "#6b7280" };
    if (!r.deal || Math.abs(r.deal.pct) > 99) return { text: "✓", color: "#22703d" };
    const color = { good: "#22703d", fair: "#6b7280", high: "#9a3412" }[r.deal.tone] || "#6b7280";
    return { text: r.deal.pct === 0 ? "±0" : `${r.deal.pct > 0 ? "+" : "−"}${Math.abs(r.deal.pct)}%`, color };
  }

  /** The deal first: how far from the market, then the usual range; why SigPath can vouch for it follows. */
  function dealHtml(r) {
    if (!r.deal) return "";
    const d = r.deal;
    const big = d.pct === 0 ? "±0" : `${d.pct > 0 ? "+" : "−"}${T.pct(Math.abs(d.pct))}`;
    const words = d.pct < 0 ? T.under(T.pct(-d.pct)) : d.pct > 0 ? T.over(T.pct(d.pct)) : T.same;
    let html = `<div class="deal ${esc(d.tone)}"><span class="big">${esc(big)}</span><span class="tone">${esc(T[d.tone] || "")}</span></div>
      <p class="muted">${esc(r.price)}: ${esc(words)}.</p>`;
    if (r.market) html += `<p>${esc(T.usually(r.market.low, r.market.high, r.market.listings, r.market.basis))}</p>`;
    return html;
  }

  /** Whether the advertised discount holds up (lib/marketplace/discount.ts): a warning line, or a quiet one when it's real. */
  function discountHtml(d) {
    if (!d) return "";
    if (d.verdict === "inflated") {
      return `<p class="disc warn">! ${esc(T.discInflated(d.claimedPct, d.was, T.ref[d.reference] || T.ref.unknown, d.vsMarketPct, d.typical))}</p>`;
    }
    if (d.verdict === "not-lower") return `<p class="disc warn">! ${esc(T.discNotLower(d.lowest30))}</p>`;
    if (d.verdict === "real") return `<p class="disc muted">${esc(T.discReal(d.claimedPct))}</p>`;
    return "";
  }

  function render(r, product, open) {
    const label = { checked: T.checked, caution: T.caution, unchecked: T.unchecked }[r.verdict] || r.verdict;
    // The verdict on the toolbar icon, and a summary for the menu.
    ask({
      type: "badge",
      ...badgeOf(r),
      summary: { verdict: r.verdict, headline: r.headline, deal: r.deal || null, price: r.price, market: r.market || null, checkUrl: r.checkUrl },
    });
    // A warning opens the panel even when the shopper chose the icon only; so does an inflated discount.
    const misleading = r.discount && (r.discount.verdict === "inflated" || r.discount.verdict === "not-lower");
    if (!open && r.verdict !== "caution" && !misleading) return;
    // On a results page the panel says which of the products it's about.
    let html = product.heading ? `<p class="muted">${esc(short(product.heading))}</p>` : "";
    html += dealHtml(r);
    html += discountHtml(r.discount);
    // With the deal on top, the price line below would say it again in other numbers (measured against
    // new and used alike), and "photo not checked" means nothing for a shop's own product: warnings only.
    const points = r.deal ? r.points.filter((x) => x.tone === "warn") : r.points.slice(0, 4);
    html += `<span class="pill ${esc(r.verdict)}">${r.verdict === "checked" ? "✓ " : r.verdict === "caution" ? "! " : ""}${esc(label)}</span>`;
    if (!r.deal) html += `<p class="headline">${esc(r.headline)}</p>`;
    if (points.length) html += `<ul>${points.map((x) => `<li class="${esc(x.tone)}">${esc(x.text)}</li>`).join("")}</ul>`;
    if (r.typical && !r.deal) {
      const d = r.typical.diffPct;
      const rel = d === 0 ? T.same : `${T.pct(Math.abs(d))} ${d < 0 ? T.below : T.above}`;
      html += `<p><strong>${T.typical}:</strong> ${esc(r.typical.price)} <span class="muted">(${esc(r.typical.listings)} ${T.listings}) · ${esc(r.price)} = ${esc(rel)}</span></p>`;
    } else if (!r.typical && !r.ebayOk) {
      html += `<p class="muted">${T.ebayDown}</p>`;
    }
    if (r.bestEbay?.length) {
      const b = r.bestEbay[0];
      html += `<p><strong>${SHOP === "ebay" ? T.cheaper : T.best}:</strong> <a href="${safeUrl(b.url)}" target="_blank" rel="${b.affiliate ? "sponsored " : ""}noopener noreferrer">${esc(short(b.title))}</a> — ${esc(b.price)} (${b.group === "used" ? T.usedW : b.group === "refurbished" ? T.refurbW : T.newW})</p>`;
    }
    if (r.elsewhere) {
      const e = r.elsewhere;
      html += `<p><strong>${T.also} ${esc(e.shop)}:</strong> <a href="${safeUrl(e.url)}" target="_blank" rel="${e.affiliate ? "sponsored " : ""}noopener noreferrer">${esc(short(e.title))}</a> — ${esc(e.price)} <span class="muted">(${T.notChecked})</span></p>`;
    }
    const seller = product.seller || r.seller;
    if (seller) html += `<p class="muted">${T.soldBy}: ${esc(seller)}</p>`;
    html += `<p><a href="${safeUrl(r.checkUrl)}" target="_blank" rel="noopener">${T.full}</a></p>`;
    showPanel().body.innerHTML = html;
  }

  /** What the button on a result says once it's checked, and in which colour (as the toolbar icon). */
  function resultLabel(r) {
    if (r.verdict === "caution") return { text: `! ${T.caution}`, color: "#b45309" };
    if (r.verdict !== "checked") return { text: T.unchecked, color: "#6b7280" };
    if (!r.deal) return { text: `✓ ${T.checked}`, color: "#22703d" };
    const pct = r.deal.pct === 0 ? "±0" : `${r.deal.pct > 0 ? "+" : "−"}${T.pct(Math.abs(r.deal.pct))}`;
    return { text: `${pct} · ${T[r.deal.tone] || ""}`, color: { good: "#22703d", fair: "#6b7280", high: "#9a3412" }[r.deal.tone] || "#6b7280" };
  }

  /**
   * One result, checked on the results page: the same check as a product page,
   * shown in the same panel, headed with the product's name; the button then
   * says the answer. Asked for, so the panel opens whatever the setting.
   */
  async function checkResult(a, item) {
    if (a.dataset.busy) return;
    a.dataset.busy = "1";
    const label = a.textContent;
    a.textContent = T.checking;
    forced = true;
    const head = `<p class="muted">${esc(short(item.title))}</p>`;
    showPanel().body.innerHTML = `${head}<p class="muted">${T.checking}</p>`;
    const res = await ask({
      type: "check",
      product: {
        from: "amazon",
        title: item.title.slice(0, 300),
        price: item.price.slice(0, 40),
        url: `${location.origin}/dp/${item.asin}`,
        asin: item.asin,
        imageUrl: item.imageUrl,
        was: item.was,
        wasLabel: item.wasLabel,
        lang: DE ? "de" : "en",
      },
    });
    delete a.dataset.busy;
    if (!res.ok) {
      a.textContent = label;
      const body = showPanel().body;
      body.innerHTML = `${head}<p class="muted">${T.error}</p><p class="muted">${esc(res.error)}</p><button class="retry" type="button">${T.retry}</button>`;
      body.querySelector(".retry").addEventListener("click", () => checkResult(a, item));
      return;
    }
    const shown = resultLabel(res.data);
    a.textContent = shown.text;
    a.style.background = shown.color;
    render(res.data, { heading: item.title }, true);
  }

  // ---- Running it ---------------------------------------------------------

  let lastChecked = "";

  /**
   * An eBay item page: only the item number is sent (from the address, /itm/123… or /itm/title/123…);
   * SigPath reads the listing itself from eBay's API, seller and ratings included.
   */
  async function runEbay() {
    const itemId = location.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{9,15})/)?.[1];
    if (!itemId) return;
    const key = `ebay|${itemId}`;
    if (key === lastChecked) return;
    lastChecked = key;
    const open = visible();
    if (open) showPanel().body.innerHTML = `<p class="muted">${T.checking}</p>`;
    const res = await ask({ type: "check", product: { from: "ebay", itemId, url: location.origin + location.pathname, lang: DE ? "de" : "en" } });
    if (lastChecked !== key) return;
    if (!res.ok) {
      if (!open && !panel) return;
      const body = showPanel().body;
      // Not an outage: a listing with variations, or one that's gone. Said as it is, no "try again".
      if (res.reason === "variations" || res.reason === "not_found") {
        body.innerHTML = `<p class="muted">${res.reason === "variations" ? T.variations : T.gone}</p>`;
        return;
      }
      body.innerHTML = `<p class="muted">${T.error}</p><p class="muted">${esc(res.error)}</p><button class="retry" type="button">${T.retry}</button>`;
      body.querySelector(".retry").addEventListener("click", () => {
        lastChecked = "";
        runEbay();
      });
      return;
    }
    render(res.data, {}, open || !!panel);
  }

  async function run() {
    if (SHOP === "ebay") return runEbay();
    if (SHOP === "amazon" && /^\/s$|^\/s\//.test(location.pathname)) {
      searchResults();
      return;
    }
    const product = SHOP === "amazon" ? amazonProduct() : otherProduct();
    if (!product) {
      // Asked from the menu, it answers even when there's nothing to check.
      if (manual() && !panel) showPanel().body.innerHTML = `<p class="muted">${T.nothing}</p>`;
      return;
    }
    const key = `${product.title}|${product.price}`;
    if (key === lastChecked) return;
    lastChecked = key;
    const open = visible();
    if (!product.price) {
      // A product page, but no price SigPath can read: say so rather than stay silent.
      if (open) showPanel().body.innerHTML = `<p class="muted">${T.noPrice}</p>`;
      return;
    }
    if (open) showPanel().body.innerHTML = `<p class="muted">${T.checking}</p>`;
    const res = await ask({
      type: "check",
      product: {
        from: SHOP,
        title: product.title.slice(0, 300),
        price: product.price.slice(0, 40),
        url: location.origin + location.pathname,
        asin: product.asin,
        imageUrl: product.imageUrl,
        was: product.was,
        wasLabel: product.wasLabel,
        lowest30: product.lowest30,
        lang: DE ? "de" : "en",
      },
    });
    // A check that came back after the shopper moved on to another product isn't this page's.
    if (lastChecked !== key) return;
    if (!res.ok) {
      // The reason, as the background worker gave it: no server, too slow, a reloaded extension.
      // Shown only where the panel is open, with a way to ask again.
      if (!open && !panel) return;
      const body = showPanel().body;
      body.innerHTML = `<p class="muted">${T.error}</p><p class="muted">${esc(res.error)}</p><button class="retry" type="button">${T.retry}</button>`;
      body.querySelector(".retry").addEventListener("click", () => {
        lastChecked = "";
        run();
      });
      return;
    }
    render(res.data, product, open || !!panel);
  }

  // The menu's "Show the check": the panel opens, whatever the setting.
  window.__sigpathRerun = () => {
    forced = true;
    lastChecked = "";
    run();
  };
  // After the settings, so the first check knows whether to open the panel.
  ready.then(run);
  // Shops that change page without reloading (OTTO, MediaMarkt), and Amazon results that load more as you scroll.
  let href = location.href;
  let timer = 0;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (location.href !== href) {
        href = location.href;
        lastChecked = "";
        forced = false;
        if (panel) { panel.host.remove(); panel = null; }
        ask({ type: "forget" });
      }
      run();
    }, 1200);
  }).observe(document.body, { childList: true, subtree: true });
})();
