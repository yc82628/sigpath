"use client";

/**
 * The connected wallet, for the whole site: connect once (in the header or at
 * any wallet step) and every page uses the same wallet until the person
 * disconnects, switches account inside the wallet, or the wallet drops the
 * site.
 *
 * WHAT IS REMEMBERED
 * Only the wallet's NAME, in this browser's localStorage, so a reload can ask
 * that wallet to reconnect without a prompt. It does so only if the wallet
 * itself still trusts the site; otherwise the person connects again as usual.
 * No address is stored: the wallet is the one place that knows it.
 *
 * PHONES
 * A phone's browser has no wallet extensions, so on a phone with no wallet on
 * the page the picker offers to open SigPath inside a wallet app's own
 * browser (wallet.ts, walletAppLinks), where the wallet is right there. That
 * works the same on Android and iPhone.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useMessages } from "./I18n";
import {
  DEVNET,
  WALLET_INSTALL_LINKS,
  WalletError,
  isMobileDevice,
  walletAppLinks,
  walletErrorMessage,
  walletOptions,
  walletRegistry,
  type ConnectedWallet,
  type WalletOption,
} from "./wallet";

const REMEMBER_KEY = "sigpath:wallet";

interface WalletState {
  wallet: ConnectedWallet | null;
  options: WalletOption[];
  /** Asks the wallet; throws a WalletError if it can't connect. */
  connect(option: WalletOption): Promise<ConnectedWallet>;
  disconnect(): Promise<void>;
  /** The wallets on offer now, read again (after a short wait if none have shown up yet). */
  findOptions(): Promise<WalletOption[]>;
  /** A one-off line for the header when the wallet changes by itself (switched or dropped). */
  notice: string;
}

const WalletContext = createContext<WalletState | null>(null);

function remember(name: string | null) {
  try {
    if (name) localStorage.setItem(REMEMBER_KEY, name);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* private mode or storage blocked: the person just connects again next time */
  }
}

function recall(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}

/** "AbCd…WxYz" */
export const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const m = useMessages();
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [options, setOptions] = useState<WalletOption[]>([]);
  const [notice, setNotice] = useState("");
  // The words for a change are read when it happens, in the language shown then.
  const words = useRef(m.wallet);
  words.current = m.wallet;

  useEffect(() => {
    const registry = walletRegistry();
    if (!registry) return;
    const remembered = recall();
    let tried = false;
    const refresh = () => {
      const found = walletOptions(registry);
      setOptions(found);
      const match = !tried && remembered ? found.find((o) => o.name === remembered) : undefined;
      if (!match) return;
      tried = true;
      match
        .reconnect()
        .then((w) => {
          if (w) setWallet((current) => current ?? w);
          else remember(null); // the wallet no longer trusts the site: don't keep asking
        })
        .catch(() => undefined);
    };
    refresh();
    const off = registry.on(refresh);
    // Wallets found only through `window` (wallet.ts, injectedWallets) never fire
    // the registry: look again once they have had time to load.
    const later = setTimeout(refresh, 1000);
    return () => {
      off();
      clearTimeout(later);
    };
  }, []);

  useEffect(() => {
    if (!wallet) return;
    return wallet.watch((next) => {
      setWallet(next);
      setNotice(next ? words.current.switched(shortAddress(next.address)) : words.current.disconnected);
      if (!next) remember(null);
    });
  }, [wallet]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  const connect = useCallback(async (option: WalletOption) => {
    const w = await option.connect();
    setWallet(w);
    setNotice("");
    remember(option.name);
    return w;
  }, []);

  const disconnect = useCallback(async () => {
    const w = wallet;
    setWallet(null);
    remember(null);
    await w?.disconnect();
  }, [wallet]);

  const findOptions = useCallback(async () => {
    let found = walletOptions();
    if (!found.length) {
      // An extension can finish loading after the page.
      await new Promise((r) => setTimeout(r, 800));
      found = walletOptions();
    }
    setOptions(found);
    return found;
  }, []);

  return (
    <WalletContext.Provider value={{ wallet, options, connect, disconnect, findOptions, notice }}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const state = useContext(WalletContext);
  if (!state) throw new Error("useWallet needs the WalletProvider (app/layout.tsx).");
  return state;
}

/** Any failure from a wallet step, in the page's language. Server errors keep their own words. */
export function useWalletErrorText() {
  const m = useMessages();
  return useCallback(
    (err: unknown): string => {
      if (!(err instanceof WalletError)) return walletErrorMessage(err);
      const name = err.wallet;
      switch (err.code) {
        case "refused":
          return m.wallet.refused(name);
        case "no-account":
          return m.wallet.noAccount(name);
        case "cant-send":
          return m.wallet.cantSend(name);
        case "cant-sign":
          return m.wallet.cantSign(name);
        default:
          return m.wallet.failed(name, err.message);
      }
    },
    [m],
  );
}

/**
 * Runs `onChange` when the site's wallet stops being the one a form started
 * with (switched account, disconnected, or another wallet connected), so a
 * multi-step form never finishes a step for an account the page isn't showing.
 */
export function useWalletChange(boundAddress: string | null | undefined, onChange: () => void) {
  const { wallet } = useWallet();
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (boundAddress && wallet?.address !== boundAddress) callback.current();
  }, [wallet, boundAddress]);
}

export type Funds =
  | { status: "idle" | "loading" | "error" }
  | { status: "ok"; usdc: bigint; lamports: number; minSolLamports: number };

/** What `address` holds (USDC and SOL), from /api/wallet/balance. `refresh` reads it again. */
export function useWalletFunds(address: string | null | undefined): Funds & { refresh(): void } {
  const [funds, setFunds] = useState<Funds>({ status: "idle" });
  const latest = useRef(0);
  const refresh = useCallback(() => {
    if (!address) return setFunds({ status: "idle" });
    const id = ++latest.current;
    setFunds({ status: "loading" });
    fetch(`/api/wallet/balance?wallet=${encodeURIComponent(address)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        // A slower answer for an account the page has since left is dropped.
        if (id === latest.current) {
          setFunds({ status: "ok", usdc: BigInt(body.usdc), lamports: body.lamports, minSolLamports: body.minSolLamports });
        }
      })
      .catch(() => {
        if (id === latest.current) setFunds({ status: "error" });
      });
  }, [address]);
  useEffect(refresh, [refresh]);
  return { ...funds, refresh };
}

/** The wallets to pick from, or, with none, how to get one (and on a phone, how to open SigPath in a wallet app). */
export function WalletPicker({
  options,
  onPick,
  onCancel,
}: {
  options: WalletOption[];
  onPick: (option: WalletOption) => void;
  onCancel?: () => void;
}) {
  const m = useMessages();
  if (options.length === 0) return <NoWallet />;
  return (
    <div className="wallet-choice" role="group" aria-label={m.wallet.choose}>
      {options.map((w) => (
        <button key={w.name} type="button" onClick={() => onPick(w)}>
          {/* Wallets give their icon as a data: URI, so a plain img is right. */}
          {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
          {w.name}
        </button>
      ))}
      {onCancel && (
        <button type="button" className="link" onClick={onCancel}>
          {m.wallet.cancel}
        </button>
      )}
    </div>
  );
}

function OpenInWalletApp() {
  const m = useMessages();
  return (
    <>
      <p className="hint">{m.wallet.phone}</p>
      <div className="wallet-choice">
        {walletAppLinks(window.location.href).map((l) => (
          <a key={l.name} className="button" href={l.href}>
            {m.wallet.openIn(l.name)}
          </a>
        ))}
      </div>
    </>
  );
}

function NoWallet() {
  const m = useMessages();
  const mobile = isMobileDevice(navigator.userAgent, navigator.maxTouchPoints);
  return (
    <div className="wallet-help" role="status">
      <p>
        <strong>{m.wallet.noWallet}</strong>
      </p>
      {mobile && <OpenInWalletApp />}
      <p className="hint">
        {m.wallet.getOne}{" "}
        {WALLET_INSTALL_LINKS.map((l, i) => (
          <span key={l.name}>
            {i > 0 && " · "}
            <a href={l.href} target="_blank" rel="noopener noreferrer">
              {l.name}
            </a>
          </span>
        ))}
      </p>
      {DEVNET && <p className="hint">{m.wallet.devnetNote}</p>}
      <p className="hint">
        {m.wallet.alreadyHave}{" "}
        <button type="button" className="link" onClick={() => window.location.reload()}>
          {m.wallet.reload}
        </button>
      </p>
    </div>
  );
}
