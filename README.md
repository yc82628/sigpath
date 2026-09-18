# SigPath

Attestation infrastructure across two chains. **Solana originates, Base mirrors.**

---

## The two-chain split

Solana is the source of truth. Attestations are created, scored and revoked
there — it's cheap enough to write per-subject records and fast enough that a
revocation is visible to every verifier within a slot.

Base (via EAS) is a **mirror**, so the same claim is portable to EVM consumers.
It is **off by default** and nothing in the core flow blocks on it. If the mirror
ever disagrees with Solana, Solana wins.

Two chains that can both *originate* an attestation would give you two answers
and no way to reconcile them. Hence: one writer, one mirror.

---

## Layout

```
app/                    Next.js 14 App Router
  api/                  server routes (issuer key lives here, never in the browser)
lib/
  config.ts             env -> typed config, one place that fails loudly
  crypto/hash.ts        subject commitments (runs in browser and Node)
  chains/
    solana/pda.ts       address derivation — no signer needed
    solana/client.ts    read path; anyone can verify, no key required
    base/attest.ts      EAS mirror — SERVER ONLY, holds an EVM key
programs/sigpath/       Anchor program (Rust)
tests/
```

---

## Where to run what

This repo is edited on Windows and built partly in WSL. The split is not
optional — Anchor has no native Windows support — but it is smaller than
"do everything in Ubuntu":

| Command | Where | Why |
|---|---|---|
| `anchor build` / `anchor deploy`, `cargo`, `solana`, `solana-keygen` | **WSL Ubuntu** | No Rust/Solana toolchain on Windows; Anchor is unsupported there |
| `npm install`, `npm test`, `npm run dev`, `next build` | **Windows** | Runs natively, and the dev server is faster outside WSL |

**Keep exactly one copy of this repo, on the Windows side.** WSL reaches it at
`/mnt/c/Users/<you>/Desktop/sigpath`. Rust builds over `/mnt/c` are slower than
native ext4, but you build the program rarely and run the dev server constantly.

Do **not** clone a second copy into the Linux home directory to speed up builds.
Two copies is how you spend an afternoon building code you didn't just edit.

`.gitattributes` normalises everything to LF so files stay valid across the
boundary — without it, a shell script checked out on Windows gets CRLF and fails
inside Linux with `bad interpreter: /bin/bash^M`.

---

## Setup

On Windows:

```bash
npm install
cp .env.local.example .env.local
```

Toolchain, once, **inside WSL Ubuntu** (or macOS/Linux) — not PowerShell:

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
```

Anchor CLI must match the pinned `anchor-lang 0.30.1`:

```bash
cargo install --git https://github.com/solana-foundation/anchor --tag v0.30.1 anchor-cli
anchor --version   # anchor-cli 0.30.1
```

---

## Build and deploy

Run these **inside WSL**:

```bash
cd /mnt/c/Users/<you>/Desktop/sigpath
npm run anchor:build     # anchor build --no-idl; see "Known toolchain traps" #3
npm run anchor:deploy    # builds, then deploys to devnet
```

Plain `anchor build` (without `--no-idl`) **will fail** on this toolchain. The
first build also runs `keys sync`, rewriting `declare_id!` and `Anchor.toml` with
the real program id.

Copy the printed program id into `NEXT_PUBLIC_PROGRAM_ID` in `.env.local`.

> **This must be a real base58 id before `next build`.** A placeholder string
> makes `PublicKey()` throw during page-data collection and the build fails with
> `Non-base58 character`.

Then, back on **Windows**:

```bash
npm test
npm run dev
```

---

## Known toolchain traps

All three below are already handled in this repo. Read this before you touch the
lockfile or the build command, because each one costs about an hour to rediscover.

**1. `anchor build` does NOT use the Rust in your shell.**
`cargo --version` may report 1.9x while `anchor build` uses the Rust bundled with
Solana platform-tools — 1.75 on solana-cli 1.18.x. Crates requiring `edition2024`
therefore fail to *parse*, even though your shell's cargo handles them fine.

**2. `Cargo.lock` is load-bearing. Do not run bare `cargo update`.**
A fresh resolve pulls current crates that Cargo 1.75 cannot parse. It is not one
crate — fix `blake3` and `toml_datetime` appears, fix that and the next one does.
The committed lockfile resolves to a tree 1.75 can read. If you must change a
dependency, change exactly that one with `--precise` and rebuild immediately.

**3. IDL generation cannot work on this toolchain, so it is disabled.**
`anchor-syn 0.30.1` calls `proc_macro2::Span::source_file()`, removed in
proc-macro2 1.0.95 — so anchor needs <= 1.0.94. But 1.0.94's own nightly path
calls `proc_macro::Span::source_file()`, which current rustc removed — so 1.0.94
will not compile on a modern host. No version satisfies both.

Hence `anchor build --no-idl`, wired into `npm run anchor:build`.

The consequence: there is no generated IDL, so no typed `@coral-xyz/anchor`
client. Reads already work without one — `lib/chains/solana/client.ts` decodes
accounts by byte offset. **Writes must build instructions by hand**: 8-byte
discriminator plus Borsh-packed args.

That makes the account layout a hand-maintained contract between
`programs/sigpath/src/lib.rs` and the decoder in `client.ts`. Change a field in
one and the other silently reads garbage — no compiler catches it. Add a
round-trip test against a known account whenever the layout changes.

The clean long-term fix is Anchor 0.31.x, which resolved this upstream. That is a
migration, not a patch — don't attempt it close to a deadline.

## Enabling Base

Off by default; the Solana path is complete without it.

1. Fund an EVM wallet on Base Sepolia, put the private key in `BASE_ATTESTER_SECRET`
2. Register the schema once at https://base-sepolia.easscan.org — the schema string is
   `EAS_SCHEMA` in `lib/chains/base/attest.ts`
3. Put the returned UID in `EAS_SCHEMA_UID`
4. Set `BASE_ENABLED=true`

Keep the EAS schema and the Solana `Attestation` struct in sync. If you add a
field to one and not the other, the mirror silently stops meaning the same thing.

---

## Conventions

- **Subjects are hashed before they touch a chain.** A hash is re-derivable, so
  anyone who knows the subject can find the record and anyone who doesn't learns
  nothing. Never put a raw handle or email in a PDA seed.
- **Namespace every subject.** `github:alice` and `x:alice` must not collide.
- **Revoke, don't close.** A closed account is indistinguishable from one that
  never existed — exactly the ambiguity an attacker wants.
- **"Couldn't check" is never "failed."** An RPC timeout or a disabled mirror is
  an operational fact, not evidence against a subject. Model them separately.
- **Secrets stay server-side.** `ISSUER_SECRET` and `BASE_ATTESTER_SECRET` are
  private keys. Nothing under `lib/chains/base/` may be imported by a client
  component.
