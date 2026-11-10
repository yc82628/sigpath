import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { ordersRpcUrl } from "@/lib/checkout/checkout";
import { readPayment } from "@/lib/checkout/payment-status";

// GET /api/checkout/status?order=<order>&sig=<signature>&until=<block height>
//   -> { state: "paid" | "failed" | "expired" | "pending", reason? }
//
// What became of a payment the wallet sent (lib/checkout/payment-status.ts):
// the checkout form asks every two seconds until it's settled. Like
// /api/orders, it returns only what anyone could read on the chain.

export const runtime = "nodejs";

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export async function GET(req: Request) {
  const url = new URL(req.url);
  let order: PublicKey;
  try {
    order = new PublicKey(url.searchParams.get("order") ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid order address." }, { status: 400 });
  }
  const sig = url.searchParams.get("sig");
  const signature = sig && SIGNATURE.test(sig) ? sig : null;
  const until = Number(url.searchParams.get("until"));
  const validUntil = Number.isSafeInteger(until) && until > 0 ? until : null;
  try {
    const status = await readPayment(new Connection(ordersRpcUrl(), "confirmed"), { order, signature, validUntil });
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // The network didn't answer: the form keeps asking.
    return NextResponse.json(
      { state: "pending", error: err instanceof Error ? err.message : "Could not read the network." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
