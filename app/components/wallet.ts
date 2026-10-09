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
}

// The escrow is on devnet unless the site points at mainnet.
export const DEVNET = !(process.env.NEXT_PUBLIC_RPC_URL ?? "").includes("mainnet");
export const SOLANA_CHAIN = DEVNET ? "solana:devnet" : "solana:mainnet";

export const NO_WALLET_MESSAGE =
  (DEVNET
    ? "No Solana wallet found. Install one (Phantom, Solflare or Backpack), set it to Devnet, and reload."
    : "No Solana wallet found. Install one (Phantom, Solflare or Backpack) and reload.") +
  " Already installed? Unlock it, make sure it's allowed on this site, and reload.";

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
  connect(): Promise<{ publicKey?: { toBase58(): string } } | void>;
  signAndSendTransaction?(tx: unknown): Promise<{ signature: string }>;
  signMessage?(message: Uint8Array, display?: "utf8"): Promise<{ signature: Uint8Array } | Uint8Array>;
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
  const res = await provider.connect();
  const key = (res && typeof res === "object" && res.publicKey) || provider.publicKey;
  if (!key) throw new Error(`${name} didn't share an account.`);
  return {
    name,
    address: key.toBase58(),
    async signAndSend(transactionBase64) {
      if (!provider.signAndSendTransaction) throw new Error(`${name} can't send transactions. Try Phantom, Solflare or Backpack.`);
      // These providers take a Transaction object rather than bytes.
      const { Transaction } = await import("@solana/web3.js");
      await provider.signAndSendTransaction(Transaction.from(base64ToBytes(transactionBase64)));
    },
    async signMessage(text) {
      if (!provider.signMessage) throw new Error(`${name} can't sign messages. Try Phantom, Solflare or Backpack.`);
      const r = await provider.signMessage(new TextEncoder().encode(text), "utf8");
      return bytesToBase64(r instanceof Uint8Array ? r : r.signature);
    },
  };
}

/** A wallet the page can offer, however it was found. */
export interface WalletOption {
  name: string;
  icon?: string;
  connect(): Promise<ConnectedWallet>;
}

/** Every wallet on offer: the Wallet Standard ones, then any injected wallet they didn't already cover. */
export function walletOptions(reg: WalletRegistry | null = walletRegistry(), win?: unknown): WalletOption[] {
  const options: WalletOption[] = (reg?.get() ?? []).map((w) => ({ name: w.name, icon: w.icon, connect: () => connectWallet(w) }));
  for (const inj of injectedWallets(win)) {
    if (!options.some((o) => o.name.toLowerCase().includes(inj.name.toLowerCase()))) {
      options.push({ name: inj.name, connect: () => connectInjected(inj.name, inj.provider) });
    }
  }
  return options;
}

/** Ask the wallet to connect, and wrap the account it gives us. */
export async function connectWallet(wallet: StandardWallet, chain = SOLANA_CHAIN): Promise<ConnectedWallet> {
  const { accounts } = await (wallet.features["standard:connect"] as ConnectFeature).connect();
  const account = accounts.find((a) => a.chains.includes(chain)) ?? accounts[0] ?? wallet.accounts[0];
  if (!account) throw new Error(`${wallet.name} didn't share an account.`);

  const sendFeature = wallet.features["solana:signAndSendTransaction"] as SignAndSendFeature | undefined;
  const messageFeature = wallet.features["solana:signMessage"] as SignMessageFeature | undefined;
  return {
    name: wallet.name,
    address: account.address,
    async signAndSend(transactionBase64) {
      if (!sendFeature) throw new Error(`${wallet.name} can't send transactions. Try Phantom, Solflare or Backpack.`);
      await sendFeature.signAndSendTransaction({ account, chain, transaction: base64ToBytes(transactionBase64) });
    },
    async signMessage(text) {
      if (!messageFeature) throw new Error(`${wallet.name} can't sign messages. Try Phantom, Solflare or Backpack.`);
      const [result] = await messageFeature.signMessage({ account, message: new TextEncoder().encode(text) });
      return bytesToBase64(result.signature);
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

/** Wallet errors are objects with a message, not always Errors. */
export function walletErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}
