import Link from "next/link";
import { ON_DEVNET, proof } from "@/lib/proof/ledger";
import { getMessages } from "@/lib/i18n/server";

/**
 * The home page's line of live proof: SigPath's escrow orders and seller
 * findings, counted on Solana (lib/proof/ledger.ts), linking to /proof. Says
 * nothing until the chain has answered, rather than a number that isn't read.
 */
export default async function ProofStrip() {
  const m = getMessages();
  const p = await proof();
  if (!p) return null;
  return (
    <p className="proof-strip">
      <span className="proof-live">
        <i aria-hidden="true" />
        {m.home.proofLive}
        {/* Test numbers say so: never taken for real sales. */}
        {ON_DEVNET && ` · ${m.home.devnet}`}
      </span>
      <span>{m.home.proofLine(p.orders.fulfilled, p.orders.refunded, p.findings.length)}</span>
      <Link href="/proof">{m.home.proofLink}</Link>
    </p>
  );
}
