# SigPath

Attestation infrastructure across two chains. **Solana originates, Base mirrors.**

Deployed on devnet: [`Cy8r6RPdimsDDDKvmyW4ZmhmJYqagFBeGtn8fpkPmZw4`](https://explorer.solana.com/address/Cy8r6RPdimsDDDKvmyW4ZmhmJYqagFBeGtn8fpkPmZw4?cluster=devnet)

---

## What it does

Gathers public evidence about a subject, scores how well-corroborated that
evidence is, and records the result on-chain so a third party can check it
without trusting this server.

The claim is **not** "this profile is real." It is: *here is what was observed,
here is how much of it required another party to act, and here is the record —
go check it yourself.*

---

## The two-chain split

Solana is the source of truth. Attestations are created, scored and revoked
there — cheap enough to write per-subject records, fast enough that a revocation
is visible to every verifier within a slot.

Base (via EAS) is a **mirror**, so the same claim is portable to EVM consumers.
It is **off by default** and nothing in the core flow blocks on it. If the mirror
ever disagrees with Solana, Solana wins.

Two chains that can both *originate* an attestation would give you two answers
and no way to reconcile them. Hence: one writer, one mirror.

---

## Layout

```
app/
  api/attest/route.ts        run the check, write the attestation (server; holds the key)
  verify/page.tsx            the proof surface — reads chain in the BROWSER
lib/
  config.ts                  env -> typed config, one place that fails loudly
  crypto/hash.ts             namespaced subject commitments
  chains/
    solana/pda.ts            address derivation — no signer needed
    solana/client.ts         read path; anyone can verify, no key required
    solana/instructions.ts   hand-built instructions (no IDL — see trap #3)
    base/attest.ts           EAS mirror — SERVER ONLY, holds an EVM key
  footprint/
    types.ts                 signal vocabulary: self_asserted / temporal / corroborated
    github-signals.ts        raw counts -> weighted signals (testable offline)
    github.ts                fetches only; delegates interpretation
    x.ts, linkedin.ts        thin by necessity — see comments in each
    ownership.ts             prove account control WITHOUT scraping
    score.ts                 scoring, reasons, gaps
    session.ts               server-side record of what was proven — trust boundary
programs/sigpath/            Anchor program
scripts/
  devnet-roundtrip.ts        proves the hand-built encoding against the live program
  benchmark-scoring.ts       measures cohort separation against real accounts
tests/
```

---

## The scoring model

Every signal is tagged by how expensive it is to fake:

| Kind | Meaning | Example |
|---|---|---|
| `self_asserted` | Subject creates it alone, free | public repo count |
| `temporal` | Takes elapsed time, but backdatable | account age |
| `corroborated` | **Another party had to act** | merged PR in someone else's repo |

The score is **85% corroborated evidence, 15% context**. Corroboration drives it;
age and activity counts only modulate it.

### Weights, and the evidence behind them

Do not tune these by intuition. Re-run `scripts/benchmark-scoring.ts` and change
them against measured separation.

| Signal | Weight | Why |
|---|---|---|
| Merged PRs in others' repos | **2.0** | Cannot be self-made, backdated or bought. The anchor of the model. |
| Stars on own repos | 1.0 | Buyable, but at real cost |
| Account age | 0.5 | Context, not evidence — see below |
| Followers | 0.3 | Openly purchasable in bulk |
| Public repos | 0.3 | An empty repo costs nothing |

**The corroboration gate.** An account whose corroborated weight falls below 0.5
is capped at a score of 10, however old it is. Without this, a 16-year-old
account with 4 followers and zero merged PRs scored 24 on age alone — and *"old,
plausible, inactive"* is precisely the profile of a dormant purchased account.
Age is necessary but never sufficient.

### Measured separation (fixtures from real accounts, 2026-09-18)

| Profile | Score |
|---|---|
| deep contributor | 55 |
| mid contributor | 47 |
| popular, no collaboration | 25 |
| 100k bought followers | 10 |
| bot | 9 |
| old + empty | 7 |
| fresh fake | 1 |

54 points of separation, up from 28 before the corroboration split.

> **This is discrimination, not accuracy.** It shows that different kinds of real
> account separate. Claiming a fraud-detection *rate* needs labelled fraudulent
> accounts, which we do not have. Do not quote an accuracy figure.

---

## Proving a verification succeeded

Three layers, and the third is the one that matters:

1. **The score and its reasons** — your app telling someone a number.
2. **The `method` bitfield** — `OWNERSHIP_PROVEN | CORROBORATED | LIVE_CAPTURE`,
   recorded on-chain. A verifier can require corroborated evidence and ignore
   self-asserted scores. A bare number invites "says who?"
3. **Independent reproduction** — `/verify` hashes the subject in the browser,
   derives the PDA and reads the account from an RPC node. This server is not in
   the loop. The page shows the derivation so anyone can repeat it by hand.

Demo sequence: attest → verify → open the explorer link → revoke → re-check.
The last step shows `REVOKED`, not `NO RECORD` — a distinction most identity
systems collapse, and the reason `revoke` flips a flag instead of closing the
account.

---

## Where to run what

Edited on Windows, built partly in WSL. The split is not optional — Anchor has no
native Windows support — but it is smaller than "do everything in Ubuntu":

| Command | Where |
|---|---|
| `anchor`, `cargo`, `solana`, `solana-keygen` | **WSL Ubuntu** |
| `npm install`, `npm test`, `npm run dev`, `next build` | **Windows** |

**Keep exactly one copy of this repo, on the Windows side.** WSL reaches it at
`/mnt/c/Users/<you>/Desktop/sigpath`. Do not clone a second copy into the Linux
home to speed up builds — two copies is how you spend an afternoon building code
you did not just edit.

`kali-linux` is the default distro on this machine and has **no** Rust, Cargo,
Solana CLI or Anchor. Start shells with `wsl -d Ubuntu`, or:

```powershell
wsl --set-default Ubuntu
```

`.gitattributes` forces LF, so a shell script checked out on Windows does not
fail inside Linux with `bad interpreter: /bin/bash^M`.

---

## Setup

On Windows:

```bash
npm install
cp .env.local.example .env.local
```

Toolchain, once, **inside WSL Ubuntu**:

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
cargo install --git https://github.com/solana-foundation/anchor --tag v0.30.1 anchor-cli
anchor --version   # must read 0.30.1, matching the pinned anchor-lang
```

**Set `GITHUB_TOKEN`** in `.env.local` — a classic token with *no scopes*, since
only public data is read. Without it the search API allows ~10 req/min and
attestation requests fail with `rate_limited`. This is not optional for a demo.

---

## Build and deploy

Inside **WSL Ubuntu**, calling `anchor` directly:

```bash
cd /mnt/c/Users/<you>/Desktop/sigpath
anchor build --no-idl
anchor deploy --provider.cluster devnet
```

Plain `anchor build` **will fail** — see trap #3. The first build runs `keys sync`,
rewriting `declare_id!` and `Anchor.toml`. Copy the program id into
`NEXT_PUBLIC_PROGRAM_ID`; it must be real base58 before `next build`, or
`PublicKey()` throws `Non-base58 character` during page-data collection.

**Do not wrap these in `npm run`.** Neither WSL distro has Node, so `npm` resolves
to the *Windows* binary and runs the script through cmd.exe, which cannot see a
Linux `anchor`. The tell is a Windows error inside a Linux shell:
`'anchor' is not recognized as an internal or external command`. There are
deliberately no `anchor:*` scripts in `package.json`.

Then, back on **Windows**:

```bash
npm test
npm run dev
```

### Iterate on localnet, not devnet

Deploying a 230KB program costs **1.17 SOL of rent-exemption** on any cluster.
Not a fee, not a setting — it scales only with binary size, and `--max-len` will
not lower it because Anchor already reserves the minimum. It is refundable
(`solana program close --recipient <address>`), and redeploying to the same
program id does not charge again.

```bash
# terminal 1 — keep the ledger OFF /mnt/c, it is slow there
solana-test-validator --reset --ledger ~/sigpath-ledger

# terminal 2
solana config set --url localhost && solana airdrop 100
anchor deploy --provider.cluster localnet
```

Point the app at it with `NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899`.

---

## Scripts

```bash
npx tsx scripts/devnet-roundtrip.ts      # prove the encoding against the live program
GITHUB_TOKEN=... npx tsx scripts/benchmark-scoring.ts
```

**Run the round-trip after ANY change to the Rust account struct.** There is no
IDL, so nothing checks the encoder against the program — the unit tests only
assert the encoder matches a layout *we wrote down*, which is worthless if what
we wrote down is wrong. The round-trip sends a real transaction and reads it
back, making the program itself the judge.

---

## Known toolchain traps

All handled in this repo. Read before touching the lockfile or the build command.

**1. `anchor build` does NOT use the Rust in your shell.** `cargo --version` may
report 1.9x while the build uses platform-tools' bundled Rust (1.75 on solana-cli
1.18.x). Crates needing `edition2024` fail to *parse*.

**2. `Cargo.lock` is load-bearing. Never run bare `cargo update`.** A fresh
resolve pulls crates Cargo 1.75 cannot parse — fix `blake3` and `toml_datetime`
appears, fix that and the next one does. Change one dependency with `--precise`
and rebuild immediately.

**3. IDL generation cannot work here, so it is disabled.** `anchor-syn 0.30.1`
calls `proc_macro2::Span::source_file()`, removed in proc-macro2 1.0.95 — so
anchor needs ≤ 1.0.94. But 1.0.94's nightly path calls a `proc_macro` API current
rustc removed, so it will not compile on a modern host. No version satisfies both.

Consequence: no typed client. Reads decode by byte offset in `client.ts`; writes
build instructions by hand in `instructions.ts`. **The account layout is a
hand-maintained contract between `lib.rs` and those two files** — change a field
in one and the other reads garbage, with no compiler error. The round-trip script
is the only thing that catches it.

The clean fix is Anchor 0.31.x. That is a migration, not a patch.

---

## Enabling Base

Off by default; the Solana path is complete without it.

1. Fund an EVM wallet on Base Sepolia → `BASE_ATTESTER_SECRET`
2. Register the schema once at https://base-sepolia.easscan.org — the string is
   `EAS_SCHEMA` in `lib/chains/base/attest.ts`
3. Put the returned UID in `EAS_SCHEMA_UID`
4. Set `BASE_ENABLED=true`

Keep the EAS schema and the Solana `Attestation` struct in sync. Add a field to
one and not the other and the mirror silently stops meaning the same thing.

---

## Conventions

- **Subjects are hashed with a namespace.** `github:alice` and `x:alice` must not
  collide. Never put a raw handle or email in a PDA seed.
- **Ownership before collection.** Signals from an account nobody proved they
  control are worthless — anyone can type a famous handle into a form.
- **We never scrape.** LinkedIn forbids it and blocks it; X's read API is paid.
  Users publish a nonce we issue, or complete OAuth. Proving *control* is also
  stronger evidence than a scraped profile, which only proves a profile exists.
- **Revoke, don't close.** A closed account is indistinguishable from one that
  never existed — the exact ambiguity an attacker wants.
- **"Couldn't check" is never "failed."** A rate limit or dead API is an
  operational fact, not evidence against a subject. It belongs in `gaps`, and it
  must never lower a score. A bug here once silently dropped the heaviest signal
  in the model and produced three runs of confidently wrong numbers.
- **Secrets stay server-side.** `ISSUER_SECRET` and `BASE_ATTESTER_SECRET` are
  private keys. Nothing under `lib/chains/base/` may be imported by a client
  component.

---

## Not done yet

- **Image / live-capture verification is not in this repo.** The `LIVE_CAPTURE`
  method flag exists in the program and nothing sets it. The vision-based
  challenge check lives in the earlier `gillty-verify` project and has never made
  a live API call.
- **X and LinkedIn collectors are thin by necessity** — they contribute breadth
  and name agreement, not depth. See the comments in each file.
- **The Base mirror has never been executed.** It needs a registered schema and a
  funded EVM wallet.
- **Session state is in-memory.** `lib/footprint/session.ts` uses a `Map` —
  single instance only. Move to Redis before scaling out.
