"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PAY_TOKEN_LIST, type PayToken } from "@/lib/chains/solana/tokens";
import { useMessages } from "../components/I18n";

/**
 * Which coin to pay in: EURC (a digital euro, so a euro price is paid as it is)
 * or USDC (a digital dollar, the same value counted in dollars). Shown above
 * the invoice, which is drawn in the coin picked here.
 *
 * With `onPick` the caller redraws the invoice itself (the cart). Without it,
 * the choice goes into the page's address as ?pay=eurc|usdc and the server
 * draws the invoice again (one listing's checkout).
 */
export default function CoinChoice({ token, onPick, disabled }: { token: PayToken; onPick?: (t: PayToken) => void; disabled?: boolean }) {
  const m = useMessages();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();

  function pick(t: PayToken) {
    if (t === token) return;
    if (onPick) return onPick(t);
    const qs = new URLSearchParams(params.toString());
    qs.set("pay", t.toLowerCase());
    // The address typed into the form below stays: only the invoice is drawn again.
    router.replace(`${path}?${qs}`, { scroll: false });
  }

  return (
    <fieldset className="coin-choice" disabled={disabled}>
      <legend>{m.checkout.coinTitle}</legend>
      {PAY_TOKEN_LIST.map((t) => (
        <label key={t} className={`coin${t === token ? " on" : ""}`}>
          <input type="radio" name="coin" value={t} checked={t === token} onChange={() => pick(t)} />
          <span>
            <b>{m.checkout.coins[t].title}</b>
            <span className="hint">{m.checkout.coins[t].sub}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
