import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import {
    getSOLBalance,
    getTokenAccounts,
    getWalletOverview,
    getMintDecimals,
    distinctTokenName,
} from "@/app/lib/solana";
import {
    getTokenPrices,
    resolveTokenMint,
    getSwapOrder,
    getKnownDecimals,
    getTrendingTokens,
} from "@/app/lib/jupiter";
import {
    searchPools,
    getPoolDetails,
    getUserPositionsForPool,
    getAllUserPositions,
    buildAddLiquidityTx,
    buildRemoveLiquidityTx,
} from "@/app/lib/meteora";
import {
    getTokenCreators,
    getTokenLifetimeFees,
    getClaimablePositions,
    createClaimTransactions,
    createTokenInfo,
    createFeeShareConfig,
    createLaunchTransaction,
} from "@/app/lib/bags";
import {
    getCollectionStats as getMECollectionStats,
    getCollectionListings as getMEListings,
    getWalletNFTs as getMEWalletNFTs,
    getNFTByMint as getMENFTByMint,
    getBuyNowTx as getMEBuyNowTx,
    getListNFTTx as getMEListNFTTx,
} from "@/app/lib/magiceden";
import {
    searchEvents as searchPredictionEvents,
    listEvents as listPredictionEvents,
    getMarket as getPredictionMarket,
    createOrder as createPredictionOrder,
    getPositions as getPredictionPositions,
    closePosition as closePredictionPosition,
    claimPayout as claimPredictionPayout,
    microUsdToDisplay,
} from "@/app/lib/prediction";
import {
    createSolTransferTx,
    createSplTransferTx,
    createWrapSolTx,
    createUnwrapSolTx,
    getSystemAccountRentReserveLamports,
    uiAmountToRawUnits,
} from "@/app/lib/transfer";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

/** Extra lamports left above rent exemption so the fee payer can cover signatures + rounding. */
const SOL_TRANSFER_FEE_BUFFER_LAMPORTS = 15_000;
type TokenHolding = Awaited<ReturnType<typeof getTokenAccounts>>[number];

const openaiBaseURL = process.env.OPENAI_BASE_URL?.trim();
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    ...(openaiBaseURL ? { baseURL: openaiBaseURL } : {}),
});
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const FALLBACK_MODELS = [
    process.env.OPENAI_MODEL_FALLBACK,
    process.env.OPENAI_MODEL_FALLBACK_2,
    process.env.OPENAI_MODEL_FALLBACK_3,
]
    .map((m) => m?.trim())
    .filter((m): m is string => Boolean(m && m !== MODEL));

async function createChatCompletion(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const chain = [
        params.model,
        ...FALLBACK_MODELS.filter((m) => m !== params.model),
    ];
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
        const model = chain[i];
        try {
            return await openai.chat.completions.create({ ...params, model });
        } catch (err) {
            lastErr = err;
            const status = (err as { status?: number })?.status;
            const retryable =
                status === 429 || (typeof status === "number" && status >= 500);
            const hasNext = i < chain.length - 1;
            if (!retryable || !hasNext) throw err;
            console.warn(
                `[chat] model "${model}" failed (status ${status}); falling back to "${chain[i + 1]}"`,
            );
        }
    }
    throw lastErr;
}

function rawUnitsToUiAmountString(
    rawAmount: string | bigint,
    decimals: number,
): string {
    const raw = rawAmount.toString();
    const padded = raw.padStart(decimals + 1, "0");
    const intPart = padded.slice(0, padded.length - decimals) || "0";
    if (decimals === 0) return intPart;
    const fracPart = padded.slice(-decimals).replace(/0+$/, "");
    return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function isSolanaPublicKey(value: string): boolean {
    try {
        new PublicKey(value);
        return true;
    } catch {
        return false;
    }
}

function findTokenHolding(
    holdings: TokenHolding[],
    token: string,
): TokenHolding | null {
    const query = token.trim();
    const upper = query.toUpperCase();
    return (
        holdings.find((holding) => holding.mint === query) ||
        holdings.find((holding) => holding.symbol?.toUpperCase() === upper) ||
        holdings.find((holding) =>
            holding.mint.toUpperCase().startsWith(upper),
        ) ||
        null
    );
}

type WrapAction = {
    type: "wrapSol";
    transaction: string;
    direction: "wrap" | "unwrap";
    amount: number;
};

/**
 * Build a wrap (SOL → WSOL) or unwrap (WSOL → SOL) action. SOL and WSOL share a
 * mint, so this is never a Jupiter swap. Shared by the `wrap_sol` tool and the
 * `initiate_swap` fallback (when the model mistakenly asks to "swap" between
 * them). For wrap, the SOL amount comes from `amount` (SOL units) or `amountUsd`
 * (converted with a live price) and is clamped so the fee can still be paid.
 */
async function buildWrapUnwrapAction(params: {
    spendWallet: string;
    direction: "wrap" | "unwrap";
    amount?: number;
    amountUsd?: number;
}): Promise<
    { pendingAction: WrapAction; message: string } | { error: string }
> {
    const { spendWallet, direction, amount, amountUsd } = params;
    const NATIVE_SOL = "So11111111111111111111111111111111111111112";

    if (direction === "unwrap") {
        const un = await createUnwrapSolTx({ ownerWallet: spendWallet });
        const sol = un.lamports / LAMPORTS_PER_SOL;
        if (sol <= 0) {
            return {
                error: "You don't have any Wrapped SOL (WSOL) to unwrap.",
            };
        }
        return {
            pendingAction: {
                type: "wrapSol",
                transaction: un.transaction,
                direction: "unwrap",
                amount: sol,
            },
            message: `Unwrap prepared: converting ${sol.toFixed(6)} Wrapped SOL (WSOL) back to native SOL. Transaction ready for user to sign and confirm.`,
        };
    }

    // wrap: resolve the SOL amount from a token amount or a dollar value.
    let sol: number | undefined =
        typeof amount === "number" && Number.isFinite(amount) && amount > 0
            ? amount
            : undefined;
    if (
        sol === undefined &&
        typeof amountUsd === "number" &&
        Number.isFinite(amountUsd) &&
        amountUsd > 0
    ) {
        const [p] = await getTokenPrices([NATIVE_SOL]);
        const unitPrice = p ? parseFloat(p.price) : NaN;
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
            return {
                error: `Couldn't get a reliable SOL price right now, so I can't convert $${amountUsd} to a SOL amount. Try specifying the amount in SOL instead.`,
            };
        }
        sol = amountUsd / unitPrice;
    }
    if (sol === undefined || !Number.isFinite(sol) || sol <= 0) {
        return {
            error: "Tell me how much SOL to wrap (e.g. 'wrap 0.1 SOL' or 'wrap $5 of SOL').",
        };
    }

    // Keep a little SOL for the network fee + WSOL account rent.
    const WRAP_FEE_RESERVE_LAMPORTS = 5_000_000; // ~0.005 SOL
    const balance = await getSOLBalance(spendWallet);
    const requested = Math.round(sol * LAMPORTS_PER_SOL);
    const maxLamports = balance.lamports - WRAP_FEE_RESERVE_LAMPORTS;
    if (maxLamports <= 0) {
        return {
            error: `Not enough SOL to wrap after keeping ~${(WRAP_FEE_RESERVE_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3)} SOL for the network fee. Balance: ${balance.sol.toFixed(6)} SOL.`,
        };
    }
    let lamports = requested;
    let clampNote = "";
    if (lamports > maxLamports) {
        lamports = maxLamports;
        clampNote = ` Amount reduced to ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL so you keep enough SOL for the network fee.`;
    }
    const wrapped = await createWrapSolTx({
        ownerWallet: spendWallet,
        lamports,
    });
    const solWrapped = lamports / LAMPORTS_PER_SOL;
    return {
        pendingAction: {
            type: "wrapSol",
            transaction: wrapped.transaction,
            direction: "wrap",
            amount: solWrapped,
        },
        message: `Wrap prepared: converting ${solWrapped.toFixed(6)} SOL into Wrapped SOL (WSOL).${clampNote} Transaction ready for user to sign and confirm.`,
    };
}

const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPUSD_MINT = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";

/** Format a USD token price, keeping precision for tiny memecoin prices. */
function formatUsdPrice(price: number): string {
    if (price === 0) return "0";
    if (price >= 1) return price.toFixed(2);
    if (price >= 0.01) return price.toFixed(4);
    // Very small prices: show enough significant digits.
    return price.toPrecision(3);
}

/** Compact USD formatting for market cap / volume / liquidity (e.g. $1.2M). */
function formatCompactUsd(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "N/A";
    if (value >= 1_000_000_000)
        return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
    return `$${value.toFixed(0)}`;
}

// Tools that produce a single confirmable action (pendingAction). Once one is
// prepared in a turn, further action tool calls are skipped.
const ACTION_TOOLS = new Set([
    "initiate_swap",
    "wrap_sol",
    "transfer_sol",
    "transfer_token",
    "add_liquidity",
    "remove_liquidity",
    "launch_token",
    "claim_fees",
    "buy_prediction",
    "sell_prediction",
    "claim_prediction",
    "buy_nft",
    "list_nft",
]);

interface PortfolioTokenRow {
    symbol: string;
    /** Full token name, when it adds anything over the ticker. */
    name: string | null;
    logo: string | null;
    mint: string;
    amount: number;
    amountLabel: string;
    usdValue: number | null;
    usdLabel: string;
}

interface PortfolioPositionRow {
    poolAddress: string;
    poolName: string;
    pairLabel: string;
    amountLabel: string;
    usdLabel: string;
}

interface PortfolioView {
    walletAddress: string;
    solBalance: number;
    solBalanceLabel: string;
    solLogo: string;
    solUsdValue: number | null;
    solUsdLabel: string;
    tokenCount: number;
    tokens: PortfolioTokenRow[];
    // Open Meteora DLMM liquidity positions. Deposited funds that sit outside the
    // spot balances — surfaced here so LP-locked SOL/tokens don't look "lost".
    positions: PortfolioPositionRow[];
    totalUsdValue: number | null;
    totalUsdLabel: string;
    pricesIncomplete: boolean;
}

/** Compute USD values for a wallet overview in code, so the model never has to do the math itself. */
async function computeWalletUsd(
    overview: Awaited<ReturnType<typeof getWalletOverview>>,
) {
    const mints = [NATIVE_SOL_MINT, ...overview.tokens.map((t) => t.mint)];
    let prices: Awaited<ReturnType<typeof getTokenPrices>> = [];
    try {
        prices = await getTokenPrices(mints);
    } catch {
        prices = [];
    }
    const priceOf = (mint: string) => {
        const p = prices.find((x) => x.mint === mint);
        return p ? parseFloat(p.price) : null;
    };
    const solPrice = priceOf(NATIVE_SOL_MINT);
    const solUsd = solPrice !== null ? overview.solBalance * solPrice : null;
    const tokens = overview.tokens.map((t) => {
        const price = priceOf(t.mint);
        return {
            ...t,
            usdPrice: price,
            usdValue: price !== null ? t.amount * price : null,
        };
    });
    const anyMissing =
        solPrice === null || tokens.some((t) => t.usdValue === null);
    const totalUsd = tokens.reduce(
        (sum, t) => sum + (t.usdValue ?? 0),
        solUsd ?? 0,
    );
    return {
        ...overview,
        tokens,
        solUsdValue: solUsd,
        totalUsdValue: anyMissing ? null : totalUsd,
        pricesIncomplete: anyMissing,
    };
}

/** Build a deterministic, fully-formatted portfolio card so numbers never depend on the model. */
function buildPortfolioView(
    overview: Awaited<ReturnType<typeof computeWalletUsd>>,
    walletAddress: string,
    liquidityPositions: Awaited<ReturnType<typeof getAllUserPositions>> = [],
): PortfolioView {
    const usd = (v: number | null): string =>
        v === null ? "unavailable" : `$${v.toFixed(2)}`;

    const tokens: PortfolioTokenRow[] = overview.tokens.map((t) => ({
        symbol: t.symbol || `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`,
        name: distinctTokenName(t.symbol, t.name),
        logo: t.logo,
        mint: t.mint,
        amount: t.amount,
        amountLabel: `${t.amountString ?? t.amount}`,
        usdValue: t.usdValue,
        usdLabel: usd(t.usdValue),
    }));

    const positions: PortfolioPositionRow[] = liquidityPositions.map((p) => {
        // Show only the non-zero deposited sides, then the refundable rent (the
        // bulk of the value for tiny deposits), so the amount matches the value.
        const parts: string[] = [];
        if (Number(p.amountX) > 0) parts.push(`${p.amountX} ${p.tokenXSymbol}`);
        if (Number(p.amountY) > 0) parts.push(`${p.amountY} ${p.tokenYSymbol}`);
        if (p.rentSol > 0) parts.push(`${p.rentSol.toFixed(4)} SOL rent`);
        return {
            poolAddress: p.poolAddress,
            poolName: p.poolName,
            pairLabel: `${p.tokenXSymbol} / ${p.tokenYSymbol}`,
            amountLabel: parts.join(" · ") || "—",
            usdLabel:
                p.valueUsd !== null
                    ? `$${Number(p.valueUsd).toFixed(2)}`
                    : "unavailable",
        };
    });

    // Value locked in liquidity positions counts toward the wallet's total, so
    // the headline reflects LP-deposited funds instead of dropping them.
    const positionsUsd = liquidityPositions.reduce(
        (sum, p) => sum + (p.valueUsd !== null ? Number(p.valueUsd) : 0),
        0,
    );
    const combinedTotal =
        overview.totalUsdValue === null
            ? null
            : overview.totalUsdValue + positionsUsd;
    const partialTotal =
        (overview.totalUsdValue === null
            ? sumKnown(overview)
            : overview.totalUsdValue) + positionsUsd;

    return {
        walletAddress,
        solBalance: overview.solBalance,
        solBalanceLabel: `${overview.solBalance.toFixed(4)} SOL`,
        solLogo:
            "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
        solUsdValue: overview.solUsdValue,
        solUsdLabel: usd(overview.solUsdValue),
        tokenCount: overview.tokenCount,
        tokens,
        positions,
        totalUsdValue: combinedTotal,
        totalUsdLabel: overview.pricesIncomplete
            ? `${usd(partialTotal)} (partial)`
            : usd(combinedTotal),
        pricesIncomplete: overview.pricesIncomplete,
    };
}

/** Sum of the USD values we do have, used to show a partial total when some prices are missing. */
function sumKnown(
    overview: Awaited<ReturnType<typeof computeWalletUsd>>,
): number {
    const tokenSum = overview.tokens.reduce((s, t) => s + (t.usdValue ?? 0), 0);
    return tokenSum + (overview.solUsdValue ?? 0);
}

const SYSTEM_PROMPT = `You are Solens, a friendly and knowledgeable AI crypto assistant on Solana. You help users understand their wallet, assets, and the Solana ecosystem.

When users ask about their wallet or assets, use the available tools to fetch real-time data. Present information clearly and concisely. Format numbers nicely (e.g. 1.234 SOL). If a user has tokens, list them with their amounts.

Formatting: NEVER use Markdown tables (pipe "|" and "---" rows) — the chat UI does not render them and they show as raw text. When presenting a plan, allocation, breakdown, or any tabular data, use a Markdown bullet list instead, one item per line (e.g. "- SOL — $0.50 (0.0068 SOL)").

You can help users with:
0. Transferring SOL or SPL tokens to another wallet - use transfer_sol or transfer_token tools
1. Token swaps using Jupiter DEX - use the initiate_swap tool
2. Providing liquidity on Meteora DLMM pools - use search_meteora_pools to find pools, then add_liquidity to deposit
3. Removing liquidity from Meteora pools - use get_user_positions to find positions, then remove_liquidity to withdraw
4. Launching new tokens on Bags.fm - use launch_token tool
5. Checking token info (creators, lifetime fees) - use get_bags_token_info tool
6. Checking and claiming fees from Bags token launches - use get_claimable_fees and claim_fees tools
7. Prediction markets via Jupiter - search events, place bets on outcomes, view positions, sell positions, claim winnings
NFTs are NOT supported. If the user asks to buy, sell, list or view NFTs, say plainly that Solens doesn't support NFTs right now. Never treat a token ticker as an NFT collection: "buy <TICKER>" always means a token swap (initiate_swap), never an NFT purchase.
9. Trending tokens - use get_trending_tokens to show the hottest / most-traded Solana tokens (memecoins and alts) with live price and 24h change

When showing trending tokens:
- ALWAYS call get_trending_tokens. NEVER make up token names, prices, or percentages.
- Present them as a short ranked list with symbol, price, and 24h change. Add a one-line "not financial advice" caution because many are low-liquidity and volatile.
- To let the user buy one, they can tap a Buy button or ask to swap; use initiate_swap with the token's exact mint.

ALWAYS fetch fresh data. Every time the user asks about their wallet, portfolio, balance, holdings, tokens, positions, or prices, you MUST call the relevant tool again and answer only from that fresh result. NEVER reuse balances, holdings, amounts, or prices from earlier in the conversation, even if they asked moments ago.

For any portfolio / balance / "total value" request, call get_wallet_overview (a single call). The app renders the balances and USD values as a portfolio card from exact computed data, so keep your reply to a brief intro and do NOT restate the SOL balance, token amounts, or dollar values in text (the card already shows them accurately).

When the user asks you to ANALYZE their portfolio, SUGGEST investments, asks "what should I invest in", "how do I grow my portfolio", or wants ideas/opportunities:
- First call get_wallet_overview to see their current holdings, AND call search_meteora_pools (e.g. with "SOL-USDC" or a bluechip pair) to surface two or three REAL liquidity pools with their live APR and TVL.
- Then write a SHORT analysis (a few sentences): note how concentrated their holdings are, then give 2–3 concrete, actionable suggestions — for example diversifying a slice into bluechips (you can offer to build_portfolio a basket) and/or providing liquidity in a specific named pool you just fetched (name it with its APR). Only mention pools/tokens that a tool returned this turn; never invent APRs, names, or numbers.
- Do NOT restate their exact balances or dollar values in the text (the portfolio card shows those) — spend your words on the analysis and suggestions. Add a one-line "not financial advice" caution.

ALWAYS use a tool to perform actions. For any swap, transfer, liquidity, launch, or prediction request you MUST call the matching tool (e.g. initiate_swap) BEFORE describing it. NEVER state a swap quote, estimated output, or "confirm in the UI" unless a tool returned that data in this same turn. If the user says "try again", "retry", or "do it again" after an action, call the tool again to build a fresh transaction.

Token naming: jupUSD (also written JupUSD, mint JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD) is Jupiter's USD stablecoin worth about $1. It is NOT the same as JUP (the governance token, mint JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN). When the user says jupUSD, never substitute JUP, and pass "jupUSD" as the token symbol.

When showing a swap quote, clearly display:
- What they're swapping (amount + token)
- What they'll receive
- Then tell them to confirm the swap in the UI
- initiate_swap takes EITHER 'amount' (in input-token units) OR 'amountUsd' (a dollar value). If the user gives a token amount (e.g. "swap 0.1 SOL"), pass amount=0.1. If the user gives a dollar amount (e.g. "swap $6 of SOL" or "$2.5 worth of SOL"), pass amountUsd=6 (or 2.5) and DO NOT pass amount — the backend converts dollars to the right token amount with a live price. Never compute the token amount from a dollar value yourself. Pass exactly one of the two.
- If a swap request includes an explicit mint address (e.g. "Swap 0.05 SOL for FOO (mint: <mint>)"), pass that exact mint string as the outputToken so the correct token is bought.
- Never say a swap is ready or present a quote unless initiate_swap returned success. If it returned an error, state the error plainly and do not invent numbers.

Wrapping / unwrapping SOL (SOL ↔ WSOL): SOL and Wrapped SOL (WSOL) are the SAME asset with the SAME mint, so there is NO swap route between them. Whenever the user wants to convert between SOL and WSOL — e.g. "wrap SOL", "swap SOL to wSOL", "convert 25% of my SOL to WSOL", "unwrap my WSOL", "turn WSOL back into SOL" — call the wrap_sol tool (direction "wrap" for SOL→WSOL, "unwrap" for WSOL→SOL), NEVER initiate_swap. Do not tell the user it can't be done. For a wrap, pass amount (in SOL) or amountUsd; for an unwrap, pass no amount (it unwraps the whole WSOL balance).

When the user asks to "build", "create", or "diversify" a portfolio for a dollar amount (e.g. "build my portfolio worth $50", "diversify $20"):
- Call build_portfolio with amountUsd (and a preset or token list if they specified one). Do NOT just call initiate_swap into a single token — that is not building a portfolio.
- Present the returned allocation plan (each token and its dollar slice). Then ask the user to confirm they want to execute it.
- When the user confirms, call execute_portfolio with the SAME amountUsd, tokens, and fundToken. This hands the whole plan to the UI, which walks the user through confirming each swap in order. Do NOT call initiate_swap yourself for the legs, and do NOT describe individual swaps — execute_portfolio + the UI handle every leg.

Splitting / multiswap (spreading one dollar amount across SEVERAL named tokens in a single request, e.g. "split $2 into SOL, JUP and WSOL", "swap $10 across A/B/C", "multiswap $20 to X,Y,Z"):
- Call execute_portfolio with amountUsd = the total, tokens = the list of tokens, and fundToken = the token being spent (default USDC). NEVER call initiate_swap with the full amount into just the first token — that would ignore the split. execute_portfolio divides the amount equally and the UI runs each leg.
- initiate_swap is ONLY for a single-token swap (one input → one output). Any request naming two or more destination tokens for one budget is a split → execute_portfolio.

Consolidating / many-to-one (funneling SEVERAL of the user's tokens INTO a single destination token, e.g. "swap my USDC, BONK and JUP into SOL", "swap my $0.5 USDC and $0.5 JUP into SOL", "sell all my tokens into SOL", "consolidate/convert my holdings into USDC", "turn my dust into SOL"):
- Call consolidate_tokens ONCE with inputTokens = ALL the tokens to sell (as one array) and outputToken = the single destination (default SOL). If the user gave a per-token dollar amount (e.g. "$0.5 USDC and $0.5 JUP"), pass amountsUsd as an array aligned 1:1 with inputTokens (e.g. inputTokens=["USDC","JUP"], amountsUsd=[0.5,0.5]) — do NOT convert the amount to token units yourself. Otherwise (no amounts given) it sells the FULL balance of each input. For "sell/convert everything", pass an empty inputTokens array (it will use every token the wallet holds).
- CRITICAL: naming 2+ source tokens for one destination is ALWAYS a single consolidate_tokens call, NEVER two-or-more separate initiate_swap calls. Only the FIRST action tool call per turn is honored — every action tool call after it is silently ignored (the transaction lock), so calling initiate_swap once per token will swap only the first token named and drop the rest without a clear error. If you are about to call initiate_swap and the user named more than one source token, stop and call consolidate_tokens instead.
- Direction is the OPPOSITE of a split: execute_portfolio spreads ONE token across MANY (1 → many); consolidate_tokens gathers MANY into ONE (many → 1). Do NOT invert them, and do NOT call execute_portfolio for a many-to-one request. initiate_swap remains for a single input → single output only.

When showing USD values:
- Use the usdValue, usdPrice, solUsdValue, and totalUsdValue fields returned by get_sol_balance and get_wallet_overview. These are computed exactly in code. Do not round a unit price first and then multiply yourself.
- If a tool reports pricesIncomplete or a null usdValue, tell the user the USD value is unavailable right now rather than estimating it.

When helping with Meteora liquidity:
- First search for the pool using search_meteora_pools with the token pair name (e.g. "SOL-USDC")
- Show pool details: name, TVL, APR, current price, bin step
- For adding liquidity, specify the pool address, the token symbol the user wants to deposit, and a specific amount. A deposit amount is REQUIRED — if the user didn't give one, ask how much they want to deposit rather than guessing a number. The backend calculates the matching amount for the other token from the pool's current price.
- A DLMM position needs BOTH of the pool's tokens (e.g. a SOL-USDC pool needs some SOL AND some USDC). If the user only holds one of them, add_liquidity returns a clear error explaining what they're missing and suggesting they swap into the other token first — relay that message and offer to do the swap.
- For checking positions: just call get_user_positions once — it automatically scans transaction history to find all positions. Do NOT search pools first or call it multiple times.
- For removing liquidity, first use get_user_positions with the pool address to find the user's positions, then call remove_liquidity with the position address
- Liquidity is added using a Spot strategy around the active bin (current price)
- Opening a new liquidity position holds back about 0.06 SOL as rent (refundable when the position is closed) on top of the tokens being deposited. If the user doesn't have enough SOL for the full deposit, add_liquidity AUTO-SIZES the deposit down to the largest amount that fits and returns adjusted:true — when that happens, tell the user their deposit was reduced to fit their available SOL and to review the amounts on the confirmation card. If add_liquidity instead returns an error (not-enough-SOL, missing the other token, or any other), output the tool's error message VERBATIM as your reply — do not paraphrase, summarize, round, or change any number. Never invent a balance or minimum.
- Always tell the user to confirm the transaction in the UI

When helping with Bags token launches:
- To launch a token, you need: name, symbol, description, and an image URL. Optionally twitter/website/telegram links.
- The launch flow: 1) create token metadata, 2) create fee share config, 3) create launch transaction, 4) user signs
- The launch_token tool handles all steps and returns a transaction for the user to confirm
- For token info, use get_bags_token_info with the token mint address to see creators and lifetime fees
- For claimable fees, use get_claimable_fees to see unclaimed revenue from token launches
- For claiming, use claim_fees which builds claim transactions for the user to sign

When helping with prediction markets:
- Use search_prediction_events to find events by keyword or browse by category (crypto, sports, politics, esports, culture, economics, tech)
- Show event titles, market prices (YES/NO), and implied probabilities
- CRITICAL: Each market has a unique marketId (e.g. "POLY-1928733-0"). You MUST pass the EXACT marketId from the search results to buy_prediction. NEVER use event titles, numbers, or slugs as the marketId.
- To place a bet: use buy_prediction with the exact marketId string, side (YES or NO), and amountUsd (minimum $5). Bets are paid with USDC or jupUSD and the backend automatically uses whichever the user has enough of (USDC preferred), so never tell the user they lack USDC without accounting for jupUSD.
- IMPORTANT — bet sizing: pass the EXACT dollar amount the user asked for as amountUsd (e.g. "bet $25 NO" → amountUsd=25). Do NOT shrink it toward the minimum. If the user does not state an amount, ASK them how much they want to bet (in USD) — never silently default to $5 (the minimum). There is no maximum beyond the user's stablecoin balance.
- Use get_prediction_positions to see the user's open positions with P&L
- Use sell_prediction to close/sell a position (sells all contracts)
- Use claim_prediction to claim winnings from a settled market
- Price = probability. 70¢ YES = 70% chance. If you buy YES at 70¢ and YES wins, profit is 30¢ per contract. Losing contracts expire worthless.
- Each winning contract pays out exactly $1.00 with no claim fees.
- When showing markets to users, always include the marketId so they can reference it.

- AVOID short-lived markets (5-15 minute windows like "Bitcoin Up or Down - April 11, 1:35PM-1:40PM ET") — these often fail because the keeper can't fill them in time.
- IMPORTANT: The minimum bet size is $5. Orders under $5 will not be filled by the keeper. If the user tries to bet less than $5, tell them the minimum is $5.

Always be helpful, accurate, and concise.`;

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "get_wallet_address",
            description:
                "Returns the user's Solana wallet address. Use when the user asks for their address or public key.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "get_sol_balance",
            description:
                "Gets the SOL balance of the user's wallet. Use when the user asks about their SOL balance or funds.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "get_token_accounts",
            description:
                "Gets all SPL token holdings in the user's wallet. Use when the user asks about their tokens, assets, or portfolio.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "get_wallet_overview",
            description:
                "Gets a full overview of the wallet: SOL balance, all tokens, and token count. Use when the user wants a summary or full portfolio view.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "get_token_price",
            description:
                "Gets the current USD price of one or more tokens. Pass token symbols like SOL, USDC, BONK, JUP, etc.",
            parameters: {
                type: "object",
                properties: {
                    tokens: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Array of token symbols to get prices for (e.g. ['SOL', 'USDC', 'BONK'])",
                    },
                },
                required: ["tokens"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "transfer_sol",
            description:
                "Prepares a SOL transfer transaction from the user's wallet to another Solana address. Use when the user asks to send/transfer SOL.",
            parameters: {
                type: "object",
                properties: {
                    toAddress: {
                        type: "string",
                        description: "Recipient Solana wallet address.",
                    },
                    amountSOL: {
                        type: "number",
                        description:
                            "Amount of SOL to transfer (e.g. 0.25). Omit when sendAll is true.",
                    },
                    sendAll: {
                        type: "boolean",
                        description:
                            "Set to true when the user asks to send the maximum available SOL balance. A rent-exemption and fee reserve is kept.",
                    },
                },
                required: ["toAddress"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "transfer_token",
            description:
                "Prepares an SPL token transfer transaction from the user's wallet to another Solana address. If the user asks to send all of a token, set sendAll to true instead of estimating the amount.",
            parameters: {
                type: "object",
                properties: {
                    toAddress: {
                        type: "string",
                        description: "Recipient Solana wallet address.",
                    },
                    token: {
                        type: "string",
                        description:
                            "Token symbol or mint address to transfer (e.g. USDC, BONK, JUP).",
                    },
                    amount: {
                        type: "number",
                        description:
                            "Amount of token to transfer in human-readable units. Omit only when sendAll is true.",
                    },
                    sendAll: {
                        type: "boolean",
                        description:
                            "Set to true when the user asks to send the full token balance.",
                    },
                },
                required: ["toAddress", "token"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_trending_tokens",
            description:
                "Gets the current trending / most-traded Solana tokens (memecoins and alts) with live price, 24h change, market cap, liquidity, and holder count. Use when the user asks about trending tokens, trending memecoins, top movers, or what's hot right now. Returns real data from Jupiter; never invent token names or prices.",
            parameters: {
                type: "object",
                properties: {
                    limit: {
                        type: "number",
                        description:
                            "How many tokens to return (default 10, max 20).",
                    },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "initiate_swap",
            description:
                "Initiates a token swap on Jupiter DEX. Use when the user wants to swap/exchange/trade one token for another. Returns a transaction for the user to approve. Examples: 'swap 0.1 SOL for USDC', 'buy 10 USDC with SOL', 'trade my BONK for SOL'.",
            parameters: {
                type: "object",
                properties: {
                    inputToken: {
                        type: "string",
                        description:
                            "The token symbol to swap FROM (e.g. 'SOL', 'USDC', 'BONK')",
                    },
                    outputToken: {
                        type: "string",
                        description:
                            "The token symbol to swap TO (e.g. 'USDC', 'SOL', 'JUP')",
                    },
                    amount: {
                        type: "number",
                        description:
                            "The amount of the INPUT token to swap, in human-readable token units (e.g. 0.1 for 0.1 SOL). Use this ONLY when the user specifies an amount in tokens. Do NOT compute this from a dollar amount yourself — use amountUsd instead.",
                    },
                    amountUsd: {
                        type: "number",
                        description:
                            "The dollar value to swap, in USD (e.g. 2.5 for '$2.5 worth of SOL'). Use this whenever the user specifies a dollar amount. The backend converts USD to the correct input-token amount using a live price, so never divide by price yourself.",
                    },
                },
                required: ["inputToken", "outputToken"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "wrap_sol",
            description:
                "Wraps native SOL into Wrapped SOL (WSOL), or unwraps WSOL back to native SOL. SOL and WSOL are the SAME asset (same mint), so there is NO swap route between them — use THIS tool, never initiate_swap, whenever the user wants to convert between SOL and WSOL. Examples: 'wrap 0.1 SOL', 'convert SOL to WSOL', 'swap 25% of my SOL to wSOL', 'wrap SOL', 'unwrap my WSOL', 'convert WSOL back to SOL'. For a wrap, provide the amount (in SOL) or amountUsd. For an unwrap, no amount is needed — it unwraps the entire WSOL balance.",
            parameters: {
                type: "object",
                properties: {
                    direction: {
                        type: "string",
                        enum: ["wrap", "unwrap"],
                        description:
                            "'wrap' converts native SOL → WSOL; 'unwrap' converts WSOL → native SOL. If the user asks to go from SOL to WSOL, use 'wrap'. If from WSOL to SOL, use 'unwrap'.",
                    },
                    amount: {
                        type: "number",
                        description:
                            "For 'wrap' only: amount of SOL to wrap, in SOL units (e.g. 0.1). Use ONLY when the user gives a token amount. Omit for 'unwrap'.",
                    },
                    amountUsd: {
                        type: "number",
                        description:
                            "For 'wrap' only: dollar value of SOL to wrap (e.g. 5 for '$5 of SOL'). The backend converts USD → SOL with a live price. Omit for 'unwrap'.",
                    },
                },
                required: ["direction"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "build_portfolio",
            description:
                "Builds a diversified portfolio PLAN (no transaction): splits a dollar amount across several reputable Solana tokens and returns the allocation. Use when the user asks to 'build/create/diversify my portfolio' for a dollar amount (e.g. 'build my portfolio worth $50', 'diversify $20 into a basket'). Present the returned plan and ask the user to confirm. When they confirm, call execute_portfolio (NOT initiate_swap) to run all the legs.",
            parameters: {
                type: "object",
                properties: {
                    amountUsd: {
                        type: "number",
                        description:
                            "Total dollar amount to invest, in USD (e.g. 50 for $50).",
                    },
                    preset: {
                        type: "string",
                        enum: ["bluechip", "balanced", "degen"],
                        description:
                            "Optional risk preset. bluechip = SOL+JUP; balanced = SOL+JUP+JTO+BONK; degen = SOL+BONK+WIF. Defaults to balanced.",
                    },
                    tokens: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Optional explicit list of token symbols to split across (overrides preset). e.g. ['SOL','JUP','JTO'].",
                    },
                    fundToken: {
                        type: "string",
                        description:
                            "Optional token to fund the buys with (the token being spent). Defaults to USDC. Use 'SOL' if the user wants to build out of their SOL.",
                    },
                },
                required: ["amountUsd"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "execute_portfolio",
            description:
                "Executes a multi-token split in one go: splits a dollar amount equally across the given tokens and hands the whole plan to the UI, which then swaps the funding token into each basket token one after another (the user confirms each swap in turn). Call this — NOT initiate_swap — whenever the user wants to spread a dollar amount across MORE THAN ONE token: e.g. after they confirm a build_portfolio plan, or for direct requests like 'split $2 into SOL, JUP and WSOL', 'swap $10 across A/B/C', 'multiswap $20 to X,Y,Z'. Never emulate a split by calling initiate_swap with the full amount into a single token. Use initiate_swap only for a single-token swap.",
            parameters: {
                type: "object",
                properties: {
                    amountUsd: {
                        type: "number",
                        description:
                            "Total dollar amount to split across the tokens, in USD (e.g. 2 for $2).",
                    },
                    tokens: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "The token symbols (or mint addresses) to split across, e.g. ['SOL','JUP','WSOL']. Provide this OR a preset.",
                    },
                    preset: {
                        type: "string",
                        enum: ["bluechip", "balanced", "degen"],
                        description:
                            "Optional risk preset used only when the user didn't name specific tokens. bluechip = SOL+JUP; balanced = SOL+JUP+JTO+BONK; degen = SOL+BONK+WIF.",
                    },
                    fundToken: {
                        type: "string",
                        description:
                            "Optional token to spend (the funding token). Defaults to USDC. Use 'SOL' to build out of the user's SOL.",
                    },
                },
                required: ["amountUsd"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "consolidate_tokens",
            description:
                "Consolidates SEVERAL of the user's tokens into ONE destination token (many → 1): swaps each named input token into the same output. Call this — NOT initiate_swap or execute_portfolio — whenever the user wants to funnel MULTIPLE source tokens into a single token: e.g. 'swap my USDC, BONK and JUP into SOL', 'sell all my tokens into SOL', 'consolidate/convert my holdings into USDC', 'turn my dust into SOL'. By default it sells the FULL balance of each input. Direction matters: execute_portfolio spreads ONE token across many (1 → many); consolidate_tokens gathers many INTO one (many → 1). initiate_swap is for a single input → single output.",
            parameters: {
                type: "object",
                properties: {
                    inputTokens: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "The token symbols (or mint addresses) to SELL, e.g. ['USDC','BONK','JUP']. Omit or leave empty together with sellAll=true to sell every token the wallet holds.",
                    },
                    outputToken: {
                        type: "string",
                        description:
                            "The single destination token to swap everything into. Defaults to SOL.",
                    },
                    sellAll: {
                        type: "boolean",
                        description:
                            "Sell the full balance of each input token. Defaults to true. Set false only when the user gave specific per-token amounts.",
                    },
                    amounts: {
                        type: "array",
                        items: { type: "number" },
                        description:
                            "Optional per-input token amounts (token units), aligned 1:1 with inputTokens. Use ONLY when the user specified exact token amounts instead of selling everything.",
                    },
                    amountsUsd: {
                        type: "array",
                        items: { type: "number" },
                        description:
                            "Optional per-input dollar amounts, aligned 1:1 with inputTokens. Use ONLY when the user specified dollar amounts per input instead of selling everything.",
                    },
                },
                required: ["inputTokens"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_meteora_pools",
            description:
                "Searches for Meteora DLMM liquidity pools by token pair. Use when the user asks about Meteora pools, wants to provide liquidity, or asks about LP opportunities. Returns pool details including TVL, APR, and current price.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "Search query - typically the token pair like 'SOL-USDC', 'SOL USDC', or a pool address",
                    },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_user_positions",
            description:
                "Gets the user's Meteora DLMM liquidity positions by scanning their recent transaction history. Call this ONCE with NO parameters to find all positions. Do NOT call it multiple times with different pool addresses — a single call finds everything. Do NOT call search_meteora_pools before this.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "add_liquidity",
            description:
                "Adds liquidity to a Meteora DLMM pool. Creates a new position with Spot strategy around the current price. Use after searching for pools with search_meteora_pools. Only specify the token and amount the user wants to deposit — the backend will automatically calculate the matching amount for the other side based on the pool's current price. The user must confirm the transaction in the UI.",
            parameters: {
                type: "object",
                properties: {
                    poolAddress: {
                        type: "string",
                        description:
                            "The Meteora pool address (from search_meteora_pools results)",
                    },
                    depositToken: {
                        type: "string",
                        description:
                            "The symbol of the token the user wants to deposit (e.g. 'USDC', 'SOL')",
                    },
                    depositAmount: {
                        type: "number",
                        description:
                            "Amount of the deposit token in human-readable units (e.g. 0.5 for 0.5 USDC)",
                    },
                },
                required: ["poolAddress", "depositToken", "depositAmount"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "remove_liquidity",
            description:
                "Removes liquidity from a Meteora DLMM pool position. Use after getting user positions with get_user_positions. Removes 100% of liquidity from the position by default and claims fees.",
            parameters: {
                type: "object",
                properties: {
                    poolAddress: {
                        type: "string",
                        description: "The Meteora pool address",
                    },
                    positionAddress: {
                        type: "string",
                        description:
                            "The position address (from get_user_positions results)",
                    },
                    percentage: {
                        type: "number",
                        description:
                            "Percentage of liquidity to remove (1-100). Defaults to 100.",
                    },
                },
                required: ["poolAddress", "positionAddress"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "launch_token",
            description:
                "Launches a new token on Solana via Bags.fm. Handles the full flow: creates token metadata, fee share config, and launch transaction. The user must confirm the transaction in the UI. Requires: name, symbol, description, imageUrl. Optional: twitter, website, telegram URLs, and initialBuySOL (SOL amount for initial buy, default 0).",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Token name (1-32 characters)",
                    },
                    symbol: {
                        type: "string",
                        description:
                            "Token symbol/ticker (e.g. 'DOGE', 'PEPE')",
                    },
                    description: {
                        type: "string",
                        description: "Token description",
                    },
                    imageUrl: {
                        type: "string",
                        description: "URL to the token image/logo",
                    },
                    twitter: {
                        type: "string",
                        description: "Twitter/X URL for the token (optional)",
                    },
                    website: {
                        type: "string",
                        description: "Website URL for the token (optional)",
                    },
                    telegram: {
                        type: "string",
                        description: "Telegram URL for the token (optional)",
                    },
                    initialBuySOL: {
                        type: "number",
                        description:
                            "Amount of SOL for initial buy (optional, default 0). E.g. 0.1 for 0.1 SOL initial purchase.",
                    },
                },
                required: ["name", "symbol", "description", "imageUrl"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_bags_token_info",
            description:
                "Gets information about a token launched via Bags.fm, including creators, lifetime fees earned, and claim statistics. Use when the user asks about a specific token's launch info or revenue.",
            parameters: {
                type: "object",
                properties: {
                    tokenMint: {
                        type: "string",
                        description: "The token's mint address (public key)",
                    },
                },
                required: ["tokenMint"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_claimable_fees",
            description:
                "Gets all claimable fee positions from Bags.fm token launches for the user's wallet. Shows unclaimed revenue from tokens the user created or has fee share in.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "claim_fees",
            description:
                "Claims fees from a specific Bags.fm token launch position. Returns transactions for the user to sign. Use after get_claimable_fees to know which positions have claimable fees.",
            parameters: {
                type: "object",
                properties: {
                    tokenMint: {
                        type: "string",
                        description: "The token mint address to claim fees for",
                    },
                    virtualPoolAddress: {
                        type: "string",
                        description:
                            "The virtual pool address (from get_claimable_fees results)",
                    },
                    programId: {
                        type: "string",
                        description:
                            "The fee share program ID (from get_claimable_fees results)",
                    },
                    isCustomFeeVault: {
                        type: "boolean",
                        description:
                            "Whether this uses a custom fee vault (from get_claimable_fees results)",
                    },
                },
                required: ["tokenMint", "virtualPoolAddress", "programId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_prediction_events",
            description:
                "Searches for prediction market events on Jupiter. Returns events with their markets including marketId (like 'POLY-1928733-0'), prices, and probabilities. IMPORTANT: When the user wants to buy, you MUST use the exact marketId string from the results. Categories: crypto, sports, politics, esports, culture, economics, tech.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "Search keyword (e.g. 'bitcoin', 'NBA', 'election'). If empty, browses by category.",
                    },
                    category: {
                        type: "string",
                        description:
                            "Category filter: crypto, sports, politics, esports, culture, economics, tech. Used when browsing without a query.",
                    },
                    filter: {
                        type: "string",
                        description:
                            "Status filter: 'new' (last 24h), 'live' (in progress), 'trending'. Optional.",
                    },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "buy_prediction",
            description:
                "Places a buy order on a prediction market. Buys YES or NO contracts on an event outcome. Returns a transaction for the user to sign. Bets are paid with USDC or jupUSD: by default the backend automatically uses whichever the user has enough of (USDC preferred), so do NOT tell the user they have insufficient USDC without considering jupUSD. Amount is in USD (e.g. 5.0 = $5). Minimum $5. IMPORTANT: You must use the exact marketId from search results (e.g. 'POLY-1928733-0'), NOT the event title or number.",
            parameters: {
                type: "object",
                properties: {
                    marketId: {
                        type: "string",
                        description:
                            "The exact marketId string from search_prediction_events results (e.g. 'POLY-1928733-0'). Must be the real ID, not a title or number.",
                    },
                    side: {
                        type: "string",
                        enum: ["YES", "NO"],
                        description: "Which side to buy: YES or NO",
                    },
                    amountUsd: {
                        type: "number",
                        description:
                            "Amount to spend in USD (e.g. 5.0 for $5.00). Minimum $5.00.",
                    },
                    payToken: {
                        type: "string",
                        enum: ["USDC", "jupUSD"],
                        description:
                            "Optional. The stablecoin to pay with. Only set this if the user explicitly asks to pay with a specific one; otherwise omit it and the backend auto-selects whichever has enough balance.",
                    },
                },
                required: ["marketId", "side", "amountUsd"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_prediction_positions",
            description:
                "Gets the user's open prediction market positions with P&L, contracts held, and market details. Use when the user asks about their bets or prediction positions.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "sell_prediction",
            description:
                "Sells/closes a prediction market position (sells all contracts). Returns a transaction for the user to sign. Use after get_prediction_positions to find positions to sell.",
            parameters: {
                type: "object",
                properties: {
                    positionPubkey: {
                        type: "string",
                        description:
                            "The position's public key (from get_prediction_positions results)",
                    },
                },
                required: ["positionPubkey"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "claim_prediction",
            description:
                "Claims the payout from a winning prediction market position. Each winning contract pays $1.00 with no fees. Use after get_prediction_positions shows a position with claimable=true.",
            parameters: {
                type: "object",
                properties: {
                    positionPubkey: {
                        type: "string",
                        description:
                            "The position's public key (from get_prediction_positions results, must have claimable=true)",
                    },
                },
                required: ["positionPubkey"],
            },
        },
    },
];

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}

// Response type that can include an action for the frontend
interface ChatResponse {
    message: string;
    quickReplies?: { label: string; prompt: string; group?: string }[];
    portfolio?: PortfolioView;
    action?:
        | {
              type: "transfer";
              transaction: string; // base64 unsigned transaction
              assetSymbol: string;
              amount: number;
              amountLabel?: string;
              toAddress: string;
          }
        | {
              type: "swap";
              transaction: string; // base64 VersionedTransaction
              requestId: string;
              inputToken: string;
              outputToken: string;
              amount: number;
              estimatedOutput: string | null;
          }
        | {
              type: "wrapSol";
              transaction: string; // base64 unsigned transaction
              direction: "wrap" | "unwrap";
              amount: number; // SOL amount wrapped/unwrapped
          }
        | {
              type: "addLiquidity";
              transactions: string[]; // base64-encoded transactions (partially signed)
              poolAddress: string;
              positionAddress: string;
              poolName: string;
              amountX: number;
              amountY: number;
              tokenXSymbol: string;
              tokenYSymbol: string;
          }
        | {
              type: "removeLiquidity";
              transactions: string[]; // base64-encoded transactions
              poolAddress: string;
              positionAddress: string;
          }
        | {
              type: "launchToken";
              transactions: string[]; // base58-encoded fee config transactions
              tokenName: string;
              tokenSymbol: string;
              tokenMint: string;
              launchParams?: {
                  ipfs: string;
                  configKey: string;
                  initialBuyLamports: number;
              };
          }
        | {
              type: "claimFees";
              transactions: string[]; // base58-encoded transactions to sign
              tokenMint: string;
          }
        | {
              type: "predictionOrder";
              transaction: string; // base64-encoded unsigned transaction
              marketId: string;
              side: "YES" | "NO";
              amountUsd: number;
              contracts: string;
              orderPubkey: string;
              marketTitle: string;
          }
        | {
              type: "sellPrediction";
              transaction: string; // base64-encoded unsigned transaction
              positionPubkey: string;
              marketTitle: string;
          }
        | {
              type: "claimPrediction";
              transaction: string; // base64-encoded unsigned transaction
              positionPubkey: string;
              payoutUsd: string;
              marketTitle: string;
          }
        | {
              type: "buyNFT";
              transaction: string; // base64
              tokenMint: string;
              price: number;
              nftName: string;
          }
        | {
              type: "listNFT";
              transaction: string; // base64
              tokenMint: string;
              price: number;
              nftName: string;
          };
    // A multi-leg swap plan (portfolio build / "split $X across A,B,C"). The UI
    // executes each leg in order, requesting a fresh quote and a confirmation per
    // leg. Distinct from `action` because it carries several swaps, not one tx.
    swapPlan?: {
        fundToken: string;
        totalUsd: number;
        legs: {
            symbol: string;
            outputMint: string;
            amountUsd?: number;
            // Present only on "consolidate" (many→1) legs: each leg sells a
            // different input token into the shared output. `rawAmount` is the
            // exact base-unit balance so "sell all" never over-/under-sizes.
            inputMint?: string;
            inputSymbol?: string;
            rawAmount?: string;
            inputDecimals?: number;
        }[];
    };
}

function generateQuickReplies(
    results: { name: string; result: unknown }[],
): { label: string; prompt: string; group?: string }[] {
    const replies: { label: string; prompt: string; group?: string }[] = [];

    for (const { name, result } of results) {
        const data = result as Record<string, unknown>;

        // Trending tokens → buy buttons (start a swap from SOL)
        if (name === "get_trending_tokens" && Array.isArray(data.tokens)) {
            const tokens = data.tokens as {
                symbol: string;
                mint: string;
                change24h: string;
            }[];
            for (const t of tokens.slice(0, 6)) {
                replies.push({
                    label: `Buy ${t.symbol} · ${t.change24h} 24h`,
                    prompt: `Swap 0.05 SOL for ${t.symbol} (mint: ${t.mint})`,
                });
            }
        }

        // Meteora pool search → buttons to select a pool
        if (name === "search_meteora_pools" && Array.isArray(data.pools)) {
            const pools = data.pools as {
                name: string;
                address: string;
                apr: string;
            }[];
            for (const pool of pools.slice(0, 6)) {
                replies.push({
                    label: `${pool.name} · ${pool.apr} APR`,
                    prompt: `Deposit into the ${pool.name} pool at ${pool.address}`,
                });
            }
        }

        // Prediction market search → YES/NO buttons per market
        if (name === "search_prediction_events" && Array.isArray(data.events)) {
            const events = data.events as {
                title: string;
                markets: {
                    marketId: string;
                    title: string;
                    yesPrice: string;
                    noPrice: string;
                }[];
            }[];
            for (const event of events.slice(0, 3)) {
                for (const market of event.markets.slice(0, 2)) {
                    const title =
                        market.title.length > 50
                            ? market.title.slice(0, 47) + "..."
                            : market.title;
                    replies.push({
                        group: event.title,
                        label: `YES ${market.yesPrice} · ${title}`,
                        prompt: `Bet YES on market ${market.marketId}`,
                    });
                    replies.push({
                        group: event.title,
                        label: `NO ${market.noPrice} · ${title}`,
                        prompt: `Bet NO on market ${market.marketId}`,
                    });
                }
            }
        }

        // Meteora user positions → remove buttons
        if (name === "get_user_positions" && Array.isArray(data.positions)) {
            const positions = data.positions as {
                poolName: string;
                poolAddress: string;
                positionAddress: string;
            }[];
            for (const pos of positions.slice(0, 5)) {
                replies.push({
                    label: `Remove from ${pos.poolName}`,
                    prompt: `Remove liquidity from position ${pos.positionAddress} in pool ${pos.poolAddress}`,
                });
            }
        }

        // Prediction positions → sell or claim buttons
        if (
            name === "get_prediction_positions" &&
            Array.isArray(data.positions)
        ) {
            const positions = data.positions as {
                positionPubkey: string;
                market: string;
                side: string;
                claimable: boolean;
                marketStatus: string;
            }[];
            for (const pos of positions.slice(0, 5)) {
                if (pos.claimable) {
                    replies.push({
                        label: `Claim · ${pos.market}`,
                        prompt: `Claim winnings from position ${pos.positionPubkey}`,
                    });
                } else if (pos.marketStatus === "open") {
                    replies.push({
                        label: `Sell ${pos.side} · ${pos.market}`,
                        prompt: `Sell my prediction position ${pos.positionPubkey}`,
                    });
                }
            }
        }

        // Claimable Bags fees → claim buttons
        if (name === "get_claimable_fees" && Array.isArray(data.positions)) {
            const positions = data.positions as {
                tokenMint: string;
                claimableSOL: string;
            }[];
            for (const pos of positions.slice(0, 5)) {
                replies.push({
                    label: `Claim ${pos.claimableSOL} SOL`,
                    prompt: `Claim fees from token ${pos.tokenMint}`,
                });
            }
        }
    }

    return replies.slice(0, 10);
}

export async function POST(request: NextRequest) {
    try {
        const {
            message,
            walletAddress,
            txSignerWalletAddress,
            history,
            chatChannel,
            telegramSigningMode,
        } = (await request.json()) as {
            message: string;
            walletAddress: string | null;
            /** When set (e.g. Telegram custodial), transfers/swaps use this wallet as fee payer / taker. */
            txSignerWalletAddress?: string | null;
            history: ChatMessage[];
            /** When "telegram", system prompt matches Telegram confirm flow. */
            chatChannel?: "telegram";
            telegramSigningMode?: "privy_server" | "custodial" | "none";
        };

        if (!message) {
            return NextResponse.json(
                { error: "Message is required" },
                { status: 400 },
            );
        }

        const txSigner =
            typeof txSignerWalletAddress === "string" &&
            txSignerWalletAddress.trim().length > 0
                ? txSignerWalletAddress.trim()
                : null;
        const spendWallet = (txSigner ?? walletAddress) as string;

        const transferToolConfirmPhrase =
            chatChannel === "telegram"
                ? telegramSigningMode === "privy_server" ||
                  telegramSigningMode === "custodial"
                    ? " Tap **Confirm** in Telegram to submit."
                    : " Open the Solens web app to sign (Telegram server signing is not active — set PRIVY_APP_SECRET and re-link, or enable custodial wallets)."
                : " Please confirm the transaction.";

        let systemContent = walletAddress
            ? `${SYSTEM_PROMPT}\n\nThe user's connected Solana wallet address is: ${walletAddress}. You have tools available to fetch their on-chain data, initiate swaps, and manage Meteora liquidity positions. Always use the tools when the user asks about their wallet, balance, assets, prices, wants to swap tokens, or wants to provide/remove liquidity.`
            : `${SYSTEM_PROMPT}\n\nThe user has not connected a wallet yet. If they ask about their wallet, assets, swaps, or liquidity, ask them to log in first.`;

        if (walletAddress && txSigner && txSigner !== walletAddress) {
            systemContent += `\n\nTelegram / custodial signing mode: portfolio and balances above refer to the linked wallet (${walletAddress}). SOL and SPL token *transfer* transactions are built for a separate Telegram signing wallet (${txSigner}). If the user wants to move funds that currently sit in the linked wallet, they must first send SOL or tokens from the linked wallet to the Telegram signing address, then ask to transfer again.`;
        }

        if (chatChannel === "telegram") {
            if (telegramSigningMode === "privy_server") {
                systemContent += `\n\nYou are replying inside the Telegram bot. Privy server signing is ON for this chat: SOL/SPL transfers from transfer_sol and transfer_token can be confirmed when the user taps **Confirm** in Telegram (no Privy popup or browser wallet for those transfers). Say clearly to tap Confirm below — do NOT tell them to open "wallet UI", Phantom, or the Privy signing modal for those transfers. Swaps, Meteora, Bags launches, prediction markets, and Magic Eden still require the Solens web app unless stated otherwise.`;
            } else if (telegramSigningMode === "custodial") {
                systemContent += `\n\nYou are replying inside the Telegram bot with a custodial Telegram signer. For SOL/SPL transfers, instruct the user to tap **Confirm** in Telegram — not an external wallet UI.`;
            } else if (telegramSigningMode === "none") {
                systemContent += `\n\nYou are replying inside the Telegram bot but Telegram-side signing is OFF (server missing PRIVY_APP_SECRET and/or Privy session token, and custodial signer not enabled). For SOL/SPL transfers after you prepare them, say honestly they must open the Solens web app to sign until an operator fixes env + re-link.`;
            }
        }

        console.log(
            "[chat] walletAddress:",
            walletAddress,
            "| txSigner:",
            txSigner,
            "| message:",
            message,
        );

        // Filter history to only valid messages with string content
        const validHistory = (history || [])
            .filter(
                (m) =>
                    m.content &&
                    typeof m.content === "string" &&
                    m.content.trim().length > 0,
            )
            .map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.content,
            }));

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: systemContent },
            ...validHistory,
            { role: "user", content: message },
        ];

        // Data questions must hit a tool fresh rather than reuse chat history.
        const DATA_INTENT_RE =
            /\b(portfolio|balances?|holdings?|net worth|positions?|how much|what do i (have|own)|price of|prices?|worth|my (tokens?|assets?|coins?|wallet|nfts?)|trending|memecoins?|top movers?|what'?s hot)\b/i;
        // Prediction/market browse intent should also re-fetch so the result has
        // markets to render YES/NO buttons from.
        const PREDICTION_INTENT_RE =
            /\b(prediction|predictions|bet|bets|betting|odds|markets?)\b/i;
        // Phrases that imply an action was prepared, used to detect a missing tool call.
        const UNBACKED_ACTION_RE =
            /(confirm (the )?(swap|transaction|transfer|order|listing)|swapping\b|you('| wi)ll receive|prepared (a|your) (swap|transfer|listing|order)|ready to (swap|sign|confirm))/i;

        const createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
            {
                model: MODEL,
                messages,
            };
        if (walletAddress) {
            createParams.tools = tools;
            // Force a fresh tool call for data lookups and prediction browsing so
            // stale history is never reused (and buttons always get generated).
            if (
                DATA_INTENT_RE.test(message) ||
                PREDICTION_INTENT_RE.test(message)
            ) {
                createParams.tool_choice = "required";
            }
        }

        let response = await createChatCompletion(createParams);

        let choice = response.choices[0];
        let pendingAction: ChatResponse["action"] | undefined;
        let pendingSwapPlan: ChatResponse["swapPlan"] | undefined;
        let portfolioView: PortfolioView | undefined;
        // Exact add_liquidity error text. Forced verbatim into the reply so the
        // model can't garble the balance/amount numbers (the source of the
        // confusing "0 SOL" messages).
        let liquidityError: string | undefined;
        let forcedActionRetryUsed = false;
        const toolResults: { name: string; result: unknown }[] = [];

        // If the model describes an action (swap/transfer/etc.) without calling a
        // tool, force one tool call so the confirm card is actually produced.
        const maybeForceAction = async (
            current: typeof choice,
        ): Promise<typeof choice> => {
            if (
                forcedActionRetryUsed ||
                !walletAddress ||
                pendingAction ||
                (current.message.tool_calls &&
                    current.message.tool_calls.length > 0)
            ) {
                return current;
            }
            const text = current.message.content || "";
            if (!UNBACKED_ACTION_RE.test(text)) return current;

            forcedActionRetryUsed = true;
            messages.push({ role: "assistant", content: text });
            messages.push({
                role: "user",
                content:
                    "You described an action but did not call a tool. Call the correct tool now (initiate_swap, transfer_sol, transfer_token, add_liquidity, buy_prediction, launch_token, etc.) to actually prepare it. Do not quote or describe the action again without calling the tool.",
            });
            const forced = await createChatCompletion({
                model: MODEL,
                messages,
                tools,
                tool_choice: "required",
            });
            return forced.choices[0];
        };

        choice = await maybeForceAction(choice);

        // Tool-call loop
        while (
            choice.message.tool_calls &&
            choice.message.tool_calls.length > 0
        ) {
            const toolCalls = choice.message.tool_calls;
            messages.push(choice.message);

            for (const toolCall of toolCalls) {
                if (toolCall.type !== "function") continue;

                let result: unknown;

                console.log(
                    "[chat] tool call:",
                    toolCall.function.name,
                    toolCall.function.arguments,
                );

                if (!walletAddress) {
                    result = {
                        error: "No wallet connected. Please log in first.",
                    };
                } else if (
                    (pendingAction || pendingSwapPlan) &&
                    (ACTION_TOOLS.has(toolCall.function.name) ||
                        toolCall.function.name === "execute_portfolio" ||
                        toolCall.function.name === "consolidate_tokens")
                ) {
                    // An action (single tx or a multi-leg swap plan) is already
                    // prepared this turn. Do not build another (a duplicate call can
                    // fail transiently and make the reply claim failure even though
                    // the card is valid).
                    result = {
                        success: true,
                        message:
                            "A transaction is already prepared and waiting for the user to confirm in the UI. Do not prepare another or say it failed.",
                    };
                } else {
                    switch (toolCall.function.name) {
                        case "get_wallet_address":
                            result = { address: walletAddress };
                            break;

                        case "get_sol_balance": {
                            const bal = await getSOLBalance(walletAddress);
                            let usdValue: number | null = null;
                            try {
                                const p = await getTokenPrices([
                                    NATIVE_SOL_MINT,
                                ]);
                                const sp = p.find(
                                    (x) => x.mint === NATIVE_SOL_MINT,
                                );
                                if (sp)
                                    usdValue = bal.sol * parseFloat(sp.price);
                            } catch {
                                // price unavailable; leave usdValue null
                            }
                            result = { ...bal, usdValue };
                            break;
                        }

                        // "Show my tokens" must render the same portfolio card as a
                        // full overview. When this case returned bare token accounts
                        // it set no card, and the prompt's "don't restate amounts in
                        // text" rule then left the holdings invisible — the
                        // intermittent "tokens are not showing" report.
                        case "get_token_accounts":
                        case "get_wallet_overview": {
                            try {
                                const [overview, liquidityPositions] =
                                    await Promise.all([
                                        computeWalletUsd(
                                            await getWalletOverview(
                                                walletAddress,
                                            ),
                                        ),
                                        // LP positions live outside the spot
                                        // balances; best-effort so a lookup
                                        // failure never breaks the portfolio card.
                                        getAllUserPositions(walletAddress).catch(
                                            () => [],
                                        ),
                                    ]);
                                portfolioView = buildPortfolioView(
                                    overview,
                                    walletAddress,
                                    liquidityPositions,
                                );
                                result = {
                                    ...overview,
                                    liquidityPositions,
                                };
                            } catch {
                                // A balances read failed after retries. Surface a
                                // retryable message rather than an empty wallet —
                                // never imply the user holds nothing on an error.
                                result = {
                                    error: "Couldn't fetch your balances right now (RPC hiccup). Ask to show the portfolio again in a moment.",
                                };
                            }
                            break;
                        }

                        case "get_token_price": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const tokens: string[] = args.tokens;
                            const mints: string[] = [];

                            for (const symbol of tokens) {
                                const mint = await resolveTokenMint(symbol);
                                if (mint) mints.push(mint);
                            }

                            if (mints.length === 0) {
                                result = {
                                    error: "Could not resolve any of the provided token symbols.",
                                };
                            } else {
                                const prices = await getTokenPrices(mints);
                                // Map back to symbols for readability
                                const priceMap: Record<string, string> = {};
                                for (let i = 0; i < tokens.length; i++) {
                                    const mint = await resolveTokenMint(
                                        tokens[i],
                                    );
                                    const priceInfo = prices.find(
                                        (p) => p.mint === mint,
                                    );
                                    if (priceInfo) {
                                        priceMap[tokens[i].toUpperCase()] =
                                            `$${priceInfo.price}`;
                                    }
                                }
                                result = { prices: priceMap };
                            }
                            break;
                        }

                        case "get_trending_tokens": {
                            try {
                                const args = JSON.parse(
                                    toolCall.function.arguments || "{}",
                                );
                                const limit = Math.min(
                                    Math.max(Number(args.limit) || 10, 1),
                                    20,
                                );
                                const tokens = await getTrendingTokens(
                                    "24h",
                                    limit,
                                );
                                if (tokens.length === 0) {
                                    result = {
                                        error: "Couldn't fetch trending tokens right now. Please try again in a moment.",
                                    };
                                    break;
                                }
                                result = {
                                    tokens: tokens.map((t, i) => ({
                                        rank: i + 1,
                                        symbol: t.symbol,
                                        name: t.name,
                                        mint: t.mint,
                                        price:
                                            t.usdPrice !== null
                                                ? `$${formatUsdPrice(t.usdPrice)}`
                                                : "N/A",
                                        change24h:
                                            t.priceChange24h !== null
                                                ? `${t.priceChange24h >= 0 ? "+" : ""}${t.priceChange24h.toFixed(1)}%`
                                                : "N/A",
                                        marketCap: formatCompactUsd(t.mcap),
                                        volume24h: formatCompactUsd(
                                            t.volume24h,
                                        ),
                                        liquidity: formatCompactUsd(
                                            t.liquidity,
                                        ),
                                        holders: t.holderCount ?? "N/A",
                                        verified: t.isVerified,
                                    })),
                                    _note: "Real-time data from Jupiter. Use the exact mint when calling initiate_swap to buy one. Always add a brief not-financial-advice caution for low-liquidity memecoins.",
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Failed to fetch trending tokens";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "transfer_sol": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const { toAddress, amountSOL, sendAll } = args as {
                                toAddress: string;
                                amountSOL?: number;
                                sendAll?: boolean;
                            };

                            try {
                                if (toAddress === spendWallet) {
                                    result = {
                                        error: "Sender and recipient addresses must be different.",
                                    };
                                    break;
                                }
                                if (
                                    sendAll !== true &&
                                    (amountSOL === undefined ||
                                        amountSOL === null)
                                ) {
                                    result = {
                                        error: "amountSOL is required unless sendAll is true.",
                                    };
                                    break;
                                }
                                if (
                                    sendAll !== true &&
                                    (!Number.isFinite(amountSOL) ||
                                        (amountSOL as number) <= 0)
                                ) {
                                    result = {
                                        error: "amountSOL must be a positive number.",
                                    };
                                    break;
                                }

                                const balance =
                                    await getSOLBalance(spendWallet);
                                const rentReserveLamports =
                                    await getSystemAccountRentReserveLamports();
                                const totalReserveLamports =
                                    rentReserveLamports +
                                    SOL_TRANSFER_FEE_BUFFER_LAMPORTS;
                                const maxSendableLamports =
                                    balance.lamports - totalReserveLamports;
                                if (maxSendableLamports <= 0) {
                                    let err = `Not enough SOL to send after reserving ~${(totalReserveLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL for rent exemption and network fees. Balance: ${balance.sol.toFixed(6)} SOL.`;
                                    if (
                                        txSigner &&
                                        walletAddress &&
                                        txSigner !== walletAddress
                                    ) {
                                        const linkedBal =
                                            await getSOLBalance(walletAddress);
                                        err += ` Linked wallet: ${linkedBal.sol.toFixed(6)} SOL — fund the signing wallet (${txSigner}) first.`;
                                    }
                                    result = { error: err };
                                    break;
                                }

                                const desiredLamports =
                                    sendAll === true
                                        ? maxSendableLamports
                                        : Math.round(
                                              (amountSOL as number) *
                                                  LAMPORTS_PER_SOL,
                                          );
                                if (desiredLamports <= 0) {
                                    result = {
                                        error: "Amount is too small after converting to lamports.",
                                    };
                                    break;
                                }

                                let lamportsToSend = desiredLamports;
                                let clamped = false;
                                if (lamportsToSend > maxSendableLamports) {
                                    lamportsToSend = maxSendableLamports;
                                    clamped = true;
                                }

                                const actualAmountSol =
                                    lamportsToSend / LAMPORTS_PER_SOL;

                                const tx = await createSolTransferTx({
                                    fromWallet: spendWallet,
                                    toWallet: toAddress,
                                    lamports: lamportsToSend,
                                });

                                pendingAction = {
                                    type: "transfer",
                                    transaction: tx.transaction,
                                    assetSymbol: "SOL",
                                    amount: actualAmountSol,
                                    toAddress,
                                };

                                const clampNote = clamped
                                    ? ` Amount reduced from ~${amountSOL} SOL so the sender keeps lamports for rent exemption and fees.`
                                    : "";

                                result = {
                                    success: true,
                                    message: `SOL transfer prepared: ${actualAmountSol} SOL to ${toAddress}.${clampNote}${transferToolConfirmPhrase}`,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Failed to prepare SOL transfer";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "transfer_token": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const { toAddress, token, amount, sendAll } =
                                args as {
                                    toAddress: string;
                                    token: string;
                                    amount?: number;
                                    sendAll?: boolean;
                                };

                            try {
                                if (toAddress === spendWallet) {
                                    result = {
                                        error: "Sender and recipient addresses must be different.",
                                    };
                                    break;
                                }
                                if (!token || typeof token !== "string") {
                                    result = {
                                        error: "Token symbol or mint is required.",
                                    };
                                    break;
                                }

                                const tokenQuery = token.trim();
                                const holdings =
                                    await getTokenAccounts(spendWallet);
                                const heldMatch = findTokenHolding(
                                    holdings,
                                    tokenQuery,
                                );
                                const mintAddress = isSolanaPublicKey(
                                    tokenQuery,
                                )
                                    ? tokenQuery
                                    : (heldMatch?.mint ??
                                      (await resolveTokenMint(tokenQuery)));
                                if (!mintAddress) {
                                    result = {
                                        error: `Could not resolve token: ${tokenQuery}`,
                                    };
                                    break;
                                }

                                const tokenHolding =
                                    holdings.find(
                                        (t) => t.mint === mintAddress,
                                    ) ?? heldMatch;
                                if (!tokenHolding) {
                                    let err = `The signing wallet does not hold this token: ${tokenQuery}.`;
                                    if (
                                        txSigner &&
                                        walletAddress &&
                                        txSigner !== walletAddress
                                    ) {
                                        const linkedHold = findTokenHolding(
                                            await getTokenAccounts(
                                                walletAddress,
                                            ),
                                            tokenQuery,
                                        );
                                        if (linkedHold) {
                                            err += ` Your linked wallet has ${linkedHold.amountString} — send tokens to your Telegram signing wallet (${txSigner}) first.`;
                                        }
                                    }
                                    result = { error: err };
                                    break;
                                }

                                const sendFullBalance = sendAll === true;
                                if (
                                    !sendFullBalance &&
                                    (amount === undefined || amount === null)
                                ) {
                                    result = {
                                        error: "Token amount is required unless sendAll is true.",
                                    };
                                    break;
                                }

                                let amountRaw = BigInt(tokenHolding.rawAmount);
                                let amountLabel = rawUnitsToUiAmountString(
                                    amountRaw,
                                    tokenHolding.decimals,
                                );
                                if (!sendFullBalance) {
                                    try {
                                        amountRaw = uiAmountToRawUnits(
                                            amount as number,
                                            tokenHolding.decimals,
                                        );
                                        amountLabel = rawUnitsToUiAmountString(
                                            amountRaw,
                                            tokenHolding.decimals,
                                        );
                                    } catch {
                                        result = {
                                            error: "Invalid token amount.",
                                        };
                                        break;
                                    }
                                }

                                if (amountRaw <= BigInt(0)) {
                                    result = { error: "Amount is too small." };
                                    break;
                                }

                                try {
                                    const balanceRaw = BigInt(
                                        tokenHolding.rawAmount,
                                    );
                                    if (amountRaw > balanceRaw) {
                                        result = {
                                            error: `Insufficient ${tokenHolding.symbol || tokenQuery} on the signing wallet. You have ${tokenHolding.amountString}, tried to send ${amountLabel}.`,
                                        };
                                        break;
                                    }
                                } catch {
                                    result = {
                                        error: "Invalid token balance data from RPC.",
                                    };
                                    break;
                                }

                                const tx = await createSplTransferTx({
                                    ownerWallet: spendWallet,
                                    toWallet: toAddress,
                                    mintAddress,
                                    amountBaseUnits: amountRaw,
                                    sourceTokenAccount: tokenHolding.address,
                                });

                                const displayAmount = Number(amountLabel);
                                pendingAction = {
                                    type: "transfer",
                                    transaction: tx.transaction,
                                    assetSymbol:
                                        tokenHolding.symbol ||
                                        tokenQuery.toUpperCase(),
                                    amount: displayAmount,
                                    amountLabel,
                                    toAddress,
                                };

                                result = {
                                    success: true,
                                    message: `Token transfer prepared: ${amountLabel} ${tokenHolding.symbol || tokenQuery.toUpperCase()} to ${toAddress}.${transferToolConfirmPhrase}`,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Failed to prepare token transfer";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "initiate_swap": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const {
                                inputToken,
                                outputToken,
                                amount: amountArg,
                                amountUsd,
                            } = args;

                            try {
                                const inputMint =
                                    await resolveTokenMint(inputToken);
                                if (!inputMint) {
                                    result = {
                                        error: `Could not resolve token: ${inputToken}`,
                                    };
                                    break;
                                }

                                const outputMint =
                                    await resolveTokenMint(outputToken);
                                if (!outputMint) {
                                    result = {
                                        error: `Could not resolve token: ${outputToken}`,
                                    };
                                    break;
                                }

                                // SOL and WSOL share a mint, so Jupiter has no
                                // route between them — it's a wrap/unwrap, not a
                                // swap. Route it correctly instead of failing.
                                if (inputMint === outputMint) {
                                    const inU = String(inputToken).toUpperCase();
                                    const outU =
                                        String(outputToken).toUpperCase();
                                    const isWrapPair =
                                        inputMint ===
                                            "So11111111111111111111111111111111111111112" &&
                                        (inU === "SOL" || inU === "WSOL") &&
                                        (outU === "SOL" || outU === "WSOL") &&
                                        inU !== outU;
                                    if (isWrapPair) {
                                        const wr = await buildWrapUnwrapAction({
                                            spendWallet,
                                            direction:
                                                outU === "WSOL"
                                                    ? "wrap"
                                                    : "unwrap",
                                            amount: amountArg,
                                            amountUsd,
                                        });
                                        if ("error" in wr) {
                                            result = { error: wr.error };
                                        } else {
                                            pendingAction = wr.pendingAction;
                                            result = {
                                                success: true,
                                                message: wr.message,
                                            };
                                        }
                                    } else {
                                        result = {
                                            error: `${inputToken} and ${outputToken} are the same token — there's nothing to swap.`,
                                        };
                                    }
                                    break;
                                }

                                const inputDecimals =
                                    getKnownDecimals(inputMint) ??
                                    (await getMintDecimals(inputMint));
                                const outputDecimals =
                                    getKnownDecimals(outputMint) ??
                                    (await getMintDecimals(outputMint));

                                // Resolve the token amount to swap. When the user
                                // asked in dollars, convert USD→token HERE using a
                                // live price instead of trusting the model's
                                // mental math (which has swapped whole balances).
                                let amount_: number | undefined =
                                    typeof amountArg === "number" &&
                                    Number.isFinite(amountArg)
                                        ? amountArg
                                        : undefined;
                                if (
                                    amount_ === undefined &&
                                    typeof amountUsd === "number" &&
                                    Number.isFinite(amountUsd) &&
                                    amountUsd > 0
                                ) {
                                    const [p] = await getTokenPrices([
                                        inputMint,
                                    ]);
                                    const unitPrice = p
                                        ? parseFloat(p.price)
                                        : NaN;
                                    if (
                                        !Number.isFinite(unitPrice) ||
                                        unitPrice <= 0
                                    ) {
                                        result = {
                                            error: `Couldn't get a reliable USD price for ${inputToken} right now, so I can't convert $${amountUsd} to a token amount. Try specifying the amount in ${inputToken} instead.`,
                                        };
                                        break;
                                    }
                                    amount_ = amountUsd / unitPrice;
                                }
                                if (
                                    amount_ === undefined ||
                                    !Number.isFinite(amount_) ||
                                    amount_ <= 0
                                ) {
                                    result = {
                                        error: `Please specify how much ${inputToken} to swap (a token amount like '0.1 ${inputToken}' or a dollar amount like '$5 of ${inputToken}').`,
                                    };
                                    break;
                                }
                                const amount = amount_;

                                // Keep enough SOL for the network/priority fee
                                // (and possible ATA rent). For SOL-input swaps,
                                // clamp the amount so the fee can still be paid.
                                const NATIVE_SOL =
                                    "So11111111111111111111111111111111111111112";
                                const SWAP_SOL_FEE_RESERVE_LAMPORTS = 5_000_000; // ~0.005 SOL
                                const balance =
                                    await getSOLBalance(spendWallet);

                                let swapAmount = amount;
                                let clampNote = "";
                                if (inputMint === NATIVE_SOL) {
                                    const requested = Math.round(
                                        amount * LAMPORTS_PER_SOL,
                                    );
                                    const maxLamports =
                                        balance.lamports -
                                        SWAP_SOL_FEE_RESERVE_LAMPORTS;
                                    if (maxLamports <= 0) {
                                        result = {
                                            error: `Not enough SOL to swap after keeping ~${(SWAP_SOL_FEE_RESERVE_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3)} SOL for network fees. Balance: ${balance.sol.toFixed(6)} SOL.`,
                                        };
                                        break;
                                    }
                                    if (requested > maxLamports) {
                                        swapAmount =
                                            maxLamports / LAMPORTS_PER_SOL;
                                        clampNote = ` Amount reduced to ${swapAmount.toFixed(6)} SOL so you keep enough SOL for the network fee.`;
                                    }
                                } else if (
                                    balance.lamports <
                                    SWAP_SOL_FEE_RESERVE_LAMPORTS
                                ) {
                                    result = {
                                        error: `You need a little SOL (about ${(SWAP_SOL_FEE_RESERVE_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3)} SOL) to cover the network fee for this swap. Current SOL balance: ${balance.sol.toFixed(6)} SOL.`,
                                    };
                                    break;
                                }

                                const order = await getSwapOrder(
                                    inputMint,
                                    outputMint,
                                    swapAmount,
                                    inputDecimals,
                                    spendWallet,
                                    outputDecimals,
                                );

                                // Store the swap action to send to frontend
                                pendingAction = {
                                    type: "swap",
                                    transaction: order.transaction,
                                    requestId: order.requestId,
                                    inputToken,
                                    outputToken,
                                    amount: swapAmount,
                                    estimatedOutput: order.estimatedOutput,
                                };

                                const outputInfo = order.estimatedOutput
                                    ? `You will receive approximately ${order.estimatedOutput} ${outputToken}.`
                                    : "";

                                result = {
                                    success: true,
                                    message: `Swap order created: ${swapAmount} ${inputToken} for ${outputToken}.${clampNote} ${outputInfo} Transaction ready for user to sign and confirm.`,
                                    requestId: order.requestId,
                                    estimatedOutput: order.estimatedOutput,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Swap order failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "wrap_sol": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const { direction, amount, amountUsd } = args as {
                                direction?: string;
                                amount?: number;
                                amountUsd?: number;
                            };
                            try {
                                const wr = await buildWrapUnwrapAction({
                                    spendWallet,
                                    direction:
                                        direction === "unwrap"
                                            ? "unwrap"
                                            : "wrap",
                                    amount,
                                    amountUsd,
                                });
                                if ("error" in wr) {
                                    result = { error: wr.error };
                                } else {
                                    pendingAction = wr.pendingAction;
                                    result = {
                                        success: true,
                                        message: wr.message,
                                    };
                                }
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Wrap/unwrap failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "build_portfolio": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const {
                                amountUsd,
                                preset,
                                tokens: requestedTokens,
                                fundToken,
                            } = args;
                            try {
                                if (
                                    typeof amountUsd !== "number" ||
                                    !Number.isFinite(amountUsd) ||
                                    amountUsd <= 0
                                ) {
                                    result = {
                                        error: "Tell me how much to invest in USD, e.g. 'build a $50 portfolio'.",
                                    };
                                    break;
                                }

                                // Curated, reputable baskets so we never diversify
                                // into a scam token. Symbols resolve via the
                                // verified-preferring resolver.
                                const PRESETS: Record<string, string[]> = {
                                    bluechip: ["SOL", "JUP"],
                                    balanced: ["SOL", "JUP", "JTO", "BONK"],
                                    degen: ["SOL", "BONK", "WIF"],
                                };
                                const fundSymbol =
                                    typeof fundToken === "string" && fundToken
                                        ? fundToken
                                        : "USDC";

                                let basket: string[] =
                                    Array.isArray(requestedTokens) &&
                                    requestedTokens.length > 0
                                        ? requestedTokens.map((s: unknown) =>
                                              String(s),
                                          )
                                        : PRESETS[
                                              String(preset || "").toLowerCase()
                                          ] || PRESETS.balanced;
                                // Don't buy the funding token with itself; dedupe.
                                basket = [...new Set(basket)].filter(
                                    (s) =>
                                        s.toUpperCase() !==
                                        fundSymbol.toUpperCase(),
                                );
                                if (basket.length === 0) {
                                    result = {
                                        error: "The basket is empty after removing the funding token. Specify a few tokens to diversify into.",
                                    };
                                    break;
                                }

                                const perLegUsd = amountUsd / basket.length;
                                const mints = await Promise.all(
                                    basket.map((s) => resolveTokenMint(s)),
                                );
                                const legs = basket
                                    .map((symbol, i) => ({
                                        symbol,
                                        mint: mints[i],
                                    }))
                                    .filter(
                                        (l): l is { symbol: string; mint: string } =>
                                            Boolean(l.mint),
                                    );
                                if (legs.length === 0) {
                                    result = {
                                        error: "Couldn't resolve any of the basket tokens right now. Try again or specify different tokens.",
                                    };
                                    break;
                                }

                                const prices = await getTokenPrices(
                                    legs.map((l) => l.mint),
                                );
                                const planLegs = legs.map((l) => {
                                    const p = prices.find(
                                        (x) => x.mint === l.mint,
                                    );
                                    const unit = p ? parseFloat(p.price) : null;
                                    return {
                                        symbol: l.symbol,
                                        allocationUsd: Number(
                                            perLegUsd.toFixed(2),
                                        ),
                                        estTokens:
                                            unit && unit > 0
                                                ? Number(
                                                      (perLegUsd / unit).toPrecision(
                                                          6,
                                                      ),
                                                  )
                                                : null,
                                    };
                                });

                                result = {
                                    success: true,
                                    plan: {
                                        fundToken: fundSymbol,
                                        totalUsd: Number(amountUsd.toFixed(2)),
                                        weighting: "equal",
                                        legs: planLegs,
                                    },
                                    message: `Portfolio plan for $${amountUsd.toFixed(2)} paid with ${fundSymbol}, split equally across ${planLegs
                                        .map((l) => l.symbol)
                                        .join(
                                            ", ",
                                        )} (~$${perLegUsd.toFixed(2)} each). This is a plan only — to execute, I will swap ${fundSymbol} into each token one at a time using initiate_swap (you confirm each in the UI). Ask me to start and I'll prepare the first swap.`,
                                };
                            } catch (error) {
                                result = {
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "Failed to build portfolio plan",
                                };
                            }
                            break;
                        }

                        case "execute_portfolio": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const {
                                amountUsd,
                                preset,
                                tokens: requestedTokens,
                                fundToken,
                            } = args;
                            try {
                                if (
                                    typeof amountUsd !== "number" ||
                                    !Number.isFinite(amountUsd) ||
                                    amountUsd <= 0
                                ) {
                                    result = {
                                        error: "Tell me how much to invest in USD, e.g. 'split $10 across SOL, JUP and BONK'.",
                                    };
                                    break;
                                }

                                // Same curated baskets as build_portfolio.
                                const PRESETS: Record<string, string[]> = {
                                    bluechip: ["SOL", "JUP"],
                                    balanced: ["SOL", "JUP", "JTO", "BONK"],
                                    degen: ["SOL", "BONK", "WIF"],
                                };
                                const fundSymbol =
                                    typeof fundToken === "string" && fundToken
                                        ? fundToken
                                        : "USDC";

                                let basket: string[] =
                                    Array.isArray(requestedTokens) &&
                                    requestedTokens.length > 0
                                        ? requestedTokens.map((s: unknown) =>
                                              String(s),
                                          )
                                        : PRESETS[
                                              String(preset || "").toLowerCase()
                                          ] || PRESETS.balanced;
                                // Never buy the funding token with itself; dedupe.
                                basket = [...new Set(basket)].filter(
                                    (s) =>
                                        s.toUpperCase() !==
                                        fundSymbol.toUpperCase(),
                                );
                                if (basket.length === 0) {
                                    result = {
                                        error: "The basket is empty after removing the funding token. Name a few tokens to split across.",
                                    };
                                    break;
                                }
                                if (basket.length === 1) {
                                    result = {
                                        error: "A split needs at least two different tokens. For a single token, use a normal swap instead.",
                                    };
                                    break;
                                }

                                const perLegUsd = amountUsd / basket.length;
                                const mints = await Promise.all(
                                    basket.map((s) => resolveTokenMint(s)),
                                );
                                const legs = basket
                                    .map((symbol, i) => ({
                                        symbol,
                                        outputMint: mints[i],
                                        amountUsd: Number(
                                            perLegUsd.toFixed(6),
                                        ),
                                    }))
                                    .filter(
                                        (
                                            l,
                                        ): l is {
                                            symbol: string;
                                            outputMint: string;
                                            amountUsd: number;
                                        } => Boolean(l.outputMint),
                                    );
                                if (legs.length === 0) {
                                    result = {
                                        error: "Couldn't resolve any of those tokens right now. Try again or name different tokens.",
                                    };
                                    break;
                                }

                                pendingSwapPlan = {
                                    fundToken: fundSymbol,
                                    totalUsd: Number(amountUsd.toFixed(2)),
                                    legs,
                                };

                                result = {
                                    success: true,
                                    message: `Prepared ${legs.length} swaps splitting $${amountUsd.toFixed(2)} of ${fundSymbol} equally (~$${perLegUsd.toFixed(2)} each) into ${legs
                                        .map((l) => l.symbol)
                                        .join(
                                            ", ",
                                        )}. The user will confirm each swap in the UI, one after another.`,
                                };
                            } catch (error) {
                                result = {
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "Failed to prepare the portfolio swaps",
                                };
                            }
                            break;
                        }

                        case "consolidate_tokens": {
                            // Many → 1: sell several input tokens into ONE
                            // destination. Each leg carries its own input mint
                            // and an EXACT base-unit amount (rawAmount) so
                            // unknown/Token-2022 mints are never mis-sized by the
                            // decimals=9 fallback in the order route.
                            const args = JSON.parse(toolCall.function.arguments);
                            // `sellAll` is a model-facing hint only; the handler
                            // infers "sell the whole balance" from the absence of
                            // a per-leg amount/amountUsd, so it isn't read here.
                            const { inputTokens, outputToken, amounts, amountsUsd } =
                                args;
                            try {
                                const outRaw =
                                    typeof outputToken === "string" && outputToken
                                        ? outputToken
                                        : "SOL";
                                const outputMint =
                                    await resolveTokenMint(outRaw);
                                if (!outputMint) {
                                    result = {
                                        error: `Could not resolve the destination token: ${outRaw}`,
                                    };
                                    break;
                                }
                                const outSymbol =
                                    outRaw.length > 20
                                        ? `${outputMint.slice(0, 4)}…${outputMint.slice(-4)}`
                                        : outRaw.toUpperCase();

                                const overview =
                                    await getWalletOverview(walletAddress);

                                const explicitInputs =
                                    Array.isArray(inputTokens) &&
                                    inputTokens.length > 0
                                        ? inputTokens.map((s: unknown) =>
                                              String(s),
                                          )
                                        : [];
                                // No explicit list → sell every held SPL token.
                                const requested: {
                                    symbol: string;
                                    amount?: number;
                                    amountUsd?: number;
                                }[] =
                                    explicitInputs.length > 0
                                        ? explicitInputs.map((symbol, i) => ({
                                              symbol,
                                              amount:
                                                  Array.isArray(amounts) &&
                                                  typeof amounts[i] === "number"
                                                      ? amounts[i]
                                                      : undefined,
                                              amountUsd:
                                                  Array.isArray(amountsUsd) &&
                                                  typeof amountsUsd[i] ===
                                                      "number"
                                                      ? amountsUsd[i]
                                                      : undefined,
                                          }))
                                        : overview.tokens.map((t) => ({
                                              symbol: t.mint,
                                          }));

                                const SWAP_SOL_FEE_RESERVE_LAMPORTS = 20_000_000; // ~0.02 SOL

                                // Pass 1: resolve, dedupe, skip; collect balances.
                                const seen = new Set<string>();
                                const skipped: string[] = [];
                                const candidates: {
                                    inputMint: string;
                                    inputSymbol: string;
                                    decimals: number;
                                    balanceRaw: bigint;
                                    amount?: number;
                                    amountUsd?: number;
                                }[] = [];
                                for (const req of requested) {
                                    const inputMint = await resolveTokenMint(
                                        req.symbol,
                                    );
                                    if (!inputMint) {
                                        skipped.push(req.symbol);
                                        continue;
                                    }
                                    // Skip the destination (dedupes wSOL→SOL too).
                                    if (inputMint === outputMint) continue;
                                    if (seen.has(inputMint)) continue;
                                    seen.add(inputMint);

                                    if (inputMint === NATIVE_SOL_MINT) {
                                        const namedExplicitly =
                                            explicitInputs.some(
                                                (s) =>
                                                    s.toUpperCase() === "SOL" ||
                                                    s === NATIVE_SOL_MINT,
                                            );
                                        if (!namedExplicitly) continue; // never auto-drain gas
                                        const bal =
                                            await getSOLBalance(walletAddress);
                                        const maxLamports =
                                            BigInt(bal.lamports) -
                                            BigInt(
                                                SWAP_SOL_FEE_RESERVE_LAMPORTS,
                                            );
                                        if (maxLamports <= BigInt(0)) {
                                            skipped.push(
                                                "SOL (keeping ~0.02 for fees)",
                                            );
                                            continue;
                                        }
                                        candidates.push({
                                            inputMint,
                                            inputSymbol: "SOL",
                                            decimals: 9,
                                            balanceRaw: maxLamports,
                                            amount: req.amount,
                                            amountUsd: req.amountUsd,
                                        });
                                        continue;
                                    }

                                    const holding = overview.tokens.find(
                                        (t) => t.mint === inputMint,
                                    );
                                    if (
                                        !holding ||
                                        BigInt(holding.rawAmount || "0") <=
                                            BigInt(0)
                                    ) {
                                        skipped.push(
                                            holding?.symbol || req.symbol,
                                        );
                                        continue;
                                    }
                                    candidates.push({
                                        inputMint,
                                        inputSymbol:
                                            holding.symbol || req.symbol,
                                        decimals: holding.decimals,
                                        balanceRaw: BigInt(holding.rawAmount),
                                        amount: req.amount,
                                        amountUsd: req.amountUsd,
                                    });
                                }

                                // Prices (for USD-sized legs + display total).
                                let prices: Awaited<
                                    ReturnType<typeof getTokenPrices>
                                > = [];
                                try {
                                    prices = await getTokenPrices(
                                        candidates.map((c) => c.inputMint),
                                    );
                                } catch {
                                    prices = [];
                                }
                                const priceOf = (mint: string) => {
                                    const p = prices.find(
                                        (x) => x.mint === mint,
                                    );
                                    return p ? parseFloat(p.price) : NaN;
                                };

                                // Pass 2: size each leg to an exact base-unit amount.
                                const legs: NonNullable<
                                    ChatResponse["swapPlan"]
                                >["legs"] = [];
                                let totalUsd = 0;
                                for (const c of candidates) {
                                    let raw: bigint;
                                    if (
                                        typeof c.amount === "number" &&
                                        c.amount > 0
                                    ) {
                                        const want = BigInt(
                                            Math.round(
                                                c.amount * 10 ** c.decimals,
                                            ),
                                        );
                                        raw =
                                            want > c.balanceRaw
                                                ? c.balanceRaw
                                                : want;
                                    } else if (
                                        typeof c.amountUsd === "number" &&
                                        c.amountUsd > 0
                                    ) {
                                        const unit = priceOf(c.inputMint);
                                        if (
                                            !Number.isFinite(unit) ||
                                            unit <= 0
                                        ) {
                                            skipped.push(
                                                `${c.inputSymbol} (no price)`,
                                            );
                                            continue;
                                        }
                                        const want = BigInt(
                                            Math.round(
                                                (c.amountUsd / unit) *
                                                    10 ** c.decimals,
                                            ),
                                        );
                                        raw =
                                            want > c.balanceRaw
                                                ? c.balanceRaw
                                                : want;
                                    } else {
                                        raw = c.balanceRaw; // sell the whole balance
                                    }
                                    if (raw <= BigInt(0)) {
                                        skipped.push(c.inputSymbol);
                                        continue;
                                    }
                                    legs.push({
                                        symbol: outSymbol,
                                        outputMint,
                                        inputMint: c.inputMint,
                                        inputSymbol: c.inputSymbol,
                                        rawAmount: raw.toString(),
                                        inputDecimals: c.decimals,
                                    });
                                    const unit = priceOf(c.inputMint);
                                    if (Number.isFinite(unit)) {
                                        totalUsd +=
                                            (Number(raw) / 10 ** c.decimals) *
                                            unit;
                                    }
                                }

                                if (legs.length === 0) {
                                    const note = skipped.length
                                        ? ` (skipped: ${skipped.join(", ")})`
                                        : "";
                                    result = {
                                        error: `Couldn't find any tokens with a swappable balance to convert into ${outSymbol}${note}. Name tokens you currently hold.`,
                                    };
                                    break;
                                }

                                pendingSwapPlan = {
                                    fundToken: outSymbol,
                                    totalUsd: Number(totalUsd.toFixed(2)),
                                    legs,
                                };

                                const skippedNote = skipped.length
                                    ? ` Skipped: ${skipped.join(", ")}.`
                                    : "";
                                result = {
                                    success: true,
                                    message: `Prepared ${legs.length} swap${
                                        legs.length > 1 ? "s" : ""
                                    } to consolidate ${legs
                                        .map((l) => l.inputSymbol)
                                        .join(
                                            ", ",
                                        )} into ${outSymbol}. The user will confirm each swap in the UI, one after another.${skippedNote}`,
                                };
                            } catch (error) {
                                result = {
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "Failed to prepare the consolidation swaps",
                                };
                            }
                            break;
                        }

                        case "search_meteora_pools": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            try {
                                const pools = await searchPools(args.query);
                                if (pools.length === 0) {
                                    result = {
                                        message:
                                            "No pools found for that search query.",
                                    };
                                } else {
                                    result = {
                                        pools: pools.map((p) => ({
                                            address: p.address,
                                            name: p.name,
                                            tokenXSymbol: p.tokenXSymbol,
                                            tokenYSymbol: p.tokenYSymbol,
                                            tokenXDecimals: p.tokenXDecimals,
                                            tokenYDecimals: p.tokenYDecimals,
                                            tvl: `$${p.tvl.toLocaleString()}`,
                                            apr: `${p.apr.toFixed(2)}%`,
                                            currentPrice: p.currentPrice,
                                            binStep: p.binStep,
                                            volume24h: `$${p.volume24h.toLocaleString()}`,
                                            fees24h: `$${p.fees24h.toLocaleString()}`,
                                        })),
                                    };
                                }
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Pool search failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "get_user_positions": {
                            try {
                                const positions =
                                    await getUserPositionsForPool(
                                        walletAddress,
                                    );

                                if (positions.length === 0) {
                                    result = {
                                        message:
                                            "You have no positions in this pool.",
                                    };
                                } else {
                                    // Enrich positions with pool details
                                    const enriched = [];
                                    const poolCache = new Map<
                                        string,
                                        Awaited<
                                            ReturnType<typeof getPoolDetails>
                                        >
                                    >();
                                    for (const pos of positions) {
                                        if (!poolCache.has(pos.poolAddress)) {
                                            poolCache.set(
                                                pos.poolAddress,
                                                await getPoolDetails(
                                                    pos.poolAddress,
                                                ),
                                            );
                                        }
                                        const pool = poolCache.get(
                                            pos.poolAddress,
                                        );
                                        // Format raw amounts using token decimals
                                        const xDecimals =
                                            pool?.tokenXDecimals ?? 6;
                                        const yDecimals =
                                            pool?.tokenYDecimals ?? 9;
                                        const xAmount =
                                            Number(pos.totalXAmount) /
                                            10 ** xDecimals;
                                        const yAmount =
                                            Number(pos.totalYAmount) /
                                            10 ** yDecimals;

                                        enriched.push({
                                            poolAddress: pos.poolAddress,
                                            poolName: pool?.name ?? "Unknown",
                                            positionAddress:
                                                pos.positionAddress,
                                            binRange: `${pos.minBinId} to ${pos.maxBinId}`,
                                            tokenXSymbol:
                                                pool?.tokenXSymbol ?? "?",
                                            tokenYSymbol:
                                                pool?.tokenYSymbol ?? "?",
                                            tokenXAmount: xAmount.toFixed(
                                                Math.min(xDecimals, 6),
                                            ),
                                            tokenYAmount: yAmount.toFixed(
                                                Math.min(yDecimals, 6),
                                            ),
                                            currentPrice:
                                                pool?.currentPrice ?? 0,
                                            tvl: pool
                                                ? `$${pool.tvl.toLocaleString()}`
                                                : "?",
                                        });
                                    }
                                    result = { positions: enriched };
                                }
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Failed to fetch positions";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "add_liquidity": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const { poolAddress, depositToken, depositAmount } =
                                args;

                            // Input validation: a positive deposit amount is
                            // required so the model can't send a nonsense size.
                            if (
                                typeof depositAmount !== "number" ||
                                !Number.isFinite(depositAmount) ||
                                depositAmount <= 0
                            ) {
                                const err =
                                    "Tell me how much to deposit — a positive amount of one of the pool's tokens (e.g. 'add 0.05 SOL of liquidity').";
                                result = { error: err };
                                liquidityError = err;
                                break;
                            }

                            try {
                                const pool = await getPoolDetails(poolAddress);
                                if (!pool) {
                                    result = { error: "Pool not found." };
                                    liquidityError = "Pool not found.";
                                    break;
                                }

                                // Determine which side the deposit token is on
                                const depositUpper = (
                                    depositToken as string
                                ).toUpperCase();
                                const isTokenX =
                                    pool.tokenXSymbol.toUpperCase() ===
                                    depositUpper;
                                const isTokenY =
                                    pool.tokenYSymbol.toUpperCase() ===
                                    depositUpper;

                                if (!isTokenX && !isTokenY) {
                                    const err = `Token ${depositToken} is not in this pool. This pool has ${pool.tokenXSymbol} and ${pool.tokenYSymbol}.`;
                                    result = { error: err };
                                    liquidityError = err;
                                    break;
                                }

                                // Calculate the other side amount using the pool's current price
                                // currentPrice = tokenX price in terms of tokenY (e.g. 85 SOL/USDC means 1 SOL = 85 USDC)
                                let amountX: number;
                                let amountY: number;

                                if (isTokenX) {
                                    amountX = depositAmount;
                                    amountY = depositAmount * pool.currentPrice;
                                } else {
                                    amountY = depositAmount;
                                    amountX = depositAmount / pool.currentPrice;
                                }

                                // Pre-flight balance check against the SIGNING
                                // wallet (the one that funds the tx) so the numbers
                                // match the user's portfolio. A DLMM deposit around
                                // the active bin needs BOTH sides; a missing SPL
                                // side (e.g. 0 USDC in a SOL-USDC pool) is the real
                                // reason these deposits fail — say so precisely
                                // instead of a confusing SOL-balance message.
                                const NATIVE_SOL_MINT =
                                    "So11111111111111111111111111111111111111112";
                                const xIsSol = pool.tokenX === NATIVE_SOL_MINT;
                                const yIsSol = pool.tokenY === NATIVE_SOL_MINT;
                                const solBal = (
                                    await getSOLBalance(spendWallet)
                                ).sol;
                                const holdings =
                                    await getTokenAccounts(spendWallet);
                                const balOf = (mint: string) =>
                                    holdings.find((h) => h.mint === mint)
                                        ?.amount ?? 0;

                                const shortfalls: string[] = [];
                                if (!xIsSol && amountX > balOf(pool.tokenX)) {
                                    shortfalls.push(
                                        `${amountX.toFixed(6)} ${pool.tokenXSymbol} (you have ${balOf(pool.tokenX)} ${pool.tokenXSymbol})`,
                                    );
                                }
                                if (!yIsSol && amountY > balOf(pool.tokenY)) {
                                    shortfalls.push(
                                        `${amountY.toFixed(6)} ${pool.tokenYSymbol} (you have ${balOf(pool.tokenY)} ${pool.tokenYSymbol})`,
                                    );
                                }
                                if (shortfalls.length > 0) {
                                    let err = `Not enough tokens to add liquidity to ${pool.name}. This deposit needs ${shortfalls.join(" and ")}.`;
                                    // If one side is SOL, the user likely holds
                                    // only SOL — point them to swap into the other
                                    // side first.
                                    if (xIsSol || yIsSol) {
                                        const otherSym = xIsSol
                                            ? pool.tokenYSymbol
                                            : pool.tokenXSymbol;
                                        err += ` A ${pool.name} position needs BOTH ${pool.tokenXSymbol} and ${pool.tokenYSymbol}. You currently hold ${solBal.toFixed(4)} SOL. To add liquidity here, swap some SOL into ${otherSym} first, then try again.`;
                                    }
                                    result = { error: err };
                                    liquidityError = err;
                                    break;
                                }

                                const txResult = await buildAddLiquidityTx(
                                    poolAddress,
                                    spendWallet,
                                    amountX,
                                    amountY,
                                    pool.tokenXDecimals,
                                    pool.tokenYDecimals,
                                );

                                // The builder may auto-size the deposit down so
                                // the SOL side fits after the position-rent
                                // reserve — reflect the ACTUAL amounts everywhere.
                                const finalX = txResult.amountX;
                                const finalY = txResult.amountY;

                                pendingAction = {
                                    type: "addLiquidity",
                                    transactions: txResult.transactions,
                                    poolAddress,
                                    positionAddress: txResult.positionAddress,
                                    poolName: pool.name,
                                    amountX: finalX,
                                    amountY: finalY,
                                    tokenXSymbol: pool.tokenXSymbol,
                                    tokenYSymbol: pool.tokenYSymbol,
                                };

                                const adjustNote = txResult.adjusted
                                    ? ` Heads up: that was more than your available SOL allows after the ~0.06 SOL (refundable) position-rent reserve, so I auto-sized the deposit down to the largest amount that fits. Review the amounts on the card before confirming.`
                                    : "";

                                result = {
                                    success: true,
                                    adjusted: txResult.adjusted,
                                    message: `Liquidity deposit prepared for ${pool.name}: ${finalX.toFixed(6)} ${pool.tokenXSymbol} + ${finalY.toFixed(6)} ${pool.tokenYSymbol}.${adjustNote} Transaction ready for user to sign and confirm.`,
                                    positionAddress: txResult.positionAddress,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Add liquidity failed";
                                result = { error: msg };
                                liquidityError = msg;
                            }
                            break;
                        }

                        case "remove_liquidity": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const { poolAddress, positionAddress, percentage } =
                                args;
                            const bps = Math.min(
                                Math.max(
                                    Math.round((percentage ?? 100) * 100),
                                    100,
                                ),
                                10000,
                            );

                            try {
                                const txResult = await buildRemoveLiquidityTx(
                                    poolAddress,
                                    walletAddress,
                                    positionAddress,
                                    bps,
                                    bps === 10000, // close position if removing 100%
                                );

                                pendingAction = {
                                    type: "removeLiquidity",
                                    transactions: txResult.transactions,
                                    poolAddress,
                                    positionAddress,
                                };

                                result = {
                                    success: true,
                                    message: `Liquidity removal prepared: ${percentage ?? 100}% from position ${positionAddress.slice(0, 8)}... Transaction ready for user to sign and confirm.`,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Remove liquidity failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "launch_token": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const {
                                name,
                                symbol,
                                description,
                                imageUrl,
                                twitter,
                                website,
                                telegram,
                                initialBuySOL,
                            } = args;

                            try {
                                // Check SOL balance — launching requires ~0.1 SOL for rent + fees
                                const minSOLForLaunch =
                                    0.1 + (initialBuySOL || 0);
                                const balance =
                                    await getSOLBalance(walletAddress);
                                if (balance.sol < minSOLForLaunch) {
                                    result = {
                                        error: `Insufficient SOL to launch a token. You have ${balance.sol.toFixed(4)} SOL but need at least ~${minSOLForLaunch.toFixed(2)} SOL (for account rent + transaction fees${initialBuySOL ? ` + ${initialBuySOL} SOL initial buy` : ""}). Please add more SOL to your wallet first.`,
                                    };
                                    break;
                                }

                                // Step 1: Create token metadata
                                console.log(
                                    "[bags] Step 1: Creating token info...",
                                );
                                const tokenInfo = await createTokenInfo({
                                    name,
                                    symbol: symbol
                                        .toUpperCase()
                                        .replace("$", ""),
                                    description,
                                    imageUrl,
                                    twitter,
                                    website,
                                    telegram,
                                });
                                console.log(
                                    "[bags] Token info created:",
                                    tokenInfo.tokenMint,
                                );

                                // Step 2: Create fee share config (creator gets 100%)
                                console.log(
                                    "[bags] Step 2: Creating fee share config...",
                                );
                                const feeConfig = await createFeeShareConfig({
                                    payer: walletAddress,
                                    baseMint: tokenInfo.tokenMint,
                                    feeClaimers: [
                                        { user: walletAddress, userBps: 10000 },
                                    ],
                                });
                                console.log(
                                    "[bags] Fee config created, meteoraConfigKey:",
                                    feeConfig.meteoraConfigKey,
                                );

                                // Fee config transactions need to be signed and sent FIRST,
                                // then the launch tx can be created. The frontend handles this
                                // two-phase flow via the /api/bags/launch endpoint.
                                const initialBuyLamports = Math.round(
                                    (initialBuySOL || 0) * 1e9,
                                );

                                const feeConfigTxStrings =
                                    feeConfig.transactions.map(
                                        (t) => t.transaction,
                                    );

                                pendingAction = {
                                    type: "launchToken",
                                    transactions: feeConfigTxStrings,
                                    tokenName: name,
                                    tokenSymbol: symbol,
                                    tokenMint: tokenInfo.tokenMint,
                                    // Extra data needed for phase 2 (creating launch tx after fee config is on-chain)
                                    launchParams: {
                                        ipfs: tokenInfo.tokenMetadata,
                                        configKey: feeConfig.meteoraConfigKey,
                                        initialBuyLamports,
                                    },
                                };

                                result = {
                                    success: true,
                                    message: `Token "${name}" ($${symbol}) is ready to launch! Mint: ${tokenInfo.tokenMint}. ${initialBuySOL ? `Initial buy: ${initialBuySOL} SOL. ` : ""}Please confirm the transaction to proceed.`,
                                    tokenMint: tokenInfo.tokenMint,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Token launch failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "get_bags_token_info": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const { tokenMint } = args;

                            try {
                                const [creators, lifetimeFees] =
                                    await Promise.all([
                                        getTokenCreators(tokenMint).catch(
                                            () => [],
                                        ),
                                        getTokenLifetimeFees(tokenMint).catch(
                                            () => "0",
                                        ),
                                    ]);

                                const feesSOL = Number(lifetimeFees) / 1e9;
                                result = {
                                    creators: creators.map((c) => ({
                                        username:
                                            c.providerUsername || c.username,
                                        provider: c.provider,
                                        wallet: c.wallet,
                                        royalty: `${(c.royaltyBps / 100).toFixed(2)}%`,
                                        isCreator: c.isCreator,
                                    })),
                                    lifetimeFees: `${feesSOL.toFixed(4)} SOL`,
                                    lifetimeFeesLamports: lifetimeFees,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Failed to fetch token info";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "get_claimable_fees": {
                            try {
                                const positions =
                                    await getClaimablePositions(walletAddress);
                                if (positions.length === 0) {
                                    result = {
                                        message:
                                            "You have no claimable fees from Bags token launches.",
                                    };
                                } else {
                                    result = {
                                        positions: positions.map((p) => ({
                                            tokenMint: p.baseMint,
                                            claimableSOL: (
                                                p.totalClaimableLamportsUserShare /
                                                1e9
                                            ).toFixed(4),
                                            claimableDisplay:
                                                p.claimableDisplayAmount,
                                            virtualPool:
                                                p.virtualPool ||
                                                p.virtualPoolAddress,
                                            isMigrated: p.isMigrated,
                                            programId: p.programId,
                                            isCustomFeeVault:
                                                p.isCustomFeeVault,
                                        })),
                                    };
                                }
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Failed to fetch claimable fees";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "claim_fees": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const {
                                tokenMint,
                                virtualPoolAddress,
                                programId,
                                isCustomFeeVault,
                            } = args;

                            try {
                                const claimResult =
                                    await createClaimTransactions({
                                        feeClaimer: walletAddress,
                                        tokenMint,
                                        virtualPoolAddress,
                                        claimVirtualPoolFees: true,
                                        claimDammV2Fees: false,
                                        isCustomFeeVault:
                                            isCustomFeeVault || false,
                                        feeShareProgramId: programId,
                                    });

                                const txStrings = claimResult.transactions.map(
                                    (t) => t.transaction,
                                );

                                pendingAction = {
                                    type: "claimFees",
                                    transactions: txStrings,
                                    tokenMint,
                                };

                                result = {
                                    success: true,
                                    message: `Fee claim transaction prepared for token ${tokenMint.slice(0, 8)}... Transaction ready for user to sign.`,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Claim fees failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "search_prediction_events": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const { query, category, filter } = args;

                            try {
                                let events;
                                if (query && query.trim()) {
                                    const searchResult =
                                        await searchPredictionEvents(query, 10);
                                    events = searchResult.data;
                                } else {
                                    const listResult =
                                        await listPredictionEvents({
                                            category: category || "crypto",
                                            filter: filter || undefined,
                                            includeMarkets: true,
                                            end: 10,
                                        });
                                    events = listResult.data;
                                }

                                if (!events || events.length === 0) {
                                    result = {
                                        message:
                                            "No prediction events found for that search.",
                                    };
                                } else {
                                    // Filter to only open markets that close > 30 min from now (short-lived markets fail)
                                    const nowSec = Math.floor(
                                        Date.now() / 1000,
                                    );
                                    const MIN_TIME_LEFT = 30 * 60; // 30 minutes
                                    // A market pinned at $0.00/$1.00 is already decided —
                                    // there is no bet left to place, so hide it.
                                    const MIN_PRICE = 0.05;
                                    const MAX_PRICE = 0.95;
                                    const MAX_MARKETS_PER_EVENT = 5;
                                    const yesPrice = (m: {
                                        pricing: {
                                            buyYesPriceUsd: number | null;
                                        };
                                    }) =>
                                        (m.pricing.buyYesPriceUsd ?? 0) /
                                        1_000_000;

                                    const mapped = events
                                        .filter((e) => e.isActive !== false)
                                        .map((e) => ({
                                            eventId: e.eventId,
                                            title: e.metadata.title,
                                            subtitle: e.metadata.subtitle,
                                            category: e.category,
                                            isLive: e.isLive,
                                            closeTime: e.metadata.closeTime,
                                            volume: microUsdToDisplay(
                                                e.volumeUsd,
                                            ),
                                            markets: (e.markets || [])
                                                .filter(
                                                    (m) =>
                                                        m.status === "open" &&
                                                        m.result === null &&
                                                        m.closeTime - nowSec >
                                                            MIN_TIME_LEFT &&
                                                        yesPrice(m) >=
                                                            MIN_PRICE &&
                                                        yesPrice(m) <=
                                                            MAX_PRICE,
                                                )
                                                // Closest to 50/50 first — those are the
                                                // ones still worth betting on.
                                                .sort(
                                                    (a, b) =>
                                                        Math.abs(
                                                            yesPrice(a) - 0.5,
                                                        ) -
                                                        Math.abs(
                                                            yesPrice(b) - 0.5,
                                                        ),
                                                )
                                                .slice(0, MAX_MARKETS_PER_EVENT)
                                                .map((m) => ({
                                                    marketId: m.marketId, // USE THIS EXACT ID for buy_prediction
                                                    title:
                                                        m.title ||
                                                        m.metadata?.title,
                                                    status: m.status,
                                                    yesPrice: m.pricing
                                                        .buyYesPriceUsd
                                                        ? `$${(m.pricing.buyYesPriceUsd / 1_000_000).toFixed(2)}`
                                                        : "N/A",
                                                    noPrice: m.pricing
                                                        .buyNoPriceUsd
                                                        ? `$${(m.pricing.buyNoPriceUsd / 1_000_000).toFixed(2)}`
                                                        : "N/A",
                                                    yesProbability: m.pricing
                                                        .buyYesPriceUsd
                                                        ? `${((m.pricing.buyYesPriceUsd / 1_000_000) * 100).toFixed(0)}%`
                                                        : "N/A",
                                                    noProbability: m.pricing
                                                        .buyNoPriceUsd
                                                        ? `${((m.pricing.buyNoPriceUsd / 1_000_000) * 100).toFixed(0)}%`
                                                        : "N/A",
                                                })),
                                        }))
                                        .filter((e) => e.markets.length > 0);

                                    if (mapped.length === 0) {
                                        result = {
                                            message:
                                                "No live prediction markets found. All matching markets are closed, expired, or already decided.",
                                        };
                                    } else {
                                        result = {
                                            events: mapped,
                                            _note: "Every market listed here is live and still tradeable. List each event with ONLY its own markets underneath it, and never invent or carry over markets from another event. IMPORTANT: Use the exact marketId string (e.g. POLY-1928733-0) when calling buy_prediction. Do NOT use event titles or numbers.",
                                        };
                                    }
                                }
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Event search failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "buy_prediction": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const { marketId, side, amountUsd, payToken } =
                                args;

                            try {
                                if (
                                    typeof amountUsd !== "number" ||
                                    !Number.isFinite(amountUsd)
                                ) {
                                    result = {
                                        error: "Please specify how much USD to bet (minimum $5), e.g. 'bet $5 YES'.",
                                    };
                                    break;
                                }
                                if (amountUsd < 5) {
                                    result = {
                                        error: "Minimum bet amount is $5.00",
                                    };
                                    break;
                                }

                                console.log("[prediction] Creating order:", {
                                    marketId,
                                    side,
                                    amountUsd,
                                });

                                // Get market details for display
                                const market =
                                    await getPredictionMarket(marketId);
                                console.log(
                                    "[prediction] Market status:",
                                    market.status,
                                    "title:",
                                    market.metadata?.title || market.title,
                                );
                                if (market.status !== "open") {
                                    result = {
                                        error: `Market is ${market.status}, not open for trading.`,
                                    };
                                    break;
                                }

                                // Pay with USDC or jupUSD. Honor an explicit
                                // choice, otherwise auto-pick whichever stablecoin
                                // has enough balance (USDC preferred).
                                const holdings =
                                    await getTokenAccounts(walletAddress);
                                const usdcBal =
                                    holdings.find((t) => t.mint === USDC_MINT)
                                        ?.amount ?? 0;
                                const jupusdBal =
                                    holdings.find((t) => t.mint === JUPUSD_MINT)
                                        ?.amount ?? 0;
                                const needed = amountUsd * 1.01; // matches the deposit buffer

                                const preference =
                                    typeof payToken === "string"
                                        ? payToken.toUpperCase()
                                        : "";
                                let depositMint: string;
                                let payLabel: string;
                                if (
                                    preference === "JUPUSD" &&
                                    jupusdBal >= needed
                                ) {
                                    depositMint = JUPUSD_MINT;
                                    payLabel = "jupUSD";
                                } else if (
                                    preference === "USDC" &&
                                    usdcBal >= needed
                                ) {
                                    depositMint = USDC_MINT;
                                    payLabel = "USDC";
                                } else if (usdcBal >= needed) {
                                    depositMint = USDC_MINT;
                                    payLabel = "USDC";
                                } else if (jupusdBal >= needed) {
                                    depositMint = JUPUSD_MINT;
                                    payLabel = "jupUSD";
                                } else {
                                    result = {
                                        error: `Not enough stablecoin to bet $${amountUsd.toFixed(2)}. You have ${usdcBal.toFixed(2)} USDC and ${jupusdBal.toFixed(2)} jupUSD. Add funds or lower the bet.`,
                                    };
                                    break;
                                }

                                const orderResponse =
                                    await createPredictionOrder({
                                        ownerPubkey: walletAddress,
                                        marketId,
                                        isYes: side.toUpperCase() === "YES",
                                        depositAmountUsd: amountUsd,
                                        depositMint,
                                    });

                                console.log("[prediction] Order created:", {
                                    orderPubkey:
                                        orderResponse.order.orderPubkey,
                                    contracts: orderResponse.order.contracts,
                                    cost: orderResponse.order.orderCostUsd,
                                    fee: orderResponse.order
                                        .estimatedTotalFeeUsd,
                                });

                                pendingAction = {
                                    type: "predictionOrder",
                                    transaction: orderResponse.transaction,
                                    marketId,
                                    side: side.toUpperCase() as "YES" | "NO",
                                    amountUsd,
                                    contracts: orderResponse.order.contracts,
                                    orderPubkey:
                                        orderResponse.order.orderPubkey,
                                    marketTitle:
                                        market.metadata?.title || market.title,
                                };

                                const price =
                                    side.toUpperCase() === "YES"
                                        ? market.pricing.buyYesPriceUsd
                                        : market.pricing.buyNoPriceUsd;
                                const priceDisplay = price
                                    ? `$${(price / 1_000_000).toFixed(2)}`
                                    : "market price";

                                result = {
                                    success: true,
                                    message: `Order prepared: Buy ${orderResponse.order.contracts} ${side.toUpperCase()} contracts on "${market.metadata.title}" for $${amountUsd.toFixed(2)} (paying with ${payLabel}) at ${priceDisplay}/contract. Please confirm the transaction.`,
                                    contracts: orderResponse.order.contracts,
                                    paidWith: payLabel,
                                    estimatedFee: microUsdToDisplay(
                                        orderResponse.order
                                            .estimatedTotalFeeUsd,
                                    ),
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Buy prediction failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "get_prediction_positions": {
                            try {
                                const positionsResult =
                                    await getPredictionPositions(walletAddress);
                                const positions = positionsResult.data;

                                if (!positions || positions.length === 0) {
                                    result = {
                                        message:
                                            "You have no prediction market positions.",
                                    };
                                } else {
                                    result = {
                                        positions: positions.map((p) => ({
                                            positionPubkey: p.pubkey,
                                            market: p.marketMetadata.title,
                                            event: p.eventMetadata.title,
                                            side: p.isYes ? "YES" : "NO",
                                            contracts: p.contracts,
                                            avgPrice: `$${microUsdToDisplay(p.avgPriceUsd)}`,
                                            totalCost: `$${microUsdToDisplay(p.totalCostUsd)}`,
                                            currentValue: p.valueUsd
                                                ? `$${microUsdToDisplay(p.valueUsd)}`
                                                : "N/A",
                                            pnl: p.pnlUsd
                                                ? `$${microUsdToDisplay(p.pnlUsd)}`
                                                : "N/A",
                                            pnlPercent:
                                                p.pnlUsdPercent !== null
                                                    ? `${p.pnlUsdPercent.toFixed(1)}%`
                                                    : "N/A",
                                            payout: `$${microUsdToDisplay(p.payoutUsd)}`,
                                            claimable: p.claimable,
                                            claimed: p.claimed,
                                            marketStatus:
                                                p.marketMetadata.status,
                                            marketResult:
                                                p.marketMetadata.result ||
                                                "pending",
                                        })),
                                    };
                                }
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Failed to fetch prediction positions";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "sell_prediction": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const { positionPubkey } = args;

                            try {
                                const closeResponse =
                                    await closePredictionPosition(
                                        positionPubkey,
                                        walletAddress,
                                    );

                                // Get position info for display
                                const positionsResult =
                                    await getPredictionPositions(walletAddress);
                                const position = positionsResult.data?.find(
                                    (p) => p.pubkey === positionPubkey,
                                );
                                const marketTitle =
                                    position?.marketMetadata.title ||
                                    "Unknown Market";

                                pendingAction = {
                                    type: "sellPrediction",
                                    transaction: closeResponse.transaction,
                                    positionPubkey,
                                    marketTitle,
                                };

                                result = {
                                    success: true,
                                    message: `Sell order prepared for position in "${marketTitle}". This will sell all contracts. Please confirm the transaction.`,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Sell prediction failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "claim_prediction": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const { positionPubkey } = args;

                            try {
                                const claimResponse =
                                    await claimPredictionPayout(
                                        positionPubkey,
                                        walletAddress,
                                    );

                                const payoutDisplay = microUsdToDisplay(
                                    claimResponse.position.payoutAmountUsd,
                                );

                                pendingAction = {
                                    type: "claimPrediction",
                                    transaction: claimResponse.transaction,
                                    positionPubkey,
                                    payoutUsd: payoutDisplay,
                                    marketTitle: "Winning Position",
                                };

                                result = {
                                    success: true,
                                    message: `Claim transaction prepared! You'll receive $${payoutDisplay} from ${claimResponse.position.contracts} winning contracts. Please confirm the transaction.`,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Claim payout failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "search_nft_collection": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            try {
                                const stats = await getMECollectionStats(
                                    args.symbol,
                                );
                                const floorSOL = stats.floorPrice
                                    ? (stats.floorPrice / 1e9).toFixed(4)
                                    : "N/A";
                                const volumeSOL = stats.volumeAll
                                    ? (stats.volumeAll / 1e9).toFixed(2)
                                    : "N/A";
                                const avgPriceSOL = stats.avgPrice24hr
                                    ? (stats.avgPrice24hr / 1e9).toFixed(4)
                                    : "N/A";
                                result = {
                                    symbol: stats.symbol,
                                    floorPrice: `${floorSOL} SOL`,
                                    listedCount: stats.listedCount,
                                    avgPrice24h: `${avgPriceSOL} SOL`,
                                    totalVolume: `${volumeSOL} SOL`,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Collection search failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "get_nft_listings": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            const limit = Math.min(args.limit || 10, 20);
                            try {
                                const listings = await getMEListings(
                                    args.symbol,
                                    0,
                                    limit,
                                );
                                if (listings.length === 0) {
                                    result = {
                                        message:
                                            "No active listings found for this collection.",
                                    };
                                } else {
                                    result = {
                                        listings: listings.map((l) => ({
                                            tokenMint: l.tokenMint,
                                            name:
                                                l.token?.name ||
                                                l.tokenMint.slice(0, 8) + "...",
                                            seller: l.seller,
                                            tokenAddress: l.tokenAddress,
                                            price: `${l.price} SOL`,
                                            priceRaw: l.price,
                                            expiry: l.expiry,
                                            auctionHouse: l.auctionHouse,
                                            image:
                                                l.token?.image ||
                                                l.extra?.img ||
                                                null,
                                            collection:
                                                l.token?.collectionName ||
                                                args.symbol,
                                        })),
                                        _note: "Use the EXACT tokenMint, seller, tokenAddress (as tokenATA), priceRaw (as price), expiry, and auctionHouse values when calling buy_nft.",
                                    };
                                }
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Failed to fetch listings";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "get_my_nfts": {
                            try {
                                const nfts =
                                    await getMEWalletNFTs(walletAddress);
                                if (nfts.length === 0) {
                                    result = {
                                        message: "You don't own any NFTs.",
                                    };
                                } else {
                                    result = {
                                        nfts: nfts.map((n) => ({
                                            mintAddress: n.mintAddress,
                                            name: n.name,
                                            collection:
                                                n.collectionName ||
                                                n.collection ||
                                                "Unknown",
                                            image: n.image || null,
                                            listStatus:
                                                n.listStatus || "unlisted",
                                            price: n.price
                                                ? `${n.price} SOL`
                                                : null,
                                        })),
                                    };
                                }
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Failed to fetch NFTs";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "buy_nft": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            try {
                                console.log(
                                    "[magiceden] Creating buy tx:",
                                    args,
                                );
                                const tx = await getMEBuyNowTx({
                                    buyer: walletAddress,
                                    seller: args.seller,
                                    tokenMint: args.tokenMint,
                                    tokenATA: args.tokenATA,
                                    price: args.price,
                                    sellerExpiry: args.sellerExpiry || 0,
                                    auctionHouseAddress:
                                        args.auctionHouseAddress,
                                });

                                let nftName =
                                    args.tokenMint.slice(0, 8) + "...";
                                try {
                                    const nftInfo = await getMENFTByMint(
                                        args.tokenMint,
                                    );
                                    if (nftInfo.name) nftName = nftInfo.name;
                                } catch {
                                    // use truncated mint as fallback name
                                }

                                pendingAction = {
                                    type: "buyNFT",
                                    transaction: tx,
                                    tokenMint: args.tokenMint,
                                    price: args.price,
                                    nftName,
                                };

                                result = {
                                    success: true,
                                    message: `Buy order prepared: "${nftName}" for ${args.price} SOL. Please confirm the transaction.`,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Buy NFT failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        case "list_nft": {
                            const args = JSON.parse(
                                toolCall.function.arguments,
                            );
                            try {
                                // Derive the seller's associated token account for the NFT mint.
                                const tokenAccount =
                                    getAssociatedTokenAddressSync(
                                        new PublicKey(args.tokenMint),
                                        new PublicKey(walletAddress),
                                    ).toBase58();
                                console.log("[magiceden] Creating list tx:", {
                                    tokenMint: args.tokenMint,
                                    priceSOL: args.priceSOL,
                                    tokenAccount,
                                });
                                const tx = await getMEListNFTTx({
                                    seller: walletAddress,
                                    tokenMint: args.tokenMint,
                                    tokenAccount,
                                    priceSol: args.priceSOL,
                                });

                                let nftName =
                                    args.tokenMint.slice(0, 8) + "...";
                                try {
                                    const nftInfo = await getMENFTByMint(
                                        args.tokenMint,
                                    );
                                    if (nftInfo.name) nftName = nftInfo.name;
                                } catch {
                                    // use truncated mint as fallback name
                                }

                                pendingAction = {
                                    type: "listNFT",
                                    transaction: tx,
                                    tokenMint: args.tokenMint,
                                    price: args.priceSOL,
                                    nftName,
                                };

                                result = {
                                    success: true,
                                    message: `Listing prepared: "${nftName}" for ${args.priceSOL} SOL on Magic Eden. Please confirm the transaction.`,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "List NFT failed";
                                result = { error: msg };
                            }
                            break;
                        }

                        default:
                            result = {
                                error: `Unknown tool: ${toolCall.function.name}`,
                            };
                    }
                }

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(result),
                });
                toolResults.push({ name: toolCall.function.name, result });
            }

            const loopParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
                {
                    model: MODEL,
                    messages,
                };
            if (walletAddress) {
                loopParams.tools = tools;
            }
            response = await createChatCompletion(loopParams);

            choice = response.choices[0];
            choice = await maybeForceAction(choice);
        }

        let assistantMessage =
            choice.message.content || "I'm not sure how to help with that.";

        // If an action was successfully prepared (the confirm card will render),
        // the reply must not claim failure. Replace contradictory text.
        if (
            (pendingAction || pendingSwapPlan) &&
            /\b(error|failed|fail|couldn'?t|could not|cannot|unable|insufficient|went wrong|problem|sorry)\b/i.test(
                assistantMessage,
            )
        ) {
            assistantMessage =
                "Your transaction is ready. Review the details below and tap Confirm to proceed.";
        }

        // Force the exact add_liquidity error text verbatim so the model can't
        // garble the balance/amount numbers (the source of the confusing "0 SOL"
        // messages). Only when no action was prepared.
        const forcedLiquidityError = Boolean(liquidityError && !pendingAction);
        if (forcedLiquidityError) {
            assistantMessage = liquidityError as string;
        }

        // When a portfolio card will render, the numbers come from the card (not
        // the model). For a plain "show my portfolio" request, keep the text to a
        // short, number-free intro so the model can't print a mis-transcribed
        // value beside the correct card. But when the user asked to ANALYZE their
        // portfolio or SUGGEST investments, keep the model's analysis/suggestions
        // (the card still renders below the text).
        if (portfolioView && !forcedLiquidityError) {
            const analysisIntent =
                /\b(analy[sz]e|analysis|suggest|suggestion|invest|investment|recommend|advice|advis|opportunit|diversif|allocat|grow|ideas?|strateg|what should i)\b/i.test(
                    message,
                );
            const hasSubstance =
                assistantMessage.trim().length >= 40 &&
                assistantMessage !== "I'm not sure how to help with that.";
            if (!analysisIntent || !hasSubstance) {
                assistantMessage = "Here's your portfolio:";
            }
        }

        const chatResponse: ChatResponse = { message: assistantMessage };
        if (portfolioView) {
            chatResponse.portfolio = portfolioView;
        }
        if (pendingAction) {
            chatResponse.action = pendingAction;
        }
        if (pendingSwapPlan) {
            chatResponse.swapPlan = pendingSwapPlan;
        }

        // Generate quick reply buttons from tool results (only when no pending
        // action or multi-leg swap plan is about to render).
        if (!pendingAction && !pendingSwapPlan && toolResults.length > 0) {
            const qr = generateQuickReplies(toolResults);
            if (qr.length > 0) chatResponse.quickReplies = qr;
        }

        return NextResponse.json(chatResponse);
    } catch (error) {
        console.error("Chat API error:", error);
        return NextResponse.json(
            { error: "Something went wrong. Please try again." },
            { status: 500 },
        );
    }
}
