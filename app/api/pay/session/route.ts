import { NextRequest, NextResponse } from "next/server";
import { limited, RULES } from "@/lib/guard/limit";
import { invoiceFor, MAX_CART_ORDERS } from "@/lib/checkout/checkout";
import { AddressStore, validateAddress } from "@/lib/checkout/address-store";
import { newSessionId, PAY_SESSION_SECS, PaySessionStore } from "@/lib/checkout/pay-session";
import { DecisionLog } from "@/lib/reports/reports";

// POST /api/pay/session  { quotes: string[], address }
//   -> { id, link: "solana:https://…/api/pay/<id>", expiresAt }
//
// The QR code's session (lib/checkout/pay-session.ts): the signed prices and
// the delivery address, checked now and kept encrypted until a phone wallet
// scans the code, for fifteen minutes at most. The link is what the QR code
// holds: a Solana Pay transaction request.
//
// NO ADDRESS IN LOGS: this route logs nothing about the request body.

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.write);
  if (tooMany) return tooMany;
  const body = (await req.json().catch(() => null)) as { quotes?: unknown; address?: unknown } | null;
  const quotes = body?.quotes;
  if (!Array.isArray(quotes) || quotes.length === 0 || quotes.length > MAX_CART_ORDERS || !quotes.every((q) => typeof q === "string")) {
    return NextResponse.json({ error: "Nothing to pay for." }, { status: 400 });
  }
  const store = PaySessionStore.fromEnv();
  if (!store || !AddressStore.fromEnv()) return NextResponse.json({ error: "Checkout is not configured (ADDRESS_KEY)." }, { status: 503 });

  const address = validateAddress(body?.address);
  if (!address.ok) return NextResponse.json({ error: address.error }, { status: 400 });
  // The prices checked now, as the invoice checks them: an expired or unsigned one never reaches a phone.
  const invoice = await invoiceFor(quotes, { upheldReports: await DecisionLog.fromEnv().upheldCounts() });
  if (!invoice.ok) {
    return NextResponse.json({ error: invoice.error, ...(invoice.code ? { code: invoice.code } : {}) }, { status: invoice.status });
  }

  const id = newSessionId();
  try {
    await store.put(id, { quotes: quotes as string[], address: address.address });
  } catch {
    return NextResponse.json({ error: "Could not start the payment; nothing was charged." }, { status: 500 });
  }
  return NextResponse.json(
    { id, link: `solana:${req.nextUrl.origin}/api/pay/${id}`, expiresAt: Date.now() + PAY_SESSION_SECS * 1000 },
    { headers: { "Cache-Control": "no-store" } },
  );
}
