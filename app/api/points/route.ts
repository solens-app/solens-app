import { NextRequest, NextResponse } from "next/server";
import { getPointsState } from "@/app/lib/points";

// Points state is derived from per-user DB rows; never cache it.
export const dynamic = "force-dynamic";

/**
 * GET /api/points?wallet=<address>
 *
 * Returns the full computed points/quests/leaderboard/history state for a
 * wallet. Omitting `wallet` returns the anonymous/zero state so the quest
 * catalog still renders before a wallet is connected.
 */
export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");
  try {
    const state = await getPointsState(wallet && wallet.trim() ? wallet.trim() : null);
    return NextResponse.json(state);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[points] GET failed", detail);
    return NextResponse.json({ error: "Failed to load points", detail }, { status: 500 });
  }
}
