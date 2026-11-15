import { NextRequest, NextResponse } from "next/server";
import { limited, RULES } from "@/lib/guard/limit";
import { sessionCookie, signIn, siteFrom } from "@/lib/account/session";

// POST /api/account/signin  { token, signature }  -> { wallet } and the session cookie
// POST /api/account/signin  { signOut: true }     -> clears the cookie
//
// Checks the wallet's signature over the text from /api/account/challenge and,
// if it verifies, remembers the wallet in an HttpOnly cookie for 30 days. The
// cookie is the only record: SigPath stores nothing about the sign-in.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Behind Vercel's proxy the original scheme is in x-forwarded-proto; locally it's plain http.
const secure = (req: NextRequest) => req.headers.get("x-forwarded-proto") === "https" || req.nextUrl.protocol === "https:";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.signIn);
  if (tooMany) return tooMany;
  const body = (await req.json().catch(() => ({}))) as { token?: unknown; signature?: unknown; signOut?: unknown };

  if (body.signOut === true) {
    const res = NextResponse.json({ wallet: null }, { headers: { "Cache-Control": "no-store" } });
    res.headers.append("Set-Cookie", sessionCookie("", 0, secure(req)));
    return res;
  }

  const r = signIn({ token: body.token, signature: body.signature, site: siteFrom(req.headers.get("host")) });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  const res = NextResponse.json({ wallet: r.wallet }, { headers: { "Cache-Control": "no-store" } });
  res.headers.append("Set-Cookie", sessionCookie(r.session, r.maxAge, secure(req)));
  return res;
}
