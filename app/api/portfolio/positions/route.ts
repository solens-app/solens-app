import { NextRequest, NextResponse } from "next/server";
import { getAllUserPositions, type UserPositionSummary } from "@/app/lib/meteora";

// Live positions read from chain — never cache.
export const dynamic = "force-dynamic";

export type LiquidityPositionView = UserPositionSummary;

/**
 * GET /api/portfolio/positions?wallet=<address>
 *
 * Returns the wallet's open Meteora DLMM liquidity positions, one row per pool
 * (positions in the same pool are aggregated), enriched with the token pair,
 * deposited amounts, and a best-effort USD value.
 */
export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");
  if (!wallet || !wallet.trim()) {
    return NextResponse.json({ positions: [] });
  }

  try {
    const positions = await getAllUserPositions(wallet.trim());
    return NextResponse.json({ positions });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[portfolio] positions GET failed", detail);
    // Non-fatal for the portfolio page — return an empty list with the error.
    return NextResponse.json({
      positions: [],
      error: "Failed to load liquidity positions",
      detail,
    });
  }
}
