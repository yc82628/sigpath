"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getPhantom, txFromBase64, waitForOrder, walletErrorMessage } from "../../components/phantom";

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

  async function refund() {
    const phantom = getPhantom();
    if (!phantom) {
      setMessage("Phantom wallet not found. Install it, set it to Devnet, and reload.");
      return;
    }
    setBusy(true);
    try {
      const { publicKey } = await phantom.connect();
      const res = await fetch(`/api/orders/${order}/refund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller: publicKey.toBase58() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Refund failed (${res.status}).`);

      setMessage("Approve the refund in Phantom.");
      await phantom.signAndSendTransaction(txFromBase64(body.transaction));

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
      <button type="button" className="primary" onClick={refund} disabled={busy}>
        {busy ? "Working…" : "Refund this order"}
      </button>
      {message && <p className="hint">{message}</p>}
    </div>
  );
}
