# Publishing SigPath check

What to paste into the Chrome Web Store (and Microsoft Edge Add-ons) forms. The
upload is a zip of this folder with `manifest.json` at its root (not the folder
itself), e.g. `sigpath-check-0.4.0.zip`.

**0.4.0:** upload only once 0.3.0 is approved; a new upload while one is in
review sends it back to the start of the queue.

- **Chrome Web Store:** https://chrome.google.com/webstore/devconsole, a Google
  developer account, a one-time US$5 registration fee.
- **Edge Add-ons:** https://partner.microsoft.com/dashboard/microsoftedge, free.

## Listing

**Name:** SigPath check

**Summary** (132 characters at most):
> Is it a real deal? On Amazon, AliExpress, OTTO, MediaMarkt and Saturn: the price against eBay, red flags, and a better deal if any.

German (128):
> Echtes Angebot? Auf Amazon, AliExpress, OTTO, MediaMarkt und Saturn: der Preis gegen eBay, Warnsignale und ein besseres Angebot.

Both are true of 0.3.0 (in review) and 0.4.0.

**Category:** Shopping. **Languages:** English, German.

**Description:**
> SigPath shows how good the deal you're looking at really is, before you buy.
>
> On a product page at Amazon, AliExpress, OTTO, MediaMarkt or Saturn, a small
> SigPath panel shows:
> • the deal score: how far the price is from the market for the same product
>   ("−22 %, good deal"), and the usual price range
> • SigPath's warnings: a price too good to be true, a seller with upheld
>   fake-product reports
> • the best SigPath-checked eBay deal for it, and the same product on
>   AliExpress when its price is believable
> • on Amazon, who actually sells it
>
> Prefer it quiet? Turn off "Open the panel by itself": the score shows on the
> icon only, and a warning still opens the panel.
>
> On Amazon's search results, "Check with SigPath" under each result opens the
> check for it. On any other shop, click the icon and "Check this page".
>
> Optional, off until you turn it on: share the Amazon.de prices you see, so
> SigPath's search can show them to other shoppers as "seen on Amazon". Only
> the product and its price, never anything about you.
>
> No account, no tracking. SigPath is open source:
> https://github.com/yc82628/sigpath

**Privacy policy:** https://sigpath.vercel.app/privacy#extension
**Homepage / support:** https://sigpath.vercel.app/extension

**Screenshots** (1280×800 or 640×400, at least one): take them on the real
shops. A product page on Amazon.de with the panel open; an Amazon results page
with the "Check with SigPath" buttons; the menu with "Check this page".

## Privacy practices tab

**Single purpose:**
> Shows SigPath's scam and price check for the product on the shopping page the
> user is viewing.

**Permission justifications:**
- `storage`: remembers two settings (sharing Amazon.de prices; opening the panel by itself), and the last check on each tab for the menu, in session storage only, gone when the browser closes.
- `activeTab`: "Check this page" runs the check on the tab the user has open, only when they click it.
- `scripting`: runs the check script on that tab after that click (on shops it doesn't cover by itself).
- Host permission `https://sigpath.vercel.app/*`: sends the product's name and price to SigPath's own service for the check.
- Content scripts on the listed Amazon, AliExpress, OTTO, MediaMarkt and Saturn sites: read the product's name and price from the page the user opened, and show the panel.

**Remote code:** No. All code is in the package; the extension only exchanges JSON with sigpath.vercel.app.

**Data collected** (tick):
- *Website content*: the product name, price, product number and photo address on the shop page, sent for the check.
- *Web history*: the address of the product page checked; and, only with sharing turned on, the Amazon.de products and prices on pages the user opens.
- Nothing else: no personally identifiable information, no authentication, no personal communications, no location, no financial or health data, no user activity (clicks, keystrokes).

**Certify:** not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

## Other browsers (from 0.4.0)

One package for all of them: the manifest names both a service worker
(Chrome, Brave, Edge, Opera, Vivaldi) and a background script (Firefox), and
the scripts call `browser.*` in Firefox and `chrome.*` elsewhere.

- **Brave, Opera, Vivaldi:** nothing to do. They install from the Chrome Web
  Store, so the Chrome listing covers them.
- **Edge:** installs from the Chrome Web Store too. Its own store, Edge
  Add-ons (https://partner.microsoft.com/dashboard/microsoftedge), is free and
  optional: the same zip, the same texts.
- **Firefox:** addons.mozilla.org (https://addons.mozilla.org/developers/),
  free, with a Firefox account. Upload the same zip as "On this site". No
  source code is asked for: nothing is built or minified. Firefox 128 or later.
  - The manifest's `browser_specific_settings.gecko.data_collection_permissions`
    declares what is sent, and Firefox shows it at install: *website content*
    (the product's name and price) and *browsing activity* (the product page's
    address). Both are needed for the check, so both are "required".
  - Firefox lets people switch off an extension's access to sites. The menu
    then shows "Allow SigPath on the shop sites", which asks again.
  - Listing: the same summary, description and screenshots as Chrome's;
    category "Shopping"; licence MIT; privacy policy
    https://sigpath.vercel.app/privacy#extension.

## After a store approves it

Put the listing's address in Vercel, then redeploy. /extension then shows
"Add to Chrome" / "Add to Firefox" buttons, the visitor's browser first, and
the "Load unpacked" steps fold away under "install it by hand":

- `EXTENSION_CHROME_URL` = `https://chromewebstore.google.com/detail/…`
- `EXTENSION_FIREFOX_URL` = `https://addons.mozilla.org/…/firefox/addon/…`
- `EXTENSION_EDGE_URL` = `https://microsoftedge.microsoft.com/addons/detail/…` (optional)

## Before each upload

1. Raise `version` in `manifest.json`.
2. `npm test` (tests/extension.test.ts checks the permissions, the sites and the
   cross-browser manifest).
3. Zip the folder's contents.
