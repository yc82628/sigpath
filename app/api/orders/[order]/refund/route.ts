import { NextRequest, NextResponse } from "next/server";
import { prepareRefund } from "@/lib/checkout/checkout";

// POST /api/orders/<order>/refund  { caller }  -> { transaction (base64, unsigned) }
//
// Builds the refund for the caller's wallet to sign. Anyone may request it
// once the deadline has passed — the program pays out only to the buyer's own
// USDC account, whoever signs. The deadline check here exists only to give a
// clear message; the program enforces it regardless.

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { order: string } }) {
  let body: { caller?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const result = await prepareRefund({ order: params.order, caller: body.caller });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ transaction: result.transaction });
}
