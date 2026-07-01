import { NextRequest, NextResponse } from "next/server";
import { getPositions, microUsdToDisplay } from "@/app/lib/prediction";

// Live positions from Jupiter — never cache.
export const dynamic = "force-dynamic";

export type PredictionPositionView = {
  pubkey: string;
  market: string;
  event: string;
  side: "YES" | "NO";
  contracts: string;
  valueUsd: string | null;
  costUsd: string;
  pnlUsd: string | null;
  pnlPercent: number | null;
  payoutUsd: string;
  claimable: boolean;
  status: string;
  result: string;
};

/**
 * GET /api/portfolio/predictions?wallet=<address>
 *
 * Returns the wallet's *open* prediction-market positions (contracts still
 * held, or a resolved position that is claimable). Fully-closed/claimed
 * positions are filtered out so the portfolio shows only live exposure.
 */
export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");
  if (!wallet || !wallet.trim()) {
    return NextResponse.json({ positions: [] });
  }

  try {
    const { data } = await getPositions(wallet.trim());
    const positions: PredictionPositionView[] = (data ?? [])
      // Keep positions the user still holds, or resolved ones awaiting a claim.
      .filter((p) => Number(p.contracts) > 0 || (p.claimable && !p.claimed))
      .map((p) => ({
        pubkey: p.pubkey,
        market: p.marketMetadata?.title || p.eventMetadata?.title || "Prediction market",
        event: p.eventMetadata?.title || "",
        side: p.isYes ? "YES" : "NO",
        contracts: p.contracts,
        valueUsd: p.valueUsd ? microUsdToDisplay(p.valueUsd) : null,
        costUsd: microUsdToDisplay(p.totalCostUsd),
        pnlUsd: p.pnlUsd ? microUsdToDisplay(p.pnlUsd) : null,
        pnlPercent: p.pnlUsdPercent,
        payoutUsd: microUsdToDisplay(p.payoutUsd),
        claimable: p.claimable && !p.claimed,
        status: p.marketMetadata?.status || "open",
        result: p.marketMetadata?.result || "pending",
      }));

    return NextResponse.json({ positions });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[portfolio] predictions GET failed", detail);
    // Non-fatal for the portfolio page — return an empty list with the error.
    return NextResponse.json({ positions: [], error: "Failed to load prediction positions", detail });
  }
}
