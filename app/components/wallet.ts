"use client";

/**
 * app/components/wallet.ts — any Solana wallet, through the Wallet Standard.
 *
 * Phantom, Solflare, Backpack and the other Solana wallets announce themselves
 * to the page through the Wallet Standard (two window events, no global
 * object), so one small registry finds all of them without the wallet-adapter
 * packages. The page needs three things from a wallet: connect, sign-and-send
 * a transaction, and sign a plain-text message.
 *
 * Every transaction arrives already built by the server (see lib/checkout), so
 * the page never assembles an instruction — the wallet shows the user exactly
 * what the server built, and they approve or refuse it.
 *
 * We ask for the right chain (solana:devnet here), but some wallets send to
 * whichever network THEY are set to. On devnet the user should switch their
 * wallet to Devnet too, or the transaction goes to mainnet, where the program
 * does not exist.
 *
 * Nothing in this file is in any one language: failures are WalletErrors with
 * a code, and the page puts them in words (WalletProvider.tsx).
 */

/** The parts of a Wallet Standard wallet this page uses. */
export interface StandardWalletAccount {
  readonly address: string;
  readonly chains: readonly string[];
}

export interface StandardWallet {
  readonly name: string;
  readonly icon: string;
  readonly chains: readonly string[];
  readonly features: Readonly<Record<string, unknown>>;
  readonly accounts: readonly StandardWalletAccount[];
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardWalletAccount[] }>;
}
interface SignAndSendFeature {
  signAndSendTransaction(
    ...inputs: { account: StandardWalletAccount; chain: string; transaction: Uint8Array }[]
  ): Promise<readonly { signature: Uint8Array }[]>;
}
interface SignMessageFeature {
  signMessage(...inputs: { account: StandardWalletAccount; message: Uint8Array }[]): Promise<readonly { signature: Uint8Array }[]>;
}
interface DisconnectFeature {
  disconnect(): Promise<void>;
}
interface EventsFeature {
  on(event: "change", listener: (props: { accounts?: readonly StandardWalletAccount[] }) => void): () => void;
}

/**
 * Why a wallet step failed, for the page to put in words:
 * - refused: the person said no in the wallet (or closed its window)
 * - no-account: the wallet connected but shared no account
 * - cant-send / cant-sign: the wallet doesn't offer that at all
 * - failed: anything else; `message` has the wallet's own words
 */
export type WalletErrorCode = "refused" | "no-account" | "cant-send" | "cant-sign" | "failed";

export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    readonly wallet: string,
    message: string = code,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/**
 * Sort a wallet's failure into a code. Wallets say "no" in their own ways:
 * EIP-1193's 4001 (Phantom, Solflare), or only in the words of the message.
 */
export function classifyWalletError(err: unknown, wallet: string): WalletError {
  if (err instanceof WalletError) return err;
  const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
  const message = walletErrorMessage(err);
  if (code === 4001 || /reject|declin|denied|cancel/i.test(message)) {
    return new WalletError("refused", wallet, message);
  }
  return new WalletError("failed", wallet, message);
}

/** A wallet the user has connected, reduced to what the forms need. */
export interface ConnectedWallet {
  name: string;
  /** The account's address, base58. */
  address: string;
  /** Sign the server-built transaction (base64) and send it. */
  signAndSend(transactionBase64: string): Promise<void>;
  /**
   * Sign a plain-text message — NOT a transaction. Used to prove "I am the
   * wallet that paid for this order" without moving anything. Wallets show the
   * text before signing, which is why every message spells out what it is for.
   * Returns the signature, base64.
   */
  signMessage(text: string): Promise<string>;
  /** Ask the wallet to forget this site's connection. Never throws. */
  disconnect(): Promise<void>;
  /**
   * Called when the person switches account inside the wallet (with the
   * wallet for the new account) or disconnects there (with null), so nothing
   * is signed by an account the page isn't showing. Returns the unsubscribe.
   */
  watch(listener: (next: ConnectedWallet | null) => void): () => void;
}

// The escrow is on devnet unless the site points at mainnet.
export const DEVNET = !(process.env.NEXT_PUBLIC_RPC_URL ?? "").includes("mainnet");
export const SOLANA_CHAIN = DEVNET ? "solana:devnet" : "solana:mainnet";

/** Where to get a wallet, for someone who has none: the wallets' own download pages. */
export const WALLET_INSTALL_LINKS = [
  { name: "Phantom", href: "https://phantom.com/download" },
  { name: "Solflare", href: "https://solflare.com/download" },
  { name: "Backpack", href: "https://backpack.app/downloads" },
] as const;

/** A phone or tablet, where wallets are apps rather than browser extensions. */
export function isMobileDevice(userAgent: string, maxTouchPoints = 0): boolean {
  // iPadOS says it is a Mac; the touch screen gives it away.
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/**
 * Links that open this page inside a wallet app's own browser, where the
 * wallet is on the page just as an extension would be. On a phone that is the
 * one way from a website to a wallet that works on both Android and iOS.
 * https://docs.phantom.com/phantom-deeplinks/other-methods/browse
 * https://docs.solflare.com/solflare/technical/deeplinks/other-methods/browse
 */
export function walletAppLinks(pageUrl: string): { name: string; href: string }[] {
  const ref = encodeURIComponent(new URL(pageUrl).origin);
  const url = encodeURIComponent(pageUrl);
  return [
    { name: "Phantom", href: `https://phantom.app/ul/browse/${url}?ref=${ref}` },
    { name: "Solflare", href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
  ];
}

/** A wallet we can use: it connects, and it speaks Solana. */
export function isSolanaWallet(w: StandardWallet): boolean {
  return "standard:connect" in w.features && w.chains.some((c) => c.startsWith("solana:"));
}

export interface WalletRegistry {
  get(): StandardWallet[];
  /** Called whenever a wallet registers. Returns the unsubscribe. */
  on(listener: () => void): () => void;
  /** What wallets call to register; also handed to the older navigator.wallets form. */
  register(...wallets: StandardWallet[]): () => void;
}

/**
 * The app side of the Wallet Standard handshake, on any event target:
 * listen for wallets registering, then say the app is ready, so wallets that
 * loaded first register too. Wallets may register more than once (once per
 * event); each is kept once.
 */
export function createWalletRegistry(target: EventTarget): WalletRegistry {
  const wallets: StandardWallet[] = [];
  const listeners = new Set<() => void>();
  const api = {
    register(...added: StandardWallet[]) {
      const fresh = added.filter((w) => !wallets.includes(w));
      wallets.push(...fresh);
      if (fresh.length) listeners.forEach((l) => l());
      return () => {
        for (const w of fresh) if (wallets.includes(w)) wallets.splice(wallets.indexOf(w), 1);
        listeners.forEach((l) => l());
      };
    },
  };
  target.addEventListener("wallet-standard:register-wallet", (event) => {
    try {
      (event as CustomEvent<(a: typeof api) => void>).detail(api);
    } catch {
      /* a broken wallet must not break the page */
    }
  });
  target.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  return {
    get: () => wallets.filter(isSolanaWallet),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register: api.register,
  };
}

type RegisterCallback = (api: { register: WalletRegistry["register"] }) => void;

/**
 * The first version of the Wallet Standard: wallets pushed a callback onto a
 * `navigator.wallets` array instead of sending an event. Some wallet versions
 * still do, so take what is queued there and catch anything pushed later.
 */
export function adoptNavigatorWallets(nav: { wallets?: unknown }, registry: WalletRegistry): void {
  const run = (cb: unknown) => {
    try {
      if (typeof cb === "function") (cb as RegisterCallback)({ register: registry.register });
    } catch {
      /* a broken wallet must not break the page */
    }
  };
  const queued = Array.isArray(nav.wallets) ? [...nav.wallets] : [];
  try {
    Object.defineProperty(nav, "wallets", { value: Object.freeze({ push: (...cbs: unknown[]) => cbs.forEach(run) }), configurable: true });
  } catch {
    /* already taken by another app on the page: the event handshake still works */
  }
  queued.forEach(run);
}

let registry: WalletRegistry | null = null;

/** The page's one registry, started on first use (in the browser only). */
export function walletRegistry(): WalletRegistry | null {
  if (typeof window === "undefined") return null;
  if (!registry) {
    registry = createWalletRegistry(window);
    adoptNavigatorWallets(window.navigator as { wallets?: unknown }, registry);
  }
  return registry;
}

/**
 * The older way wallets show themselves: an object on `window`. Used only for
 * a wallet the Wallet Standard didn't announce (a browser where the extension
 * didn't register, or an older extension), so nobody with a wallet is told
 * they have none.
 */
interface InjectedProvider {
  publicKey?: { toBase58(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: { toBase58(): string } } | void>;
  disconnect?(): Promise<void>;
  signAndSendTransaction?(tx: unknown): Promise<{ signature: string }>;
  signMessage?(message: Uint8Array, display?: "utf8"): Promise<{ signature: Uint8Array } | Uint8Array>;
  on?(event: string, listener: (arg?: unknown) => void): void;
  off?(event: string, listener: (arg?: unknown) => void): void;
  removeListener?(event: string, listener: (arg?: unknown) => void): void;
}

type AnyWindow = Record<string, unknown> & {
  phantom?: { solana?: InjectedProvider & { isPhantom?: boolean } };
  solflare?: InjectedProvider & { isSolflare?: boolean };
  backpack?: (InjectedProvider & { isBackpack?: boolean }) & { solana?: InjectedProvider };
  solana?: InjectedProvider & { isPhantom?: boolean };
};

export function injectedWallets(win?: unknown): { name: string; provider: InjectedProvider }[] {
  const w = (win ?? (typeof window === "undefined" ? undefined : window)) as AnyWindow | undefined;
  if (!w) return [];
  const found: { name: string; provider: InjectedProvider }[] = [];
  const phantom = w.phantom?.solana?.isPhantom ? w.phantom.solana : w.solana?.isPhantom ? w.solana : undefined;
  if (phantom) found.push({ name: "Phantom", provider: phantom });
  if (w.solflare?.isSolflare) found.push({ name: "Solflare", provider: w.solflare });
  const backpack = w.backpack?.solana ?? (w.backpack?.isBackpack ? w.backpack : undefined);
  if (backpack) found.push({ name: "Backpack", provider: backpack });
  return found;
}

/** Connect an injected wallet, wrapped exactly like a Wallet Standard one. */
export async function connectInjected(name: string, provider: InjectedProvider): Promise<ConnectedWallet> {
  let res: Awaited<ReturnType<InjectedProvider["connect"]>>;
  try {
    res = await provider.connect();
  } catch (err) {
    throw classifyWalletError(err, name);
  }
  const key = (res && typeof res === "object" && res.publicKey) || provider.publicKey;
  if (!key) throw new WalletError("no-account", name);
  return wrapInjected(name, provider, key.toBase58());
}

/** Reconnect an injected wallet with no prompt, if it already trusts this site; null if not. */
export async function reconnectInjected(name: string, provider: InjectedProvider): Promise<ConnectedWallet | null> {
  try {
    const res = await provider.connect({ onlyIfTrusted: true });
    const key = (res && typeof res === "object" && res.publicKey) || provider.publicKey;
    return key ? wrapInjected(name, provider, key.toBase58()) : null;
  } catch {
    return null;
  }
}

function wrapInjected(name: string, provider: InjectedProvider, address: string): ConnectedWallet {
  return {
    name,
    address,
    async signAndSend(transactionBase64) {
      if (!provider.signAndSendTransaction) throw new WalletError("cant-send", name);
      // These providers take a Transaction object rather than bytes.
      const { Transaction } = await import("@solana/web3.js");
      try {
        await provider.signAndSendTransaction(Transaction.from(base64ToBytes(transactionBase64)));
      } catch (err) {
        throw classifyWalletError(err, name);
      }
    },
    async signMessage(text) {
      if (!provider.signMessage) throw new WalletError("cant-sign", name);
      try {
        const r = await provider.signMessage(new TextEncoder().encode(text), "utf8");
        return bytesToBase64(r instanceof Uint8Array ? r : r.signature);
      } catch (err) {
        throw classifyWalletError(err, name);
      }
    },
    async disconnect() {
      await provider.disconnect?.().catch(() => undefined);
    },
    watch(listener) {
      if (!provider.on) return () => {};
      // Phantom passes the new key, or null for an account this site may not see yet.
      const onAccount = (key?: unknown) => {
        const next = key && typeof key === "object" && "toBase58" in key ? (key as { toBase58(): string }).toBase58() : null;
        if (next === address) return;
        listener(next ? wrapInjected(name, provider, next) : null);
      };
      const onDisconnect = () => listener(null);
      provider.on("accountChanged", onAccount);
      provider.on("disconnect", onDisconnect);
      return () => {
        const off = (provider.off ?? provider.removeListener)?.bind(provider);
        off?.("accountChanged", onAccount);
        off?.("disconnect", onDisconnect);
      };
    },
  };
}

/** A wallet the page can offer, however it was found. */
export interface WalletOption {
  name: string;
  icon?: string;
  /** Asks the person. Throws a WalletError when it can't connect. */
  connect(): Promise<ConnectedWallet>;
  /** Reconnects with no prompt if the wallet already trusts this site; null if not. */
  reconnect(): Promise<ConnectedWallet | null>;
}

/** Every wallet on offer: the Wallet Standard ones, then any injected wallet they didn't already cover. */
export function walletOptions(reg: WalletRegistry | null = walletRegistry(), win?: unknown): WalletOption[] {
  const options: WalletOption[] = (reg?.get() ?? []).map((w) => ({
    name: w.name,
    icon: w.icon,
    connect: () => connectWallet(w),
    reconnect: () => reconnectWallet(w),
  }));
  for (const inj of injectedWallets(win)) {
    if (!options.some((o) => o.name.toLowerCase().includes(inj.name.toLowerCase()))) {
      options.push({
        name: inj.name,
        connect: () => connectInjected(inj.name, inj.provider),
        reconnect: () => reconnectInjected(inj.name, inj.provider),
      });
    }
  }
  return options;
}

/** The account to use: the one on our chain, if the wallet shares several. */
function pickAccount(accounts: readonly StandardWalletAccount[], chain: string): StandardWalletAccount | undefined {
  return accounts.find((a) => a.chains.includes(chain)) ?? accounts[0];
}

/** Ask the wallet to connect, and wrap the account it gives us. */
export async function connectWallet(wallet: StandardWallet, chain = SOLANA_CHAIN): Promise<ConnectedWallet> {
  let accounts: readonly StandardWalletAccount[];
  try {
    ({ accounts } = await (wallet.features["standard:connect"] as ConnectFeature).connect());
  } catch (err) {
    throw classifyWalletError(err, wallet.name);
  }
  const account = pickAccount(accounts, chain) ?? wallet.accounts[0];
  if (!account) throw new WalletError("no-account", wallet.name);
  return wrapStandard(wallet, account, chain);
}

/**
 * Reconnect with no prompt, if the wallet already trusts this site; null if
 * not. The Wallet Standard's `silent` connect gives no accounts then.
 */
export async function reconnectWallet(wallet: StandardWallet, chain = SOLANA_CHAIN): Promise<ConnectedWallet | null> {
  try {
    const { accounts } = await (wallet.features["standard:connect"] as ConnectFeature).connect({ silent: true });
    const account = pickAccount(accounts, chain);
    return account ? wrapStandard(wallet, account, chain) : null;
  } catch {
    return null;
  }
}

function wrapStandard(wallet: StandardWallet, account: StandardWalletAccount, chain: string): ConnectedWallet {
  const sendFeature = wallet.features["solana:signAndSendTransaction"] as SignAndSendFeature | undefined;
  const messageFeature = wallet.features["solana:signMessage"] as SignMessageFeature | undefined;
  return {
    name: wallet.name,
    address: account.address,
    async signAndSend(transactionBase64) {
      if (!sendFeature) throw new WalletError("cant-send", wallet.name);
      try {
        await sendFeature.signAndSendTransaction({ account, chain, transaction: base64ToBytes(transactionBase64) });
      } catch (err) {
        throw classifyWalletError(err, wallet.name);
      }
    },
    async signMessage(text) {
      if (!messageFeature) throw new WalletError("cant-sign", wallet.name);
      try {
        const [result] = await messageFeature.signMessage({ account, message: new TextEncoder().encode(text) });
        return bytesToBase64(result.signature);
      } catch (err) {
        throw classifyWalletError(err, wallet.name);
      }
    },
    async disconnect() {
      const feature = wallet.features["standard:disconnect"] as DisconnectFeature | undefined;
      await feature?.disconnect().catch(() => undefined);
    },
    watch(listener) {
      const events = wallet.features["standard:events"] as EventsFeature | undefined;
      if (!events) return () => {};
      return events.on("change", ({ accounts }) => {
        if (!accounts) return; // a change of chains or features, not of account
        const next = pickAccount(accounts, chain);
        if (!next) listener(null);
        else if (next.address !== account.address) listener(wrapStandard(wallet, next, chain));
      });
    },
  };
}

/** Signature bytes -> base64 for the server, without Buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Base64 from the server -> the transaction bytes the wallet signs. No Buffer needed. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Wait until the server can see the order in the given state, or give up. */
export async function waitForOrder(
  order: string,
  want: (s: { found?: boolean; status?: string }) => boolean,
  timeoutMs = 60_000,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`/api/orders/${order}`, { cache: "no-store" });
      if (want(await res.json())) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Wallet errors are objects with a message, not always Errors. The wallet's own words, untranslated. */
export function walletErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}
