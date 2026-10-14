import Link from "next/link";
import PopIcon from "../components/PopIcon";
import OpenFromHash from "../components/OpenFromHash";
import { Part } from "./Part";
import PrivacyDe from "./PrivacyDe";
import { getLang } from "@/lib/i18n/server";
import {
  aliexpressAffiliate,
  aliexpressOn,
  amazonTag,
  assistantProvider,
  assistantBackupProvider,
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
 *
 * A picture summary first, then each topic folded (Part): the whole text is on
 * the page, as the law asks, without reading like a manual. The German version
 * is PrivacyDe.tsx: a change here belongs there too.
 */

export function generateMetadata() {
  return { title: getLang() === "de" ? "Datenschutzerklärung — SigPath" : "Privacy policy — SigPath" };
}
export const dynamic = "force-dynamic";

const days = (secs: number) => Math.round(secs / 86400);

const minutes = (secs: number) => Math.round(secs / 60);

/** In the page's language: German (PrivacyDe.tsx) or English (below), the same policy either way. */
export default function PrivacyPage() {
  return getLang() === "de" ? <PrivacyDe /> : <PrivacyEn />;
}

function PrivacyEn() {
  const op = operator();
  const ai = assistantProvider();
  const aiBackup = assistantBackupProvider();
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

      <p className="lede">The short version, in pictures. Tap a topic below for the full detail.</p>
      <ul className="privacy-glance">
        <li>
          <PopIcon name="user-focus" tone="purple" size={28} />
          <strong>No account</strong>
          <span>No sign-in, nothing to sign up for.</span>
        </li>
        <li>
          <PopIcon name="prohibit" tone="blue" size={28} />
          <strong>No tracking</strong>
          <span>No ad or tracking cookies.{counter ? " Visits counted as totals." : ""}</span>
        </li>
        <li>
          <PopIcon name="magnifying-glass" tone="green" size={28} />
          <strong>Searches not kept</strong>
          <span>Sent to the marketplaces, never stored.</span>
        </li>
        <li>
          <PopIcon name="shopping-cart-simple" tone="purple" size={28} />
          <strong>Cart on your device</strong>
          <span>In your browser, not on our servers.</span>
        </li>
        <li>
          <PopIcon name="lock-key" tone="blue" size={28} />
          <strong>Extension: your choice</strong>
          <span>Sharing Amazon prices is off unless you turn it on.</span>
        </li>
        {checkout && (
          <li>
            <PopIcon name="vault" tone="green" size={28} />
            <strong>Address encrypted</strong>
            <span>Only to deliver your order, then deleted.</span>
          </li>
        )}
        <li>
          <PopIcon name="wallet" tone="purple" size={28} />
          <strong>Blockchain is public</strong>
          <span>A payment on Solana is visible forever.</span>
        </li>
        <li>
          <PopIcon name="trash" tone="blue" size={28} />
          <strong>Deleted on schedule</strong>
          <span>Kept only for the feature you use.</span>
        </li>
      </ul>

      <h2 className="legal-full">The full detail</h2>
      <OpenFromHash />
      <Part title="Who is responsible">
        <p>
          {op ? (
            <>
              {op.name}, {op.address.join(", ")}. E-mail: <a href={`mailto:${op.email}`}>{op.email}</a>.
            </>
          ) : (
            <>The operator named in the <Link href="/impressum">Impressum</Link>.</>
          )}
        </p>
      </Part>

      <Part title="Visiting the site">
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
      </Part>
      {counter && (
        <>
          <Part title="Counting visits">
            <p>
              To know how many people use SigPath and where they come from, the site counts page views with Vercel Web
              Analytics (Vercel Inc., USA). It sets no cookies. Before a page view is sent, its address is cut down to the
              page type: search words, order numbers, seller names and anything after &ldquo;?&rdquo; are removed. With
              each page view Vercel records the time, that page type, the website you came from (only if it is another site), your approximate location
              (country, region, city), and your browser, operating system and device type. Vercel tells visitors apart by
              a hash of the request, which it discards after 24 hours, and SigPath only sees totals (legal basis: Art.
              6(1)(f) GDPR, our interest in knowing which pages are used and how people find the site).
            </p>
          </Part>
        </>
      )}

      <Part title="Searching">
        <p>
          Your search words are sent to eBay&apos;s{ali ? " and AliExpress’s" : ""} official API{ali ? "s" : ""} to fetch listings. No information about you is sent with them,
          and SigPath stores neither the search nor the results. A price check (/check) sends the product name and price you bring, and the address of the page they came from, to SigPath to compare with eBay; none of it is stored. Listing photos are loaded from eBay{ali ? " and AliExpress" : ""}, and some of eBay’s are compared for copying.
        </p>
      </Part>
      <Part title="The SigPath browser extension" id="extension">
        <p>
          The extension runs by itself only on Amazon, AliExpress, OTTO, MediaMarkt and Saturn pages you open, and on another
          shop&apos;s page only when you click &ldquo;Check this page&rdquo; in its menu. On a product page
          it reads the product&apos;s name and price (on Amazon also its product number, photo address and seller name) and
          sends them, with the page&apos;s address, to SigPath for the same check as /check. Only if you turn on &ldquo;Share
          Amazon.de prices I see&rdquo; (a switch in the extension&apos;s menu, off until you do), SigPath keeps Amazon products you looked at, and those
          listed on Amazon results pages you open: the product number, title, price, photo address and when it was seen,
          for SigPath&apos;s search to show as &ldquo;seen on Amazon&rdquo;. Nothing about you is sent or kept with them:
          no account, no address, no record of who saw what. A newer sighting of a product replaces the older one, and
          sightings over a week old are not shown. Turn the switch off and nothing is shared; the check still works.
        </p>
      </Part>
      <Part title="Your cart">
        <p>
          The cart is kept only in your browser (its local storage), not on SigPath&apos;s servers, and there is no account
          behind it. It holds what the search showed for each item you added: title, link, photo address, seller name,
          price and SigPath&apos;s verdict. When you open the cart, your browser sends the items&apos; listing numbers to
          SigPath, which asks eBay for today&apos;s price; nothing about this is stored. Items are removed after 30 days, and
          &ldquo;Empty the cart&rdquo; or clearing this site&apos;s data removes them at once.
        </p>
      </Part>
      {ai && (
        <>
          <Part title="Ai-chan, the shopping assistant">
            <p>
              When you chat with Ai-chan, your messages are sent to {modelPhrase(ai)} to write the answer
              {aiBackup && aiBackup !== ai && <>, or, when that one is unavailable, to {modelPhrase(aiBackup)}</>}. SigPath does not save your chats.
              Please don&apos;t share personal details in them (legal basis: Art. 6(1)(f) GDPR).
            </p>
          </Part>
        </>
      )}

      {checkout && (
        <>
          <Part title="Paying with USDC">
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
          </Part>
        </>
      )}

      {reports && (
        <>
          <Part title="Reporting a fake">
            <p>
              A report needs your description, a live photo of the item and a signature from the wallet that paid. They are
              stored encrypted for the reviewer and deleted as soon as the report is decided, and in any case after{" "}
              {days(PENDING_REPORT_MAX_SECS)} days.
              {photos ? ` The photo is checked by ${modelPhrase(photos)}.` : ""} If the report is upheld, a finding about
              the seller is published on Solana: it contains nothing about you, not your wallet, words or photo.
            </p>
          </Part>
        </>
      )}

      <Part title="Verified sellers and businesses">
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
      </Part>
      <Part title="Checking a supplier">
        <p>
          The VAT number and website you enter are sent to the EU&apos;s VIES service and to domain registries for the check.
          Nothing is saved.
        </p>
      </Part>
      {alerts && (
        <>
          <Part title="Price alerts">
            <p>
              An alert stores your browser&apos;s push address, the search and your target price for up to{" "}
              {days(WATCH_TTL_SECS)} days; you can delete it at any time. Notifications reach you through your browser
              maker&apos;s push service (for example Google, Mozilla or Apple). Legal basis: Art. 6(1)(a) GDPR, your consent,
              which you can withdraw by deleting the alert.
            </p>
          </Part>
        </>
      )}

      <Part title="The Solana blockchain">
        <p>
          Wallet transactions are sent through {solanaRpcProvider()}. Anything written to Solana is public and permanent:
          nobody, including SigPath, can delete it. Your wallet address appears there only when you pay, claim a seller badge
          or verify a business.
        </p>
      </Part>
      {aliexpressAffiliate() && (
        <>
          <Part title="AliExpress links">
            <p>
              Links to AliExpress carry SigPath&apos;s affiliate tracking id, and SigPath may earn a commission on what you buy.
              Once you are on AliExpress, AliExpress&apos;s own privacy policy applies, including its cookies.
            </p>
          </Part>
        </>
      )}

      {tag && (
        <>
          <Part title="Amazon links">
            <p>
              Links to Amazon carry SigPath&apos;s Amazon Associates tag. As an Amazon Associate, SigPath earns from qualifying
              purchases. Once you are on Amazon, Amazon&apos;s own privacy notice applies, including its cookies.
            </p>
          </Part>
        </>
      )}

      <Part title="Providers outside the EU">
        <p>
          Some providers named here are based in the USA{ali ? ", and AliExpress’s API is served from Singapore" : ""}, so data sent to them may be processed there.
        </p>
      </Part>
      <Part title="Your rights">
        <p>
          You can ask for access to your data, its correction or deletion, restriction of its use and a copy of it, and you
          can object to its use (Art. 15–21 GDPR). Data on the blockchain can&apos;t be deleted by anyone. You can also
          complain to a data protection supervisory authority. To use any of these rights, write to the address in the{" "}
          <Link href="/impressum">Impressum</Link>.
        </p>
      </Part>
    </main>
  );
}
