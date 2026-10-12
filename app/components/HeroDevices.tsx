/**
 * The home page's introduction: SigPath on a laptop and a phone.
 *
 * The devices are drawn in CSS, so the only downloads are two screenshots
 * (WebP, ~50 KB and ~100 KB). The phone's screen scrolls slowly through a
 * search, the devices float a little, and with "reduce motion" set they stay
 * still (globals.css). The screenshots show SigPath's own demo listings, never
 * a marketplace's: eBay's listing data and photos aren't SigPath's to keep
 * in a picture.
 */

export default function HeroDevices() {
  return (
    <figure className="devices" aria-label="SigPath on a laptop and a phone: every listing gets one verdict, with the reasons">
      <div className="laptop">
        <div className="laptop-lid">
          <div className="laptop-screen">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/home/laptop.webp" width={1280} height={800} alt="" decoding="async" />
          </div>
        </div>
        <div className="laptop-base" />
      </div>
      <div className="phone">
        <div className="phone-screen">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="phone-scroll" src="/home/phone.webp" width={480} height={3200} alt="" decoding="async" />
        </div>
      </div>
      <figcaption className="devices-caption">Demo listings shown. Every result gets one verdict, with the reasons.</figcaption>
    </figure>
  );
}

/** Slow smoke behind the whole page: three soft clouds, CSS only. */
export function Smoke() {
  return (
    <div className="smoke" aria-hidden="true">
      <span className="smoke-a" />
      <span className="smoke-b" />
      <span className="smoke-c" />
    </div>
  );
}
