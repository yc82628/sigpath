import { getLang } from "@/lib/i18n/server";
import Till from "./Till";

/**
 * app/till — the shop till: payments at the counter by bank QR code
 * (lib/till/epc.ts). Straight from the customer's bank to the shop's; SigPath
 * draws the code and stores nothing.
 */

const words = {
  en: { title: "Shop till", lede: "Take payments at the counter by bank QR code: the customer pays from their banking app, straight into your account, with no card fees and no terminal." },
  de: { title: "Shop-Kasse", lede: "Nimm Zahlungen an der Theke per Bank-QR-Code an: Der Kunde zahlt aus seiner Banking-App direkt auf dein Konto, ohne Kartengebühren und ohne Terminal." },
};

export function generateMetadata() {
  const w = words[getLang()];
  return { title: `${w.title} — SigPath`, description: w.lede };
}

export default function TillPage() {
  const w = words[getLang()];
  return (
    <main className="container till-page">
      <h1>{w.title}</h1>
      <p className="lede">{w.lede}</p>
      <Till />
    </main>
  );
}
