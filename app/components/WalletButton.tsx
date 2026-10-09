"use client";

import { useEffect, useState } from "react";
import { NO_WALLET_MESSAGE, walletErrorMessage, walletOptions, walletRegistry, type ConnectedWallet, type WalletOption } from "./wallet";

/**
 * One button for every wallet step. With one Solana wallet installed it
 * connects straight away; with several, it asks which one first.
 *
 * Wallets are found through the Wallet Standard and, failing that, the older
 * objects wallets put on `window` (see wallet.ts). The list is read again on
 * click, after a short wait if it is still empty, because an extension can
 * finish loading after the page.
 *
 * `onConnect` gets the connected wallet and does the rest of the step (and
 * handles its own errors); `onError` gets the reason a wallet couldn't connect.
 */
export default function WalletButton({
  label,
  disabled,
  className = "primary",
  onConnect,
  onError,
}: {
  label: string;
  disabled?: boolean;
  className?: string;
  onConnect: (wallet: ConnectedWallet) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [choices, setChoices] = useState<WalletOption[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const registry = walletRegistry();
    if (!registry) return;
    return registry.on(() => setChoices(walletOptions(registry)));
  }, []);

  async function use(option: WalletOption) {
    setChoosing(false);
    setConnecting(true);
    let connected: ConnectedWallet;
    try {
      connected = await option.connect();
    } catch (err) {
      onError(`Wallet connection refused: ${walletErrorMessage(err)}`);
      return;
    } finally {
      setConnecting(false);
    }
    await onConnect(connected);
  }

  async function start() {
    let found = walletOptions();
    if (!found.length) {
      setConnecting(true);
      await new Promise((r) => setTimeout(r, 800));
      setConnecting(false);
      found = walletOptions();
    }
    setChoices(found);
    if (found.length === 0) onError(NO_WALLET_MESSAGE);
    else if (found.length === 1) void use(found[0]);
    else setChoosing(true);
  }

  if (choosing) {
    return (
      <div className="wallet-choice" role="group" aria-label="Choose a wallet">
        {choices.map((w) => (
          <button key={w.name} type="button" onClick={() => use(w)}>
            {/* Wallets give their icon as a data: URI, so a plain img is right. */}
            {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
            {w.name}
          </button>
        ))}
        <button type="button" className="link" onClick={() => setChoosing(false)}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button type="button" className={className} disabled={disabled || connecting} onClick={start}>
      {connecting ? "Connecting…" : label}
    </button>
  );
}
