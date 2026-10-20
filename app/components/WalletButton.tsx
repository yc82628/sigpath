"use client";

import { useState } from "react";
import { useMessages } from "./I18n";
import { WalletPicker, useWallet, useWalletErrorText } from "./WalletProvider";
import type { ConnectedWallet, WalletOption } from "./wallet";

/**
 * One button for every wallet step. If a wallet is already connected (in the
 * header, or at an earlier step on any page), it goes straight on with that
 * one. Otherwise it connects first: straight away with one Solana wallet
 * installed, after asking which with several, and with none it shows how to
 * get one in place (and on a phone, how to open SigPath in a wallet app).
 *
 * `onConnect` gets the connected wallet and does the rest of the step (and
 * handles its own errors); `onError` gets the reason a wallet couldn't
 * connect, already in the page's language.
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
  const m = useMessages();
  const { wallet, connect, findOptions } = useWallet();
  const describe = useWalletErrorText();
  const [picking, setPicking] = useState<WalletOption[] | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function use(option: WalletOption) {
    setPicking(null);
    setConnecting(true);
    let connected: ConnectedWallet;
    try {
      connected = await connect(option);
    } catch (err) {
      onError(describe(err));
      return;
    } finally {
      setConnecting(false);
    }
    await onConnect(connected);
  }

  async function start() {
    if (wallet) return void onConnect(wallet);
    setConnecting(true);
    const found = await findOptions();
    setConnecting(false);
    if (found.length === 1) void use(found[0]);
    else setPicking(found); // several to choose from, or none: the picker says how to get one
  }

  if (picking) return <WalletPicker options={picking} onPick={use} onCancel={() => setPicking(null)} />;

  return (
    <button type="button" className={className} disabled={disabled || connecting} onClick={start}>
      {connecting ? m.wallet.connecting : label}
    </button>
  );
}
