import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { businessStatus } from "@/lib/sellers/business-api";
import { businessDepsFromEnv } from "@/lib/sellers/business-deps";

// GET /api/business/status?wallet=<base58>
// The wallet's verified marketplace accounts and its business, if any. Everything
// here is already public (badges are on chain; the business has a public profile).

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet") ?? "";
  try {
    new PublicKey(wallet);
  } catch {
    return NextResponse.json({ error: "Pass ?wallet=<a Solana address>." }, { status: 400 });
  }
  return NextResponse.json(await businessStatus(wallet, businessDepsFromEnv()));
}
