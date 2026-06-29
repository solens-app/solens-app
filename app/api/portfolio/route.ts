import { NextRequest, NextResponse } from "next/server";
import { getPortfolio } from "@/app/lib/portfolio";

// Per-wallet live balances — never cache.
export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio?wallet=<address>
 *
 * Real holdings (SOL + SPL tokens) with live USD values for the Portfolio page.
 * Omitting `wallet` returns an empty portfolio so the page can render before a
 * wallet is connected.
 */
export async function GET(request: NextRequest) {
    const wallet = request.nextUrl.searchParams.get("wallet")?.trim();

    if (!wallet) {
        return NextResponse.json({
            portfolio: {
                address: "",
                solBalance: 0,
                solBalanceLabel: "0.0000 SOL",
                solUsdValue: 0,
                totalUsdValue: 0,
                knownUsdValue: 0,
                tokens: [],
                pricesIncomplete: false,
            },
        });
    }

    try {
        const portfolio = await getPortfolio(wallet);
        return NextResponse.json({ portfolio });
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error("[portfolio] GET failed", detail);
        return NextResponse.json(
            { error: "Failed to load portfolio", detail },
            { status: 500 },
        );
    }
}
