import { distinctTokenName, getWalletOverview } from "@/app/lib/solana";
import { getTokenPrices } from "@/app/lib/jupiter";

const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
const NATIVE_SOL_LOGO =
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";

export interface PortfolioToken {
    mint: string;
    /** Resolved symbol, or a short mint fallback. */
    symbol: string;
    /** Full token name, when it adds anything over the ticker. */
    name: string | null;
    logo: string | null;
    amount: number;
    amountLabel: string;
    usdPrice: number | null;
    usdValue: number | null;
}

export interface Portfolio {
    address: string;
    solBalance: number;
    solBalanceLabel: string;
    solLogo: string;
    solUsdValue: number | null;
    /** SOL plus all priced tokens. null only when SOL price is missing. */
    totalUsdValue: number | null;
    /** Sum of just the values we could price (used as a partial total). */
    knownUsdValue: number;
    tokens: PortfolioToken[];
    pricesIncomplete: boolean;
}

function shortMint(mint: string): string {
    return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/**
 * Real, fully-priced portfolio for a wallet. Shared by the portfolio page API
 * and any other surface that needs live holdings. USD math is done here in code
 * (never by the model) using exact on-chain balances and Jupiter prices.
 */
export async function getPortfolio(walletAddress: string): Promise<Portfolio> {
    const overview = await getWalletOverview(walletAddress);

    const mints = [NATIVE_SOL_MINT, ...overview.tokens.map((t) => t.mint)];
    let prices: Awaited<ReturnType<typeof getTokenPrices>> = [];
    try {
        prices = await getTokenPrices(mints);
    } catch {
        prices = [];
    }
    const priceOf = (mint: string): number | null => {
        const p = prices.find((x) => x.mint === mint);
        return p ? parseFloat(p.price) : null;
    };

    const solPrice = priceOf(NATIVE_SOL_MINT);
    const solUsdValue =
        solPrice !== null ? overview.solBalance * solPrice : null;

    const tokens: PortfolioToken[] = overview.tokens.map((t) => {
        const usdPrice = priceOf(t.mint);
        return {
            mint: t.mint,
            symbol: t.symbol || shortMint(t.mint),
            name: distinctTokenName(t.symbol, t.name),
            logo: t.logo,
            amount: t.amount,
            amountLabel: String(t.amountString ?? t.amount),
            usdPrice,
            usdValue: usdPrice !== null ? t.amount * usdPrice : null,
        };
    });

    // Highest-value holdings first; unpriced tokens sink to the bottom.
    tokens.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));

    const knownUsdValue =
        (solUsdValue ?? 0) +
        tokens.reduce((sum, t) => sum + (t.usdValue ?? 0), 0);
    const pricesIncomplete =
        solPrice === null || tokens.some((t) => t.usdValue === null);

    return {
        address: walletAddress,
        solBalance: overview.solBalance,
        solBalanceLabel: `${overview.solBalance.toFixed(4)} SOL`,
        solLogo: NATIVE_SOL_LOGO,
        solUsdValue,
        totalUsdValue: solPrice === null ? null : knownUsdValue,
        knownUsdValue,
        tokens,
        pricesIncomplete,
    };
}
