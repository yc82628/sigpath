import Link from "next/link";
import { publicFindings } from "@/lib/reports/seller";
import { DecisionLog } from "@/lib/reports/reports";
import { CaseLog } from "@/lib/reports/cases";
import { sellerKey } from "@/lib/marketplace/types";

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

  return (
    <main className="container">
      <h1>
        {handle} <span className="hint">on {source}</span>
      </h1>

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
        order it placed, with a private link to respond. <Link href="/search">Back to search</Link>
      </p>
    </main>
  );
}
