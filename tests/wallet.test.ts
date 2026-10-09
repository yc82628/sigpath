import { test } from "node:test";
import assert from "node:assert";
import nacl from "tweetnacl";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  base64ToBytes,
  bytesToBase64,
  connectWallet,
  createWalletRegistry,
  type StandardWallet,
  type StandardWalletAccount,
} from "../app/components/wallet";

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
  await assert.rejects(connected.signAndSend("AA=="), /SignOnly can't send transactions/);
});

test("base64 helpers round-trip without Buffer", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});
