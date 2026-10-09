"use client";

import { useEffect, useState } from "react";
import {
  connectWallet,
  NO_WALLET_MESSAGE,
  walletErrorMessage,
  walletRegistry,
  type ConnectedWallet,
  type StandardWallet,
} from "./wallet";

/**
 * One button for every wallet step. With one Solana wallet installed it
 * connects straight away; with several, it asks which one first.
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
  const [wallets, setWallets] = useState<StandardWallet[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const registry = walletRegistry();
    if (!registry) return;
    setWallets(registry.get());
    return registry.on(() => setWallets(registry.get()));
  }, []);

  async function use(wallet: StandardWallet) {
    setChoosing(false);
    setConnecting(true);
    let connected: ConnectedWallet;
    try {
      connected = await connectWallet(wallet);
    } catch (err) {
      onError(`Wallet connection refused: ${walletErrorMessage(err)}`);
      return;
    } finally {
      setConnecting(false);
    }
    await onConnect(connected);
  }

  function start() {
    if (wallets.length === 0) onError(NO_WALLET_MESSAGE);
    else if (wallets.length === 1) void use(wallets[0]);
    else setChoosing(true);
  }

  if (choosing) {
    return (
      <div className="wallet-choice" role="group" aria-label="Choose a wallet">
        {wallets.map((w) => (
          <button key={w.name} type="button" onClick={() => use(w)}>
            {/* Wallets give their icon as a data: URI, so a plain img is right. */}
            <img src={w.icon} alt="" width={20} height={20} />
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
