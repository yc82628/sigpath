import Link from "next/link";
import { publicFindings } from "@/lib/reports/seller";
import { DecisionLog } from "@/lib/reports/reports";
import { CaseLog } from "@/lib/reports/cases";
import { sellerKey } from "@/lib/marketplace/types";
import { VerifiedSellerLog, badgeFor } from "@/lib/sellers/verified-log";
import { sellerSubject } from "@/lib/sellers/badges";
import { sasConfigFromEnv, signer } from "@/lib/chains/solana/sas";
import { readVerifiedSeller, type OnChainBadge } from "@/lib/chains/solana/sas-verified";

/**
 * app/seller/[source]/[handle] — the public record of a seller.
 *
 * Only upheld findings appear — never pending reports — and every one is shown
 * with the seller's own reply and appeal beside it. A finding reversed on
 * appeal stays listed, marked reversed: the record shows that a mistake was
 * made and corrected, rather than quietly disappearing it.
 */

export const dynamic = "force-dynamic";

const CATEGORY = {
  counterfeit: "Item reported as not genuine",
  not_as_described: "Item materially different from the listing",
} as const;

function day(s: number) {
  return new Date(s * 1000).toISOString().slice(0, 10);
}

export default async function SellerPage({ params }: { params: { source: string; handle: string } }) {
  const source = decodeURIComponent(params.source);
  const handle = decodeURIComponent(params.handle);
  const findings = await publicFindings(sellerKey(source, handle), {
    decisions: DecisionLog.fromEnv(),
    cases: CaseLog.fromEnv(),
  });
  const active = findings.filter((f) => f.status === "upheld").length;

  // The badge is shown only when SigPath's log AND the chain agree: issued,
  // not revoked or lapsed, no upheld report — and the token still held.
  const key = sellerKey(source, handle);
  const decisions = DecisionLog.fromEnv();
  const local = badgeFor(key, await VerifiedSellerLog.fromEnv().all(), await decisions.upheldCounts());
  let onChain: OnChainBadge | null = null;
  const cfg = sasConfigFromEnv();
  if (local && cfg) {
    onChain = await readVerifiedSeller((await signer(cfg)).address, await sellerSubject(key), cfg.rpcUrl).catch(() => null);
  }
  const verified = local && (!cfg || onChain?.status === "valid") ? local : null;

  return (
    <main className="container">
      <h1>
        {handle} <span className="hint">on {source}</span>
      </h1>

      {verified && (
        <p className="notice">
          <span className="verified">&#10003; Verified seller</span> since {day(verified.verifiedAt)} — this
          seller proved control of the account and passed a live check. The badge is a non-transferable
          token{onChain?.status === "valid" ? <> held by <code>{onChain.holder.slice(0, 4)}…{onChain.holder.slice(-4)}</code></> : null}{" "}
          (
          <a href={`https://explorer.solana.com/address/${verified.attestation}?cluster=devnet`} target="_blank" rel="noopener noreferrer">
            on chain
          </a>
          ), valid until {day(verified.expiresAt)}. It vouches for the account, not for any item.
        </p>
      )}

      <p className={active ? "notice withheld" : "notice"}>
        {active === 0
          ? findings.length
            ? "No findings currently stand against this seller."
            : "No fake-product findings against this seller."
          : `${active} fake-product finding${active === 1 ? "" : "s"} currently stand${active === 1 ? "s" : ""} against this seller.`}
      </p>
      <p className="hint">
        A finding means a buyer who paid through SigPath reported the item with a live photo, the
        seller was given the chance to reply, and a reviewer upheld it. Reports still under review are
        never shown here.
      </p>

      {findings.map((f, i) => (
        <article key={i} className="listing">
          <div className="body">
            <h3>{CATEGORY[f.category]}</h3>
            <p className="meta">
              {f.status === "reversed" ? (
                <>
                  Upheld {day(f.decidedAt)}, <strong>reversed {day(f.reversedAt!)}</strong> — no longer
                  counts against the seller
                </>
              ) : (
                <>Upheld {day(f.decidedAt)}</>
              )}
              {f.attestation && (
                <>
                  {" "}
                  &middot;{" "}
                  <a
                    href={`https://explorer.solana.com/address/${f.attestation}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    on-chain record
                  </a>
                </>
              )}
            </p>
            {f.reply && (
              <blockquote className="quote">
                <span className="hint">The seller replied ({day(f.reply.at)}):</span>
                <br />
                {f.reply.text}
              </blockquote>
            )}
            {f.appeal && (
              <blockquote className="quote">
                <span className="hint">The seller appealed ({day(f.appeal.at)}):</span>
                <br />
                {f.appeal.text}
              </blockquote>
            )}
            {!f.reply && !f.appeal && <p className="hint">The seller did not respond.</p>}
          </div>
        </article>
      ))}

      <p className="hint" style={{ marginTop: 24 }}>
        Are you this seller? SigPath contacts sellers through the marketplace&apos;s own messages on the
        order it placed, with a private link to respond.{" "}
        {!verified && !active && (
          <>
            You can also <Link href="/seller/verify">become a verified seller</Link>.{" "}
          </>
        )}
        <Link href="/search">Back to search</Link>
      </p>
    </main>
  );
}
