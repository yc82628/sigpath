"use client";

import { useEffect, useRef, useState } from "react";
import { useLang, useMessages } from "./I18n";
import { WalletPicker, shortAddress, useWallet, useWalletErrorText, useWalletFunds } from "./WalletProvider";
import { DEVNET, type WalletOption } from "./wallet";
import { usdc } from "@/lib/i18n/money";

/**
 * The header's wallet: an icon to connect, and once connected, the short
 * address with a menu: the full address (copy), the balance, the explorer,
 * switch and disconnect. The icon arrives from the server as children, like
 * the cart's.
 */
export default function WalletChip({ children }: { children: React.ReactNode }) {
  const m = useMessages();
  const lang = useLang();
  const describe = useWalletErrorText();
  const { wallet, connect, disconnect, findOptions, notice } = useWallet();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<WalletOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const funds = useWalletFunds(open ? wallet?.address : null);
  const box = useRef<HTMLDivElement>(null);

  // Closes on a click elsewhere, or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setPicking(null);
      setError("");
      setCopied(false);
    }
  }, [open]);

  // The list stays behind the "Connecting…" line, so a refusal can be followed by another try.
  async function use(option: WalletOption) {
    setBusy(true);
    setError("");
    try {
      await connect(option);
      setOpen(false);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function startConnect() {
    setOpen(true);
    setBusy(true);
    const found = await findOptions();
    setBusy(false);
    setPicking(found);
    if (found.length === 1) void use(found[0]);
  }

  async function switchWallet() {
    await disconnect();
    await startConnect();
  }

  async function copy() {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
    } catch {
      /* no clipboard permission: the address is on screen to select */
    }
  }

  const label = wallet ? m.wallet.menu(shortAddress(wallet.address)) : m.wallet.connect;
  const explorer = wallet
    ? `https://explorer.solana.com/address/${wallet.address}${DEVNET ? "?cluster=devnet" : ""}`
    : "";

  return (
    <div className="wallet-chip" ref={box}>
      <button
        type="button"
        className={wallet ? "nav-icon wallet-chip-button connected" : "nav-icon wallet-chip-button"}
        aria-label={label}
        data-label={open ? undefined : label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? setOpen(false) : wallet ? setOpen(true) : void startConnect())}
      >
        {children}
        {wallet && <span className="wallet-chip-address">{shortAddress(wallet.address)}</span>}
        {wallet && <span className="wallet-chip-dot" aria-hidden="true" />}
      </button>

      {notice && !open && (
        <p className="wallet-chip-notice" role="status">
          {notice}
        </p>
      )}

      {open && (
        <div className="wallet-menu" role="dialog" aria-label={wallet ? label : m.wallet.choose}>
          {wallet ? (
            <>
              <p className="wallet-menu-name">
                {wallet.name}
                {DEVNET && <span className="wallet-menu-tag">{m.wallet.devnet}</span>}
              </p>
              <p className="wallet-menu-address">
                <code>{wallet.address}</code>
              </p>
              <p className="wallet-menu-balance">
                <span>{m.wallet.balance}</span>{" "}
                {funds.status === "ok" ? (
                  <strong>
                    {usdc(funds.usdc.toString(), lang)} · {(funds.lamports / 1e9).toLocaleString(lang, { maximumFractionDigits: 4 })} SOL
                  </strong>
                ) : funds.status === "error" ? (
                  <span className="hint">{m.wallet.balanceUnavailable}</span>
                ) : (
                  <span className="hint">{m.wallet.checking}</span>
                )}
              </p>
              <div className="wallet-menu-actions">
                <button type="button" onClick={copy}>
                  {copied ? m.wallet.copied : m.wallet.copy}
                </button>
                <a href={explorer} target="_blank" rel="noopener noreferrer">
                  {m.wallet.explorer}
                </a>
                <button type="button" onClick={switchWallet}>
                  {m.wallet.switchWallet}
                </button>
                <button type="button" onClick={() => void disconnect().then(() => setOpen(false))}>
                  {m.wallet.disconnect}
                </button>
              </div>
            </>
          ) : busy ? (
            <p className="hint">{m.wallet.connecting}</p>
          ) : picking ? (
            <WalletPicker options={picking} onPick={use} onCancel={() => setOpen(false)} />
          ) : null}
          {error && <p className="notice withheld">{error}</p>}
        </div>
      )}
    </div>
  );
}
