import { NextRequest, NextResponse } from "next/server";
import { limited, RULES } from "@/lib/guard/limit";
import { challenge, siteFrom } from "@/lib/account/session";

// POST /api/account/challenge  { wallet }  -> { message, token }
//
// The text for the wallet to sign, to sign in (lib/account/session.ts). Nothing
// is stored: the token carries what's needed to check the signature later.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.signIn);
  if (tooMany) return tooMany;
  const body = await req.json().catch(() => ({}));
  const r = challenge({ wallet: (body as { wallet?: unknown }).wallet, site: siteFrom(req.headers.get("host")) });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ message: r.message, token: r.token }, { headers: { "Cache-Control": "no-store" } });
}
