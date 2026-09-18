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

## Setup

```bash
npm install
cp .env.local.example .env.local
```

Toolchain (once, in **WSL/Ubuntu or macOS/Linux** — not PowerShell):

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

```bash
anchor build          # also runs `keys sync`, rewriting declare_id! and Anchor.toml
anchor deploy --provider.cluster devnet
```

Copy the printed program id into `NEXT_PUBLIC_PROGRAM_ID` in `.env.local`.

> **This must be a real base58 id before `next build`.** A placeholder string
> makes `PublicKey()` throw during page-data collection and the build fails with
> `Non-base58 character`.

Then:

```bash
npm test
npm run dev
```

---

## Known toolchain traps

These bite on a fresh machine and cost an hour each. Fixes are known:

**1. `anchor build` uses a different Rust than your shell.**
`cargo --version` may report 1.9x while `anchor build` uses the Rust bundled with
Solana's platform-tools (1.75 on solana-cli 1.18.x). Crates that require
`edition2024` therefore fail to parse even though your shell's cargo handles them.

```bash
# blake3 pulls digest 0.11 -> crypto-common 0.2.x, which needs edition2024
cargo update -p blake3 --precise 1.5.5
```

**2. `anchor-syn 0.30.1` breaks on current `proc-macro2`.**
`proc_macro2::Span::source_file` was removed in 1.0.95; anchor-syn still calls it,
so the IDL build fails with `no method named source_file`.

```bash
cargo update -p proc-macro2 --precise 1.0.94
```

**3. Building over `/mnt/c` from WSL is slow.** It works, but expect several
minutes on a cold build. Keep one canonical copy of the repo — a second copy in
the Linux home directory is how you end up building code you didn't just edit.

---

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
