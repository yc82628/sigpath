"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import WalletButton from "../../components/WalletButton";
import { waitForOrder, walletErrorMessage, type ConnectedWallet } from "../../components/wallet";

/**
 * Trigger the refund once the deadline has passed.
 *
 * Any wallet can do this, not just the buyer's — the program sends the money
 * to the buyer's own USDC account whoever signs, so there is nothing to gain by
 * calling it for someone else, and nothing anyone can do to stop it.
 */
export default function RefundButton({ order }: { order: string }) {
  const router = useRouter();
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
      if (!res.ok) throw new Error(body.error ?? `Refund failed (${res.status}).`);

      setMessage(`Approve the refund in ${wallet.name}.`);
      await wallet.signAndSend(body.transaction);

      setMessage("Refund sent. Waiting for confirmation…");
      await waitForOrder(order, (s) => s.status === "refunded");
      router.refresh();
    } catch (err) {
      setMessage(walletErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <WalletButton label={busy ? "Working…" : "Refund this order"} disabled={busy} onConnect={refund} onError={setMessage} />
      {message && <p className="hint">{message}</p>}
    </div>
  );
}
