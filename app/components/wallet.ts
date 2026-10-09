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

export const NO_WALLET_MESSAGE = DEVNET
  ? "No Solana wallet found. Install one (Phantom, Solflare or Backpack), set it to Devnet, and reload."
  : "No Solana wallet found. Install one (Phantom, Solflare or Backpack) and reload.";

/** A wallet we can use: it connects, and it speaks Solana. */
export function isSolanaWallet(w: StandardWallet): boolean {
  return "standard:connect" in w.features && w.chains.some((c) => c.startsWith("solana:"));
}

export interface WalletRegistry {
  get(): StandardWallet[];
  /** Called whenever a wallet registers. Returns the unsubscribe. */
  on(listener: () => void): () => void;
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
  };
}

let registry: WalletRegistry | null = null;

/** The page's one registry, started on first use (in the browser only). */
export function walletRegistry(): WalletRegistry | null {
  if (typeof window === "undefined") return null;
  registry ??= createWalletRegistry(window);
  return registry;
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
