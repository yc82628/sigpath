"use client";

import { useState } from "react";
import { subjectHash, bytesToHex } from "@/lib/crypto/hash";
import { verifySubject, describeMethods, type VerifyResult } from "@/lib/chains/solana/client";
import { attestationPda } from "@/lib/chains/solana/pda";
import { PublicKey } from "@solana/web3.js";

/**
 * The independent-check surface.
 *
 * THIS PAGE DOES NOT CALL OUR SERVER. It hashes the handle in the browser,
 * derives the PDA, and reads the account straight from an RPC node. That is the
 * whole argument: a score returned by an API is only as trustworthy as the API,
 * but a record on a public account can be re-derived by anyone.
 *
 * Which is why every result shows the subject hash, the account address and an
 * explorer link — so a sceptic can reproduce it without this page existing.
 */

const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID ?? "";
const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "";

function explorerSuffix(): string {
  if (RPC.includes("devnet")) return "?cluster=devnet";
  if (RPC.includes("127.0.0.1") || RPC.includes("localhost")) return "?cluster=custom";
  return "";
}

const VERDICT: Record<VerifyResult["status"], { label: string; tone: string; meaning: string }> = {
  verified: { label: "VERIFIED", tone: "ok", meaning: "A live attestation exists for this subject." },
  revoked: {
    label: "REVOKED",
    tone: "bad",
    meaning: "An attestation existed and was withdrawn by its issuer. This is not the same as never having been attested.",
  },
  expired: {
    label: "EXPIRED",
    tone: "warn",
    meaning: "An attestation exists but is past its freshness window. Not a failure — just stale.",
  },
  not_found: {
    label: "NO RECORD",
    tone: "muted",
    meaning: "Nothing has been attested about this subject. Absence of a record is not evidence of anything.",
  },
};

export default function VerifyPage() {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [derived, setDerived] = useState<{ hash: string; account: string } | null>(null);

  async function check() {
    setBusy(true);
    setError("");
    setResult(null);
    setDerived(null);

    try {
      const clean = handle.trim().replace(/^@/, "");
      if (!clean) throw new Error("Enter a GitHub handle.");
      if (!PROGRAM_ID) throw new Error("NEXT_PUBLIC_PROGRAM_ID is not set.");

      // Both steps happen in YOUR browser. Nothing is sent to our server.
      const subject = await subjectHash("github", clean);
      const [pda] = attestationPda(new PublicKey(PROGRAM_ID), subject);
      setDerived({ hash: bytesToHex(subject), account: pda.toBase58() });

      setResult(await verifySubject(subject));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed.");
    } finally {
      setBusy(false);
    }
  }

  const verdict = result ? VERDICT[result.status] : null;
  const att = result && "attestation" in result ? result.attestation : null;

  return (
    <main className="container">
      <h1>Verify a subject</h1>
      <p className="lede">
        This page reads the Solana account directly from your browser. It does not ask our
        server whether someone is trustworthy — it derives the address and reads the record,
        exactly as you could yourself.
      </p>

      <div className="row">
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && check()}
          placeholder="github handle, e.g. torvalds"
          aria-label="GitHub handle"
        />
        <button onClick={check} disabled={busy || !handle.trim()}>
          {busy ? "Reading chain…" : "Check"}
        </button>
      </div>

      {error && <p className="bad">{error}</p>}

      {derived && (
        <section className="card">
          <h3>Derivation — reproduce this yourself</h3>
          <dl>
            <dt>subject</dt>
            <dd><code>github:{handle.trim().replace(/^@/, "").toLowerCase()}</code></dd>
            <dt>sha256(subject)</dt>
            <dd><code className="break">{derived.hash}</code></dd>
            <dt>PDA seeds</dt>
            <dd><code>[&quot;attest&quot;, subjectHash]</code></dd>
            <dt>account</dt>
            <dd><code className="break">{derived.account}</code></dd>
          </dl>
          <a
            className="link"
            href={`https://explorer.solana.com/address/${derived.account}${explorerSuffix()}`}
            target="_blank"
            rel="noreferrer"
          >
            Open this account on Solana Explorer →
          </a>
        </section>
      )}

      {verdict && (
        <section className="card">
          <p className={`verdict ${verdict.tone}`}>{verdict.label}</p>
          <p className="hint">{verdict.meaning}</p>

          {att && (
            <>
              <dl>
                <dt>score</dt>
                <dd>
                  <strong>{att.score}</strong> / 100
                </dd>
                <dt>how it was reached</dt>
                <dd>{describeMethods(att).join(", ") || "no method flags set"}</dd>
                <dt>issuer</dt>
                <dd><code className="break">{att.issuer}</code></dd>
                <dt>issued</dt>
                <dd>{new Date(att.issuedAt * 1000).toLocaleString()}</dd>
                <dt>expires</dt>
                <dd>{att.expiresAt ? new Date(att.expiresAt * 1000).toLocaleString() : "never"}</dd>
                <dt>Base mirror</dt>
                <dd>{att.baseUid ? <code className="break">{att.baseUid}</code> : "not mirrored"}</dd>
              </dl>
              <p className="hint">
                The <em>how</em> matters more than the number. A score reached only through
                self-asserted signals is worth far less than one backed by evidence a third
                party had to produce — and this record tells you which you are looking at.
              </p>
            </>
          )}
        </section>
      )}

      <style jsx>{`
        .row { display: flex; gap: 8px; margin: 24px 0; }
        input { flex: 1; padding: 10px 12px; font: inherit; border: 1px solid var(--border);
                border-radius: 6px; background: var(--bg); color: var(--fg); }
        button { padding: 10px 18px; font: inherit; border: 0; border-radius: 6px;
                 background: var(--accent); color: #fff; cursor: pointer; }
        button:disabled { opacity: 0.5; cursor: default; }
        .card { border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px;
                margin: 16px 0; }
        .verdict { font-size: 1.4rem; font-weight: 700; letter-spacing: 0.06em; margin: 0 0 4px; }
        .ok { color: #2ea043; } .bad { color: #f85149; }
        .warn { color: #d29922; } .muted { color: var(--muted); }
        dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 12px 0; }
        dt { color: var(--muted); font-size: 0.85rem; }
        dd { margin: 0; }
        .break { word-break: break-all; }
        .link { color: var(--accent); }
        @media (max-width: 560px) {
          .row { flex-direction: column; }
          dl { grid-template-columns: 1fr; gap: 2px 0; }
          dt { margin-top: 8px; }
        }
      `}</style>
    </main>
  );
}
