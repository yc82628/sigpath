import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { limited, RULES } from "@/lib/guard/limit";
import { MIN_SOL_LAMPORTS, ordersRpcUrl, walletFunds } from "@/lib/checkout/checkout";

// GET /api/wallet/balance?wallet=<address>
//   -> { usdc: "<base units>", lamports, minSolLamports }
//
// What the connected wallet can pay with, read from the same network and in
// the same way as the checkout (walletFunds), so the page can say "short by X"
// before Pay rather than after. A wallet's balance is public on chain; nothing
// is stored or logged.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const tooMany = await limited(req.headers, RULES.walletBalance);
  if (tooMany) return tooMany;

  let owner: PublicKey;
  try {
    owner = new PublicKey(req.nextUrl.searchParams.get("wallet") ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid wallet address." }, { status: 400 });
  }

  try {
    const { usdc, lamports } = await walletFunds(new Connection(ordersRpcUrl(), "confirmed"), owner);
    return NextResponse.json(
      { usdc: usdc.toString(), lamports, minSolLamports: MIN_SOL_LAMPORTS },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "The network didn't answer. Try again." }, { status: 502 });
  }
}
