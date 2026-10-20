import { test } from "node:test";
import assert from "node:assert";
import nacl from "tweetnacl";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  adoptNavigatorWallets,
  base64ToBytes,
  bytesToBase64,
  classifyWalletError,
  connectInjected,
  connectWallet,
  createWalletRegistry,
  injectedWallets,
  isMobileDevice,
  reconnectInjected,
  reconnectWallet,
  walletAppLinks,
  WalletError,
  walletOptions,
  type ConnectedWallet,
  type StandardWallet,
  type StandardWalletAccount,
} from "../app/components/wallet";

/** Rejects with a WalletError of this code (the page words it; see WalletProvider.tsx). */
const isCode = (code: string) => (err: unknown) => err instanceof WalletError && err.code === code;

/** A Wallet Standard wallet, as an extension would inject it, backed by a real keypair. */
function fakeWallet(name: string, chains: string[] = ["solana:devnet", "solana:mainnet"]) {
  const keys = Keypair.generate();
  const account: StandardWalletAccount = { address: keys.publicKey.toBase58(), chains };
  const sent: { chain: string; transaction: Uint8Array }[] = [];
  const wallet: StandardWallet = {
    name,
    icon: "data:image/svg+xml;base64,AA==",
    chains,
    accounts: [],
    features: {
      "standard:connect": { connect: async () => ({ accounts: [account] }) },
      "solana:signAndSendTransaction": {
        signAndSendTransaction: async (...inputs: { account: StandardWalletAccount; chain: string; transaction: Uint8Array }[]) =>
          inputs.map((i) => {
            sent.push({ chain: i.chain, transaction: i.transaction });
            return { signature: new Uint8Array(64) };
          }),
      },
      "solana:signMessage": {
        signMessage: async (...inputs: { message: Uint8Array }[]) =>
          inputs.map((i) => ({ signedMessage: i.message, signature: nacl.sign.detached(i.message, keys.secretKey) })),
      },
    },
  };
  return { wallet, keys, sent };
}

/** What an extension does: register on app-ready, and announce itself in case the app is already listening. */
function inject(target: EventTarget, wallet: StandardWallet) {
  const callback = (api: { register(w: StandardWallet): unknown }) => api.register(wallet);
  target.addEventListener("wallet-standard:app-ready", (e) => callback((e as CustomEvent).detail));
  target.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
}

test("finds Solana wallets whether they load before or after the page, each once", () => {
  const target = new EventTarget();
  const early = fakeWallet("Early");
  inject(target, early.wallet); // nobody listening yet: waits for app-ready

  const registry = createWalletRegistry(target);
  assert.deepEqual(registry.get().map((w) => w.name), ["Early"]);

  let changes = 0;
  registry.on(() => changes++);
  const late = fakeWallet("Late");
  inject(target, late.wallet);
  assert.deepEqual(registry.get().map((w) => w.name), ["Early", "Late"]);
  assert.equal(changes, 1);

  // Registering the same wallet again changes nothing.
  target.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: { register(w: StandardWallet): unknown }) => api.register(late.wallet) }));
  assert.equal(registry.get().length, 2);
  assert.equal(changes, 1);
});

test("ignores wallets that don't speak Solana, and survives a broken one", () => {
  const target = new EventTarget();
  const registry = createWalletRegistry(target);
  inject(target, fakeWallet("EthOnly", ["eip155:1"]).wallet);
  target.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: () => { throw new Error("boom"); } }));
  inject(target, fakeWallet("Good").wallet);
  assert.deepEqual(registry.get().map((w) => w.name), ["Good"]);
});

test("a connected wallet sends the server's transaction bytes unchanged, on the chain we ask for", async () => {
  const { wallet, keys, sent } = fakeWallet("Solflare");
  const connected = await connectWallet(wallet, "solana:devnet");
  assert.equal(connected.address, keys.publicKey.toBase58());
  assert.equal(connected.name, "Solflare");

  const tx = new Transaction({ feePayer: keys.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(
    SystemProgram.transfer({ fromPubkey: keys.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
  );
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  await connected.signAndSend(b64);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chain, "solana:devnet");
  assert.equal(Buffer.from(sent[0].transaction).toString("base64"), b64);
});

test("a message signature comes back as base64 the server can verify against the address", async () => {
  const { wallet, keys } = fakeWallet("Backpack");
  const connected = await connectWallet(wallet);
  const text = "SigPath business verification\nAction: test";
  const signature = await connected.signMessage(text);
  assert.ok(nacl.sign.detached.verify(new TextEncoder().encode(text), base64ToBytes(signature), keys.publicKey.toBytes()));
});

test("a wallet that can't send transactions says so instead of failing silently", async () => {
  const { wallet } = fakeWallet("SignOnly");
  const features = { ...wallet.features };
  delete (features as Record<string, unknown>)["solana:signAndSendTransaction"];
  const connected = await connectWallet({ ...wallet, features });
  await assert.rejects(connected.signAndSend("AA=="), (err) => isCode("cant-send")(err) && (err as WalletError).wallet === "SignOnly");
});

test("base64 helpers round-trip without Buffer", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

// --- wallets that don't use the event handshake -------------------------------

/** Phantom's older interface: an object on window.phantom.solana. */
function injectedPhantom() {
  const keys = Keypair.generate();
  const sent: unknown[] = [];
  const provider = {
    isPhantom: true,
    publicKey: null as null | PublicKey,
    async connect() {
      this.publicKey = keys.publicKey;
      return { publicKey: keys.publicKey };
    },
    async signAndSendTransaction(tx: unknown) {
      sent.push(tx);
      return { signature: "sig" };
    },
    async signMessage(message: Uint8Array) {
      return { signature: nacl.sign.detached(message, keys.secretKey) };
    },
  };
  return { provider, keys, sent };
}

test("a Phantom that only puts window.phantom.solana is still found and works", async () => {
  const { provider, keys, sent } = injectedPhantom();
  const win = { phantom: { solana: provider } };
  assert.deepEqual(injectedWallets(win).map((w) => w.name), ["Phantom"]);

  const options = walletOptions(createWalletRegistry(new EventTarget()), win);
  assert.deepEqual(options.map((o) => o.name), ["Phantom"]);
  const connected = await options[0].connect();
  assert.equal(connected.address, keys.publicKey.toBase58());

  const signature = await connected.signMessage("hello");
  assert.ok(nacl.sign.detached.verify(new TextEncoder().encode("hello"), base64ToBytes(signature), keys.publicKey.toBytes()));

  const tx = new Transaction({ feePayer: keys.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(
    SystemProgram.transfer({ fromPubkey: keys.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
  );
  await connected.signAndSend(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
  assert.ok(sent[0] instanceof Transaction, "the old interface gets a Transaction object");
});

test("a wallet found both ways is offered once, through the Wallet Standard", () => {
  const target = new EventTarget();
  const registry = createWalletRegistry(target);
  inject(target, fakeWallet("Phantom").wallet);
  const options = walletOptions(registry, { phantom: { solana: injectedPhantom().provider } });
  assert.deepEqual(options.map((o) => o.name), ["Phantom"]);
  assert.ok(options[0].icon, "the Wallet Standard entry, with its icon");
});

test("the older navigator.wallets form registers too, queued or pushed later", () => {
  const registry = createWalletRegistry(new EventTarget());
  const early = fakeWallet("Early");
  const nav: { wallets?: unknown } = { wallets: [({ register }: { register: (w: StandardWallet) => void }) => register(early.wallet)] };
  adoptNavigatorWallets(nav, registry);
  const late = fakeWallet("Late");
  (nav.wallets as { push(cb: unknown): void }).push(({ register }: { register: (w: StandardWallet) => void }) => register(late.wallet));
  assert.deepEqual(registry.get().map((w) => w.name), ["Early", "Late"]);
});

test("no wallet anywhere: nothing on offer", async () => {
  assert.deepEqual(walletOptions(createWalletRegistry(new EventTarget()), {}), []);
  await assert.rejects(connectInjected("X", { connect: async () => undefined }), isCode("no-account"));
});

// --- saying no, and what a refusal looks like ------------------------------------

test("a no in the wallet is told apart from other failures, whatever form the wallet gives it", () => {
  assert.equal(classifyWalletError({ code: 4001, message: "whatever" }, "Phantom").code, "refused");
  assert.equal(classifyWalletError(new Error("User rejected the request."), "Phantom").code, "refused");
  assert.equal(classifyWalletError({ message: "Approval Denied" }, "Solflare").code, "refused");
  const other = classifyWalletError(new Error("Blockhash not found"), "Backpack");
  assert.equal(other.code, "failed");
  assert.equal(other.message, "Blockhash not found", "the wallet's own words are kept for the page to show");
  assert.equal(other.wallet, "Backpack");
});

test("refusing to connect, sign or send rejects as 'refused', for both kinds of wallet", async () => {
  const no = async () => {
    throw Object.assign(new Error("User rejected the request."), { code: 4001 });
  };
  const { wallet } = fakeWallet("Solflare");
  await assert.rejects(connectWallet({ ...wallet, features: { ...wallet.features, "standard:connect": { connect: no } } }), isCode("refused"));
  const signing = await connectWallet({
    ...wallet,
    features: { ...wallet.features, "solana:signMessage": { signMessage: no }, "solana:signAndSendTransaction": { signAndSendTransaction: no } },
  });
  await assert.rejects(signing.signMessage("hi"), isCode("refused"));
  await assert.rejects(signing.signAndSend("AA=="), isCode("refused"));
  await assert.rejects(connectInjected("Phantom", { connect: no }), isCode("refused"));
});

// --- staying connected ---------------------------------------------------------

test("a reload reconnects only a wallet that already trusts the site, and never prompts", async () => {
  const { wallet, keys } = fakeWallet("Phantom");
  const asked: unknown[] = [];
  const trusting = (accounts: StandardWalletAccount[]): StandardWallet => ({
    ...wallet,
    features: {
      ...wallet.features,
      "standard:connect": { connect: async (input?: unknown) => (asked.push(input), { accounts }) },
    },
  });
  const back = await reconnectWallet(trusting([{ address: keys.publicKey.toBase58(), chains: ["solana:devnet"] }]));
  assert.equal(back?.address, keys.publicKey.toBase58());
  assert.equal(await reconnectWallet(trusting([])), null, "not trusted: no accounts, no wallet");
  assert.deepEqual(asked, [{ silent: true }, { silent: true }], "always the silent connect");
  const throwing: StandardWallet = { ...wallet, features: { ...wallet.features, "standard:connect": { connect: async () => { throw new Error("locked"); } } } };
  assert.equal(await reconnectWallet(throwing), null);

  const { provider } = injectedPhantom();
  const options: unknown[] = [];
  const injected = { ...provider, connect: async (o?: unknown) => (options.push(o), provider.connect()) };
  assert.equal((await reconnectInjected("Phantom", injected))?.address, provider.publicKey!.toBase58());
  assert.deepEqual(options, [{ onlyIfTrusted: true }]);
  assert.equal(await reconnectInjected("Phantom", { connect: async () => { throw new Error("not trusted"); } }), null);
});

test("disconnecting asks the wallet to forget the site, and never throws", async () => {
  const { wallet } = fakeWallet("Solflare");
  let forgot = 0;
  const w = await connectWallet({ ...wallet, features: { ...wallet.features, "standard:disconnect": { disconnect: async () => void forgot++ } } });
  await w.disconnect();
  assert.equal(forgot, 1);
  await (await connectWallet(wallet)).disconnect(); // no disconnect feature: nothing to do
  const failing = await connectWallet({ ...wallet, features: { ...wallet.features, "standard:disconnect": { disconnect: async () => { throw new Error("x"); } } } });
  await failing.disconnect();
});

test("switching account inside a Wallet Standard wallet hands the page the new account; disconnecting there, null", async () => {
  const { wallet, keys } = fakeWallet("Backpack");
  const listeners = new Set<(p: { accounts?: StandardWalletAccount[] }) => void>();
  const watched: StandardWallet = {
    ...wallet,
    features: {
      ...wallet.features,
      "standard:events": { on: (_: string, l: (p: { accounts?: StandardWalletAccount[] }) => void) => (listeners.add(l), () => listeners.delete(l)) },
    },
  };
  const w = await connectWallet(watched, "solana:devnet");
  const seen: (ConnectedWallet | null)[] = [];
  const off = w.watch((next) => seen.push(next));
  const emit = (p: { accounts?: StandardWalletAccount[] }) => listeners.forEach((l) => l(p));

  emit({}); // chains or features changed: not our business
  emit({ accounts: [{ address: keys.publicKey.toBase58(), chains: ["solana:devnet"] }] }); // same account
  assert.equal(seen.length, 0);

  const other = Keypair.generate().publicKey.toBase58();
  emit({ accounts: [{ address: other, chains: ["solana:devnet"] }] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.address, other);
  assert.equal(seen[0]?.name, "Backpack");

  emit({ accounts: [] });
  assert.equal(seen[1], null);

  off();
  assert.equal(listeners.size, 0, "the page stops listening when it lets go");
});

test("an injected wallet's account switch and disconnect reach the page too", async () => {
  const { provider } = injectedPhantom();
  const handlers = new Map<string, (arg?: unknown) => void>();
  const evented = {
    ...provider,
    connect: () => provider.connect(),
    on: (e: string, l: (arg?: unknown) => void) => void handlers.set(e, l),
    off: (e: string) => void handlers.delete(e),
  };
  const w = await connectInjected("Phantom", evented);
  const seen: (ConnectedWallet | null)[] = [];
  const off = w.watch((next) => seen.push(next));
  const other = Keypair.generate().publicKey;
  handlers.get("accountChanged")!(other);
  handlers.get("accountChanged")!(null); // an account this site may not see yet
  handlers.get("disconnect")!();
  assert.deepEqual(seen.map((s) => s?.address ?? null), [other.toBase58(), null, null]);
  off();
  assert.equal(handlers.size, 0);
});

// --- phones --------------------------------------------------------------------

test("phones are told apart from desktops, iPads that call themselves Macs included", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
  const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
  assert.equal(isMobileDevice(iphone), true);
  assert.equal(isMobileDevice(android), true);
  assert.equal(isMobileDevice(mac, 5), true, "an iPad in desktop mode");
  assert.equal(isMobileDevice(mac, 0), false);
  assert.equal(isMobileDevice(windows), false);
});

test("the wallet-app links reopen this exact page inside Phantom or Solflare", () => {
  const page = "https://sigpath.vercel.app/checkout?quote=a.b&x=1";
  const links = walletAppLinks(page);
  assert.deepEqual(links.map((l) => l.name), ["Phantom", "Solflare"]);
  for (const l of links) {
    const u = new URL(l.href);
    assert.equal(u.protocol, "https:");
    assert.equal(decodeURIComponent(u.pathname.split("/browse/")[1]), page, "the page, query and all, survives the round trip");
    assert.equal(u.searchParams.get("ref"), "https://sigpath.vercel.app");
  }
  assert.ok(links[0].href.startsWith("https://phantom.app/ul/browse/"));
  assert.ok(links[1].href.startsWith("https://solflare.com/ul/v1/browse/"));
});
