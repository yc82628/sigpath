import Link from "next/link";
import { notFound } from "next/navigation";
import { DecisionLog } from "@/lib/reports/reports";
import { VerifiedSellerLog } from "@/lib/sellers/verified-log";
import { BusinessLog, businessView, type BusinessStatus } from "@/lib/sellers/business";

/**
 * app/business/[id] — a business's public trust profile.
 *
 * Exactly what was verified, by what evidence, and when; what wasn't; and
 * every linked account with its on-chain badge and any upheld reports. A
 * business can link here from its own shop. It says what the verification
 * doesn't mean, as plainly as what it does.
 */

export const dynamic = "force-dynamic";

const MARKET: Record<string, string> = { ebay: "eBay", etsy: "Etsy", amazon: "Amazon", stub: "Demo" };

const STATUS: Record<BusinessStatus, { label: string; className: string }> = {
  verified: { label: "✓ Verified business", className: "verified business" },
  suspended: { label: "Suspended", className: "status-chip warn" },
  expired: { label: "Expired", className: "status-chip" },
  incomplete: { label: "Not verified yet", className: "status-chip" },
};

function day(s: number) {
  return new Date(s * 1000).toISOString().slice(0, 10);
}

export async function generateMetadata({ params }: { params: { id: string } }) {
  const b = await BusinessLog.fromEnv().byId(decodeURIComponent(params.id));
  return { title: b?.vat?.registeredName ? `${b.vat.registeredName} — SigPath business profile` : "Business profile — SigPath" };
}

export default async function BusinessProfile({ params }: { params: { id: string } }) {
  const business = await BusinessLog.fromEnv().byId(decodeURIComponent(params.id));
  if (!business) notFound();
  const v = businessView(business, await VerifiedSellerLog.fromEnv().all(), await DecisionLog.fromEnv().upheldCounts());
  const status = STATUS[v.status];

  return (
    <main className="container business-profile">
      <p className="hint">SigPath business profile</p>
      <h1>{v.registeredName ?? (v.countryName ? `Business registered in ${v.countryName}` : "Business")}</h1>
      <p>
        <span className={status.className}>{status.label}</span>
        {v.status === "verified" && v.expiresAt && <span className="hint"> &middot; valid until {day(v.expiresAt)}</span>}
      </p>
      {v.statusReason && <p className="notice withheld">{v.statusReason}</p>}

      <h2>What was verified</h2>
      <ul className="evidence">
        <li className={v.vatMasked ? "good" : "info"}>
          {v.vatMasked ? (
            <>
              <strong>Registered business:</strong> VAT number <code>{v.vatMasked}</code> is valid in the EU&apos;s VIES
              register ({v.countryName}), checked {day(v.vatCheckedAt!)}.{" "}
              {v.registeredName
                ? <>The register gives its name as <strong>{v.registeredName}</strong>.</>
                : <>{v.countryName} doesn&apos;t publish business names through the register, so the name isn&apos;t confirmed.</>}
            </>
          ) : (
            <>
              <strong>Registered business:</strong> not checked yet.
            </>
          )}
        </li>
        <li className={v.domain ? "good" : "info"}>
          {v.domain ? (
            <>
              <strong>Website:</strong> controls <strong>{v.domain}</strong>, proved through its DNS on {day(v.domainVerifiedAt!)}.
            </>
          ) : (
            <>
              <strong>Website:</strong> none proved.
            </>
          )}
        </li>
        <li className={v.accounts.some((a) => a.active) ? "good" : "info"}>
          <strong>Marketplace accounts:</strong> {v.accounts.length} linked by one wallet. Each proved control of the
          account and passed a live check, and holds a non-transferable badge on Solana.
        </li>
      </ul>

      <h2>Linked accounts</h2>
      {v.accounts.length === 0 ? (
        <p className="hint">No verified marketplace accounts are linked.</p>
      ) : (
        <ul className="linked-accounts">
          {v.accounts.map((a) => (
            <li key={a.sellerKey}>
              <Link href={`/seller/${encodeURIComponent(a.source)}/${encodeURIComponent(a.handle)}`}>
                <strong>{a.handle}</strong>
              </Link>{" "}
              <span className="chip">{MARKET[a.source] ?? a.source}</span>{" "}
              <span className="hint">
                verified {day(a.verifiedAt)}
                {!a.active && " · badge not currently shown"}
                {a.upheldReports > 0 && ` · ${a.upheldReports} upheld report${a.upheldReports === 1 ? "" : "s"}`}
                {" · "}
                <a href={`https://explorer.solana.com/address/${a.attestation}?cluster=devnet`} target="_blank" rel="noopener noreferrer">
                  on chain
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>What this doesn&apos;t mean</h2>
      <p className="hint">
        It answers <em>who runs these accounts</em>, not <em>whether an item is genuine</em>. A registered business can
        still sell a bad item. That&apos;s why every listing is still price-checked, and why one upheld fake-product
        report against any linked account suspends this verification for all of them.
      </p>
      <p className="hint">
        <Link href="/search">Back to search</Link> &middot; <Link href="/seller/business">Verify your business</Link>
      </p>
    </main>
  );
}
