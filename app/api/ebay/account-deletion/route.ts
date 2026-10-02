import { NextRequest, NextResponse } from "next/server";
import { challengeResponse, deletionConfig, parseNotice, purgeEbayUser, verifyEbaySignature } from "@/lib/marketplace/ebay-deletion";
import { EbaySource } from "@/lib/marketplace/sources/ebay";
import { OrderMetaStore } from "@/lib/reports/order-meta";
import { DecisionLog, ReportStore } from "@/lib/reports/reports";
import { CaseLog } from "@/lib/reports/cases";
import { VerifiedSellerLog } from "@/lib/sellers/verified-log";
import { badgeRevoker } from "@/lib/sellers/badges";

// eBay Marketplace Account Deletion — see lib/marketplace/ebay-deletion.ts.
//
//   GET  ?challenge_code=…  ownership challenge, answered with a hash
//   POST                    a signed deletion notice: verified, then acted on
//
// Register EBAY_DELETION_ENDPOINT (this route's public https URL, exactly) and
// EBAY_VERIFICATION_TOKEN in eBay's developer portal under Alerts &
// Notifications. NOTHING about the user is logged: not the username, not the
// body. Only counts.

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const cfg = deletionConfig();
  if (!cfg) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const code = req.nextUrl.searchParams.get("challenge_code");
  if (!code) return NextResponse.json({ error: "Missing challenge_code." }, { status: 400 });
  return NextResponse.json({ challengeResponse: challengeResponse(code, cfg.token, cfg.endpoint) });
}

export async function POST(req: NextRequest) {
  if (!deletionConfig()) return NextResponse.json({ error: "Not configured." }, { status: 503 });

  // The RAW body: the signature is over the exact bytes eBay sent.
  const raw = await req.text();
  const ebay = new EbaySource();
  const genuine = await verifyEbaySignature(raw, req.headers.get("x-ebay-signature"), (kid) => ebay.notificationPublicKey(kid));
  // 412 is what eBay's docs ask for when verification fails. Nothing is deleted
  // on an unverified notice, or anyone could POST a username and erase a record.
  if (!genuine) return new NextResponse(null, { status: 412 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const notice = parseNotice(body);
  // Genuine but not a deletion (or a shape we don't act on): acknowledge, do nothing.
  if (!notice) return new NextResponse(null, { status: 204 });

  const verified = VerifiedSellerLog.fromEnv();
  const report = await purgeEbayUser(notice.username, {
    metaStore: OrderMetaStore.fromEnv(),
    reportStore: ReportStore.fromEnv(),
    decisions: DecisionLog.fromEnv(),
    cases: CaseLog.fromEnv(),
    verified,
    revokeBadge: badgeRevoker(verified),
  });
  console.info(
    `ebay account deletion processed: ${report.orderRecords} order record(s), ${report.pendingReports} pending report(s), ` +
      `${report.cases} case(s), ${report.decisions} decision(s) renamed, badge ${report.badge}`,
  );
  return new NextResponse(null, { status: 204 });
}
