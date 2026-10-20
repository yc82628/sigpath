"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import WalletButton from "../../components/WalletButton";
import { waitForOrder, type ConnectedWallet } from "../../components/wallet";
import { useWalletErrorText } from "../../components/WalletProvider";
import { useLang } from "../../components/I18n";

/**
 * Trigger the refund once the deadline has passed.
 *
 * Any wallet can do this, not just the buyer's — the program sends the money
 * to the buyer's own USDC account whoever signs, so there is nothing to gain by
 * calling it for someone else, and nothing anyone can do to stop it.
 */
export default function RefundButton({ order }: { order: string }) {
  const router = useRouter();
  const de = useLang() === "de";
  const describe = useWalletErrorText();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function refund(wallet: ConnectedWallet) {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${order}/refund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: wallet.address }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? (de ? `Rückerstattung fehlgeschlagen (${res.status}).` : `Refund failed (${res.status}).`));

      setMessage(de ? `Bestätige die Rückerstattung in ${wallet.name}.` : `Approve the refund in ${wallet.name}.`);
      await wallet.signAndSend(body.transaction);

      setMessage(de ? "Rückerstattung gesendet. Warte auf die Bestätigung…" : "Refund sent. Waiting for confirmation…");
      await waitForOrder(order, (s) => s.status === "refunded");
      router.refresh();
    } catch (err) {
      setMessage(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <WalletButton
        label={busy ? (de ? "Bitte warten…" : "Working…") : de ? "Diese Bestellung erstatten" : "Refund this order"}
        disabled={busy}
        onConnect={refund}
        onError={setMessage}
      />
      {message && <p className="hint">{message}</p>}
    </div>
  );
}
