import Link from "next/link";
import {
  aliexpressAffiliate,
  aliexpressOn,
  amazonTag,
  assistantProvider,
  hasCheckout,
  hasDatabase,
  hasPriceAlerts,
  hasReports,
  modelPhrase,
  operator,
  photoCheckProvider,
  solanaRpcProvider,
} from "@/lib/legal/site";
import { PENDING_TTL_SECONDS, RETENTION_MAX_SECONDS } from "@/lib/checkout/address-store";
import { REPORT_WINDOW_SECS } from "@/lib/reports/order-meta";
import { PENDING_REPORT_MAX_SECS } from "@/lib/reports/reports";
import { WATCH_TTL_SECS } from "@/lib/alerts/watches";
import { visitCounterOn } from "@/lib/visits";
import { BUSINESS_TTL_SECS } from "@/lib/sellers/business";

/**
 * app/privacy/page.tsx — the privacy policy (Datenschutzerklärung).
 *
 * Every section describes code in this repository, and every outside provider
 * is named from the setting the feature itself reads (lib/legal/site.ts): a
 * feature that is switched off is not listed, and the retention periods are
 * the constants the stores enforce. Not legal advice: have it reviewed.
 */

export const metadata = { title: "Privacy policy — SigPath" };
export const dynamic = "force-dynamic";

const days = (secs: number) => Math.round(secs / 86400);
const minutes = (secs: number) => Math.round(secs / 60);

export default function PrivacyPage() {
  const op = operator();
  const ai = assistantProvider();
  const photos = photoCheckProvider();
  const checkout = hasCheckout();
  const alerts = hasPriceAlerts();
  const tag = amazonTag();
  const reports = hasReports();
  const counter = visitCounterOn();
  const ali = aliexpressOn();
  const storage = hasDatabase() ? "in an encrypted record in SigPath's database (Upstash)" : "in an encrypted record on SigPath's server";

  return (
    <main className="container legal">
      <h1>Privacy policy</h1>
      <p className="hint">Datenschutzerklärung</p>

      <h2>In short</h2>
      <ul>
        <li>No account, no sign-in, no advertising or tracking cookies.</li>
        {counter && <li>Visits are counted without cookies, and SigPath only sees totals.</li>}
        <li>SigPath only keeps data for a feature you use, encrypted where it is personal, and deletes it on a schedule.</li>
        <li>What goes on the Solana blockchain is public and permanent; this page says exactly what that is.</li>
      </ul>

      <h2>Who is responsible</h2>
      <p>
        {op ? (
          <>
            {op.name}, {op.address.join(", ")}. E-mail: <a href={`mailto:${op.email}`}>{op.email}</a>.
          </>
        ) : (
          <>The operator named in the <Link href="/impressum">Impressum</Link>.</>
        )}
      </p>

      <h2>Visiting the site</h2>
      <p>
        SigPath is hosted by Vercel Inc., USA. To deliver the pages and protect them from abuse, Vercel processes technical
        data such as your IP address, the time and the page requested (legal basis: Art. 6(1)(f) GDPR, our interest in a
        secure, working site). The site&apos;s fonts are served by SigPath itself, so your browser makes no request to Google
        Fonts.
      </p>
      <p>
        If you switch the site to German (or back), one cookie, <code>sigpath-lang</code>, remembers the choice for a year. It
        holds only &ldquo;de&rdquo; or &ldquo;en&rdquo;, is sent only to SigPath, and is set only when you press the switch
        (legal basis: § 25(2) no. 2 TDDDG, storage you asked for).
      </p>
      <p>
        So that one script can&apos;t use up the site&apos;s searches or its checks for everyone, SigPath counts how many
        searches and requests come from each connection in a short window (ten minutes; one hour or one day for a few
        checks). It doesn&apos;t store your IP address for this: only a keyed hash of it, which can&apos;t be turned back into
        the address without SigPath&apos;s secret, next to a number.{" "}
        {hasDatabase() ? "The count is kept in SigPath's database (Upstash) and" : "The count"} is deleted
        automatically when its window ends (legal basis: Art. 6(1)(f) GDPR, our interest in keeping the site available).
      </p>

      {counter && (
        <>
          <h2>Counting visits</h2>
          <p>
            To know how many people use SigPath and where they come from, the site counts page views with Vercel Web
            Analytics (Vercel Inc., USA). It sets no cookies. Before a page view is sent, its address is cut down to the
            page type: search words, order numbers, seller names and anything after &ldquo;?&rdquo; are removed. With
            each page view Vercel records the time, that page type, the website you came from (only if it is another site), your approximate location
            (country, region, city), and your browser, operating system and device type. Vercel tells visitors apart by
            a hash of the request, which it discards after 24 hours, and SigPath only sees totals (legal basis: Art.
            6(1)(f) GDPR, our interest in knowing which pages are used and how people find the site).
          </p>
        </>
      )}

      <h2>Searching</h2>
      <p>
        Your search words are sent to eBay&apos;s{ali ? " and AliExpress’s" : ""} official API{ali ? "s" : ""} to fetch listings. No information about you is sent with them,
        and SigPath stores neither the search nor the results. A price check (/check) sends the product name and price you bring, and the address of the page they came from, to SigPath to compare with eBay; none of it is stored. Listing photos are loaded from eBay{ali ? " and AliExpress" : ""}, and some of eBay’s are compared for copying.
      </p>

      <h2 id="extension">The SigPath browser extension</h2>
      <p>
        The extension runs only on Amazon.de, AliExpress, OTTO, MediaMarkt and Saturn pages you open. On a product page
        it reads the product&apos;s name and price (on Amazon also its product number, photo address and seller name) and
        sends them, with the page&apos;s address, to SigPath for the same check as /check. With &ldquo;Share Amazon prices
        I see&rdquo; on (the default, a switch in the extension), SigPath keeps Amazon products you looked at, and those
        listed on Amazon results pages you open: the product number, title, price, photo address and when it was seen,
        for SigPath&apos;s search to show as &ldquo;seen on Amazon&rdquo;. Nothing about you is sent or kept with them:
        no account, no address, no record of who saw what. A newer sighting of a product replaces the older one, and
        sightings over a week old are not shown. Turn the switch off and nothing is shared; the check still works.
      </p>

      <h2>Your cart</h2>
      <p>
        The cart is kept only in your browser (its local storage), not on SigPath&apos;s servers, and there is no account
        behind it. It holds what the search showed for each item you added: title, link, photo address, seller name,
        price and SigPath&apos;s verdict. When you open the cart, your browser sends the items&apos; listing numbers to
        SigPath, which asks eBay for today&apos;s price; nothing about this is stored. Items are removed after 30 days, and
        &ldquo;Empty the cart&rdquo; or clearing this site&apos;s data removes them at once.
      </p>

      {ai && (
        <>
          <h2>Ai-chan, the shopping assistant</h2>
          <p>
            When you chat with Ai-chan, your messages are sent to {modelPhrase(ai)} to write the answer. SigPath does not save your chats.
            Please don&apos;t share personal details in them (legal basis: Art. 6(1)(f) GDPR).
          </p>
        </>
      )}

      {checkout && (
        <>
          <h2>Paying with USDC</h2>
          <ul>
            <li>
              <strong>Your delivery address</strong> (name, street, postcode, city, country) is stored {storage}, used only
              to have your item delivered, and passed to the seller when SigPath buys the item for you. It is deleted when
              the order is fulfilled or refunded, after {minutes(PENDING_TTL_SECONDS)} minutes if you don&apos;t pay, and in
              any case within {days(RETENTION_MAX_SECONDS)} days.
            </li>
            <li>
              <strong>An order record</strong> (the listing, the price and your wallet address) is kept for{" "}
              {days(REPORT_WINDOW_SECS)} days after delivery so you can report a fake, then deleted.
            </li>
            <li>
              <strong>Your payment</strong> is a Solana transaction. Your wallet address and the payment are public on the
              blockchain and can&apos;t be deleted.
            </li>
          </ul>
          <p className="hint">Legal basis: Art. 6(1)(b) GDPR, to carry out your purchase.</p>
        </>
      )}

      {reports && (
        <>
          <h2>Reporting a fake</h2>
          <p>
            A report needs your description, a live photo of the item and a signature from the wallet that paid. They are
            stored encrypted for the reviewer and deleted as soon as the report is decided, and in any case after{" "}
            {days(PENDING_REPORT_MAX_SECS)} days.
            {photos ? ` The photo is checked by ${modelPhrase(photos)}.` : ""} If the report is upheld, a finding about
            the seller is published on Solana: it contains nothing about you, not your wallet, words or photo.
          </p>
        </>
      )}

      <h2>Verified sellers and businesses</h2>
      <ul>
        <li>
          <strong>Seller badge:</strong> SigPath keeps your marketplace account name, your wallet address and the badge
          dates. The live photo is checked{photos ? ` by ${modelPhrase(photos)}` : ""} and then discarded: no picture or
          face data is kept. The badge is a token in your wallet and a record on Solana, both public; it lasts a year and
          is closed early if a fake-product report is upheld.
        </li>
        <li>
          <strong>Verified business:</strong> your VAT number is checked with the EU&apos;s VIES service and your website
          through its domain registry. SigPath keeps the business record for up to {days(BUSINESS_TTL_SECS)} days; on
          Solana the VAT number and website are stored only as one-way hashes.
        </li>
        <li>If you delete your eBay account, eBay notifies SigPath and the matching records are deleted.</li>
      </ul>
      <p className="hint">Legal basis: Art. 6(1)(b) GDPR, the verification you ask for.</p>

      <h2>Checking a supplier</h2>
      <p>
        The VAT number and website you enter are sent to the EU&apos;s VIES service and to domain registries for the check.
        Nothing is saved.
      </p>

      {alerts && (
        <>
          <h2>Price alerts</h2>
          <p>
            An alert stores your browser&apos;s push address, the search and your target price for up to{" "}
            {days(WATCH_TTL_SECS)} days; you can delete it at any time. Notifications reach you through your browser
            maker&apos;s push service (for example Google, Mozilla or Apple). Legal basis: Art. 6(1)(a) GDPR, your consent,
            which you can withdraw by deleting the alert.
          </p>
        </>
      )}

      <h2>The Solana blockchain</h2>
      <p>
        Wallet transactions are sent through {solanaRpcProvider()}. Anything written to Solana is public and permanent:
        nobody, including SigPath, can delete it. Your wallet address appears there only when you pay, claim a seller badge
        or verify a business.
      </p>

      {aliexpressAffiliate() && (
        <>
          <h2>AliExpress links</h2>
          <p>
            Links to AliExpress carry SigPath&apos;s affiliate tracking id, and SigPath may earn a commission on what you buy.
            Once you are on AliExpress, AliExpress&apos;s own privacy policy applies, including its cookies.
          </p>
        </>
      )}

      {tag && (
        <>
          <h2>Amazon links</h2>
          <p>
            Links to Amazon carry SigPath&apos;s Amazon Associates tag. As an Amazon Associate, SigPath earns from qualifying
            purchases. Once you are on Amazon, Amazon&apos;s own privacy notice applies, including its cookies.
          </p>
        </>
      )}

      <h2>Providers outside the EU</h2>
      <p>
        Some providers named here are based in the USA{ali ? ", and AliExpress’s API is served from Singapore" : ""}, so data sent to them may be processed there.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for access to your data, its correction or deletion, restriction of its use and a copy of it, and you
        can object to its use (Art. 15–21 GDPR). Data on the blockchain can&apos;t be deleted by anyone. You can also
        complain to a data protection supervisory authority. To use any of these rights, write to the address in the{" "}
        <Link href="/impressum">Impressum</Link>.
      </p>
    </main>
  );
}
