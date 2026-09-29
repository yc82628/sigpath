import Link from "next/link";
import { checkReportable } from "@/lib/reports/reports";
import { reportDepsFromEnv } from "@/lib/reports/evidence";
import ReportForm from "./ReportForm";

/**
 * app/report/[order]/page.tsx — report a fake product from a SigPath order.
 *
 * Public URL, so it shows nothing about WHAT was bought — the buyer knows,
 * and anyone else with the order address has no business learning it. The
 * eligibility check here is a courtesy (so a buyer isn't asked to sign for an
 * order that can't be reported); every rule is enforced again by the API.
 */

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: { order: string } }) {
  const deps = reportDepsFromEnv();
  const check = deps
    ? await checkReportable(params.order, null, deps)
    : ({ ok: false, error: "Reporting isn't configured on this server." } as const);

  return (
    <main className="container">
      <h1>Report a fake product</h1>
      <p className="lede">
        If what arrived isn&apos;t what was listed, tell us. Reports come only from buyers who paid,
        with a live photo of the item — and a reviewer decides before anything happens to the seller.
      </p>

      {!check.ok ? (
        <p className="notice withheld">{check.error}</p>
      ) : (
        <>
          <section className="guarantees">
            <h2>What happens next</h2>
            <ul>
              <li>Your report goes to a reviewer. Nothing is public while it&apos;s pending.</li>
              <li>
                If it&apos;s upheld, the seller is flagged on every SigPath search, SigPath stops buying
                from them, and the finding is recorded on Solana where any app can read it.
              </li>
              <li>
                Your photo, words and wallet are deleted as soon as it&apos;s decided. The public record
                names the seller, never you.
              </li>
            </ul>
          </section>
          <ReportForm order={params.order} />
        </>
      )}

      <p className="hint" style={{ marginTop: 24 }}>
        <Link href={`/order/${params.order}`}>Back to the order</Link>
      </p>
    </main>
  );
}
