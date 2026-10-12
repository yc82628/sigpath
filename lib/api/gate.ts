import { NextResponse, type NextRequest } from "next/server";
import { gatewayAuthorised, GATEWAY_HEADER } from "../agents/check";
import { limited, type Rule } from "../guard/limit";

/**
 * Paid API routes answer only what the pay.sh gateway forwarded (and so was
 * paid for), once SIGPATH_GATEWAY_KEY is set. Unset, they're open, for local
 * development and the sandbox. Returns the refusal, or null to carry on.
 */
export function refuseUnpaid(req: NextRequest): NextResponse | null {
  if (gatewayAuthorised(req.headers.get(GATEWAY_HEADER), process.env.SIGPATH_GATEWAY_KEY)) return null;
  return NextResponse.json(
    { error: "Call this through SigPath's pay.sh gateway, which handles the USDC payment. See /developers." },
    { status: 401 },
  );
}

/**
 * Paid traffic through the gateway is never limited: every request was paid
 * for. Without a gateway key the origin is open (development, the sandbox),
 * and then it is limited like any free route, by `rule`.
 */
export async function refuseUnpaidOrLimited(req: NextRequest, rule: Rule): Promise<NextResponse | null> {
  const refused = refuseUnpaid(req);
  if (refused) return refused;
  return process.env.SIGPATH_GATEWAY_KEY?.trim() ? null : limited(req.headers, rule);
}
