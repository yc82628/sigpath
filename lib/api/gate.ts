import { NextResponse, type NextRequest } from "next/server";
import { gatewayAuthorised, GATEWAY_HEADER } from "../agents/check";

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
