"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import WalletButton from "../components/WalletButton";
import { shortAddress, useWallet, useWalletErrorText } from "../components/WalletProvider";
import { WalletError, type ConnectedWallet } from "../components/wallet";
import { useMessages } from "../components/I18n";

/**
 * Signing in with the wallet (lib/account/session.ts): ask the server for the
 * text, have the wallet sign it, send the signature back. The server sets an
 * HttpOnly cookie; the page then redraws with this wallet's orders.
 */
export function SignInButton() {
  const m = useMessages();
  const router = useRouter();
  const describe = useWalletErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signIn(wallet: ConnectedWallet) {
    setBusy(true);
    setError("");
    try {
      const c = await fetch("/api/account/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: wallet.address }),
      });
      const asked = await c.json().catch(() => ({}));
      if (!c.ok || typeof asked.message !== "string") throw new Error(m.account.failed);
      const signature = await wallet.signMessage(asked.message);
      const r = await fetch("/api/account/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: asked.token, signature }),
      });
      if (!r.ok) throw new Error(m.account.failed);
      router.refresh();
    } catch (err) {
      // A refusal or a wallet that can't sign, in the wallet's words; anything else is ours.
      setError(err instanceof WalletError ? describe(err) : m.account.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <WalletButton label={busy ? m.account.signingIn : m.account.signIn} disabled={busy} onConnect={signIn} onError={setError} />
      {error && <p className="notice withheld">{error}</p>}
    </>
  );
}

/** The signed-in wallet, sign-out, and a note when the connected wallet is a different one. */
export function SignedIn({ wallet }: { wallet: string }) {
  const m = useMessages();
  const router = useRouter();
  const { wallet: connected } = useWallet();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await fetch("/api/account/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signOut: true }),
    }).catch(() => undefined);
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="account-bar">
      <p>
        {m.account.signedInAs(shortAddress(wallet))}{" "}
        <button type="button" className="button ghost" disabled={busy} onClick={signOut}>
          {m.account.signOut}
        </button>
      </p>
      {connected && connected.address !== wallet && <p className="hint">{m.account.otherWallet(shortAddress(connected.address))}</p>}
    </div>
  );
}
