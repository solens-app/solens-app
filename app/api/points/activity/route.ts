import { NextRequest, NextResponse } from "next/server";
import { getOnchainActivity } from "@/app/lib/points";

// Per-user, derived from DB rows — never cache.
export const dynamic = "force-dynamic";

/**
 * GET /api/points/activity?wallet=<address>
 *
 * Returns the wallet's on-chain transaction history (newest first). Interaction
 * events (wallet_connect / ai_message) are excluded — this is the real,
 * verified, on-chain activity surfaced on the History page. Omitting `wallet`
 * returns an empty list so the page renders before a wallet is connected.
 */
export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");
  try {
    const activity = await getOnchainActivity(wallet && wallet.trim() ? wallet.trim() : "");
    return NextResponse.json({ activity });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[points] activity GET failed", detail);
    return NextResponse.json({ error: "Failed to load activity", detail }, { status: 500 });
  }
}
