import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import {
    getSOLBalance,
    getTokenAccounts,
    getWalletOverview,
    getMintDecimals,
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
    mint: string;
    amount: number;
    amountLabel: string;
    usdValue: number | null;
    usdLabel: string;
}

interface PortfolioView {
    walletAddress: string;
    solBalance: number;
    solBalanceLabel: string;
    solUsdValue: number | null;
    solUsdLabel: string;
    tokenCount: number;
    tokens: PortfolioTokenRow[];
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
): PortfolioView {
    const usd = (v: number | null): string =>
        v === null ? "unavailable" : `$${v.toFixed(2)}`;

    const tokens: PortfolioTokenRow[] = overview.tokens.map((t) => ({
        symbol: t.symbol || `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`,
        mint: t.mint,
        amount: t.amount,
        amountLabel: `${t.amountString ?? t.amount}`,
        usdValue: t.usdValue,
        usdLabel: usd(t.usdValue),
    }));

    return {
        walletAddress,
        solBalance: overview.solBalance,
        solBalanceLabel: `${overview.solBalance.toFixed(4)} SOL`,
        solUsdValue: overview.solUsdValue,
        solUsdLabel: usd(overview.solUsdValue),
        tokenCount: overview.tokenCount,
        tokens,
        totalUsdValue: overview.totalUsdValue,
        totalUsdLabel: overview.pricesIncomplete
            ? `${usd(overview.totalUsdValue === null ? sumKnown(overview) : overview.totalUsdValue)} (partial)`
            : usd(overview.totalUsdValue),
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

You can help users with:
0. Transferring SOL or SPL tokens to another wallet - use transfer_sol or transfer_token tools
1. Token swaps using Jupiter DEX - use the initiate_swap tool
2. Providing liquidity on Meteora DLMM pools - use search_meteora_pools to find pools, then add_liquidity to deposit
3. Removing liquidity from Meteora pools - use get_user_positions to find positions, then remove_liquidity to withdraw
4. Launching new tokens on Bags.fm - use launch_token tool
5. Checking token info (creators, lifetime fees) - use get_bags_token_info tool
6. Checking and claiming fees from Bags token launches - use get_claimable_fees and claim_fees tools
7. Prediction markets via Jupiter - search events, place bets on outcomes, view positions, sell positions, claim winnings
8. NFT trading on Magic Eden - search collections, browse listings, buy NFTs, and list your NFTs for sale
9. Trending tokens - use get_trending_tokens to show the hottest / most-traded Solana tokens (memecoins and alts) with live price and 24h change

When showing trending tokens:
- ALWAYS call get_trending_tokens. NEVER make up token names, prices, or percentages.
- Present them as a short ranked list with symbol, price, and 24h change. Add a one-line "not financial advice" caution because many are low-liquidity and volatile.
- To let the user buy one, they can tap a Buy button or ask to swap; use initiate_swap with the token's exact mint.

ALWAYS fetch fresh data. Every time the user asks about their wallet, portfolio, balance, holdings, tokens, positions, or prices, you MUST call the relevant tool again and answer only from that fresh result. NEVER reuse balances, holdings, amounts, or prices from earlier in the conversation, even if they asked moments ago.

For any portfolio / balance / "total value" request, call get_wallet_overview (a single call). The app renders the balances and USD values as a portfolio card from exact computed data, so keep your reply to a brief intro and do NOT restate the SOL balance, token amounts, or dollar values in text (the card already shows them accurately).

ALWAYS use a tool to perform actions. For any swap, transfer, liquidity, launch, prediction, or NFT request you MUST call the matching tool (e.g. initiate_swap) BEFORE describing it. NEVER state a swap quote, estimated output, or "confirm in the UI" unless a tool returned that data in this same turn. If the user says "try again", "retry", or "do it again" after an action, call the tool again to build a fresh transaction.

Token naming: jupUSD (also written JupUSD, mint JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD) is Jupiter's USD stablecoin worth about $1. It is NOT the same as JUP (the governance token, mint JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN). When the user says jupUSD, never substitute JUP, and pass "jupUSD" as the token symbol.

When showing a swap quote, clearly display:
- What they're swapping (amount + token)
- What they'll receive
- Then tell them to confirm the swap in the UI
- The 'amount' passed to initiate_swap is always in units of the INPUT token, never USD. If the user gives a dollar amount (e.g. "swap $6 of SOL"), first get the token's USD price (get_sol_balance returns usdValue for SOL, or use get_token_price), then divide to get the token amount. If no reliable price is available, ask the user to specify the amount in tokens instead of guessing.
- If a swap request includes an explicit mint address (e.g. "Swap 0.05 SOL for FOO (mint: <mint>)"), pass that exact mint string as the outputToken so the correct token is bought.
- Never say a swap is ready or present a quote unless initiate_swap returned success. If it returned an error, state the error plainly and do not invent numbers.

When showing USD values:
- Use the usdValue, usdPrice, solUsdValue, and totalUsdValue fields returned by get_sol_balance and get_wallet_overview. These are computed exactly in code. Do not round a unit price first and then multiply yourself.
- If a tool reports pricesIncomplete or a null usdValue, tell the user the USD value is unavailable right now rather than estimating it.

When helping with Meteora liquidity:
- First search for the pool using search_meteora_pools with the token pair name (e.g. "SOL-USDC")
- Show pool details: name, TVL, APR, current price, bin step
- For adding liquidity, just specify the pool address, the token symbol the user wants to deposit, and the amount. The backend will calculate the matching amount for the other token automatically based on the pool's current price.
- For checking positions: just call get_user_positions once — it automatically scans transaction history to find all positions. Do NOT search pools first or call it multiple times.
- For removing liquidity, first use get_user_positions with the pool address to find the user's positions, then call remove_liquidity with the position address
- Liquidity is added using a Spot strategy around the active bin (current price)
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
- To place a bet: use buy_prediction with the exact marketId string, side (YES or NO), and amount in USD (minimum $1). Bets are paid with USDC or jupUSD and the backend automatically uses whichever the user has enough of (USDC preferred), so never tell the user they lack USDC without accounting for jupUSD.
- Use get_prediction_positions to see the user's open positions with P&L
- Use sell_prediction to close/sell a position (sells all contracts)
- Use claim_prediction to claim winnings from a settled market
- Price = probability. 70¢ YES = 70% chance. If you buy YES at 70¢ and YES wins, profit is 30¢ per contract. Losing contracts expire worthless.
- Each winning contract pays out exactly $1.00 with no claim fees.
- When showing markets to users, always include the marketId so they can reference it.

When helping with NFT trading on Magic Eden:
- Use search_nft_collection to look up a collection by its symbol (lowercase with underscores, e.g. "okay_bears", "degods", "mad_lads", "tensorians")
- Use get_nft_listings to see active listings with prices, sellers, and listing details
- To buy an NFT, use buy_nft with the EXACT listing data from get_nft_listings (tokenMint, seller, tokenAddress as tokenATA, price, expiry, auctionHouse). Do NOT modify or omit these values.
- To list (sell) an NFT, first check the user's NFTs with get_my_nfts, then use list_nft with the mint address and desired price in SOL
- Collection symbols are lowercase with underscores (e.g. "okay_bears" not "Okay Bears")
- Floor prices and volume from stats are in lamports (already converted to SOL in results)
- Listing prices are in SOL
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
                            "The amount of the input token to swap (in human-readable units, e.g. 0.1 for 0.1 SOL)",
                    },
                },
                required: ["inputToken", "outputToken", "amount"],
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
    {
        type: "function",
        function: {
            name: "search_nft_collection",
            description:
                "Searches for an NFT collection on Magic Eden by its symbol. Returns collection stats including floor price, listed count, and volume. Use when the user asks about an NFT collection or wants to browse/buy/sell NFTs.",
            parameters: {
                type: "object",
                properties: {
                    symbol: {
                        type: "string",
                        description:
                            "The collection symbol on Magic Eden (e.g. 'okay_bears', 'degods', 'mad_lads', 'tensorians'). Use lowercase with underscores.",
                    },
                },
                required: ["symbol"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_nft_listings",
            description:
                "Gets active NFT listings for sale in a collection on Magic Eden. Returns listed NFTs with prices, seller addresses, and all data needed for buying. Use after search_nft_collection to view what's for sale.",
            parameters: {
                type: "object",
                properties: {
                    symbol: {
                        type: "string",
                        description:
                            "The collection symbol (e.g. 'okay_bears')",
                    },
                    limit: {
                        type: "number",
                        description:
                            "Number of listings to return (default 10, max 20)",
                    },
                },
                required: ["symbol"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_my_nfts",
            description:
                "Gets the user's NFT holdings from their wallet. Shows all NFTs they own with collection info, names, and list status. Use when the user wants to see their NFTs or list one for sale.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "buy_nft",
            description:
                "Buys a listed NFT on Magic Eden. Requires listing details from get_nft_listings results. Returns a transaction for the user to sign. IMPORTANT: Pass the EXACT values from the listing data — do not modify seller, tokenMint, tokenAddress, price, or expiry.",
            parameters: {
                type: "object",
                properties: {
                    tokenMint: {
                        type: "string",
                        description:
                            "The NFT's mint address (from listing data)",
                    },
                    seller: {
                        type: "string",
                        description:
                            "The seller's wallet address (from listing data)",
                    },
                    tokenATA: {
                        type: "string",
                        description:
                            "The seller's token account address (tokenAddress field from listing data)",
                    },
                    price: {
                        type: "number",
                        description:
                            "The listing price in SOL (priceRaw from listing data)",
                    },
                    sellerExpiry: {
                        type: "number",
                        description:
                            "The seller's expiry timestamp (expiry field from listing data, 0 if not set)",
                    },
                    auctionHouseAddress: {
                        type: "string",
                        description:
                            "The auction house address (auctionHouse from listing data, optional)",
                    },
                },
                required: ["tokenMint", "seller", "tokenATA", "price"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_nft",
            description:
                "Lists a user's NFT for sale on Magic Eden at a specified price. Returns a transaction for the user to sign. The user must own the NFT. Use get_my_nfts first to find the NFT's mint address.",
            parameters: {
                type: "object",
                properties: {
                    tokenMint: {
                        type: "string",
                        description:
                            "The NFT's mint address (from get_my_nfts results)",
                    },
                    priceSOL: {
                        type: "number",
                        description:
                            "The listing price in SOL (e.g. 1.5 for 1.5 SOL)",
                    },
                },
                required: ["tokenMint", "priceSOL"],
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
    quickReplies?: { label: string; prompt: string }[];
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
}

function generateQuickReplies(
    results: { name: string; result: unknown }[],
): { label: string; prompt: string }[] {
    const replies: { label: string; prompt: string }[] = [];

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
            for (const event of events.slice(0, 4)) {
                for (const market of event.markets.slice(0, 2)) {
                    const title =
                        market.title.length > 50
                            ? market.title.slice(0, 47) + "..."
                            : market.title;
                    replies.push({
                        label: `YES ${market.yesPrice} · ${title}`,
                        prompt: `Bet YES on market ${market.marketId}`,
                    });
                    replies.push({
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

        // NFT collection search → view listings button
        if (name === "search_nft_collection" && data.symbol) {
            replies.push({
                label: `View ${data.symbol} listings`,
                prompt: `Show me the NFT listings for ${data.symbol as string}`,
            });
        }

        // NFT listings → buy buttons
        if (name === "get_nft_listings" && Array.isArray(data.listings)) {
            const listings = data.listings as {
                tokenMint: string;
                name: string;
                price: string;
                priceRaw: number;
            }[];
            for (const l of listings.slice(0, 5)) {
                const label =
                    l.name.length > 20 ? l.name.slice(0, 17) + "..." : l.name;
                replies.push({
                    label: `Buy "${label}" · ${l.price}`,
                    prompt: `Buy the NFT "${l.name}" with mint ${l.tokenMint}`,
                });
            }
        }

        // User NFTs → list buttons
        if (name === "get_my_nfts" && Array.isArray(data.nfts)) {
            const nfts = data.nfts as {
                mintAddress: string;
                name: string;
                listStatus: string;
            }[];
            for (const n of nfts
                .filter((n) => n.listStatus !== "listed")
                .slice(0, 5)) {
                const label =
                    n.name.length > 25 ? n.name.slice(0, 22) + "..." : n.name;
                replies.push({
                    label: `List "${label}"`,
                    prompt: `List my NFT "${n.name}" (${n.mintAddress}) for sale`,
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
        let portfolioView: PortfolioView | undefined;
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
                    "You described an action but did not call a tool. Call the correct tool now (initiate_swap, transfer_sol, transfer_token, add_liquidity, buy_prediction, buy_nft, list_nft, etc.) to actually prepare it. Do not quote or describe the action again without calling the tool.",
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
                    pendingAction &&
                    ACTION_TOOLS.has(toolCall.function.name)
                ) {
                    // An action transaction is already prepared this turn. Do not
                    // build another (a duplicate call can fail transiently and make
                    // the reply claim failure even though the card is valid).
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

                        case "get_token_accounts":
                            result = await getTokenAccounts(walletAddress);
                            break;

                        case "get_wallet_overview": {
                            const overview = await computeWalletUsd(
                                await getWalletOverview(walletAddress),
                            );
                            portfolioView = buildPortfolioView(
                                overview,
                                walletAddress,
                            );
                            result = overview;
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
                            const { inputToken, outputToken, amount } = args;

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

                                const inputDecimals =
                                    getKnownDecimals(inputMint) ??
                                    (await getMintDecimals(inputMint));
                                const outputDecimals =
                                    getKnownDecimals(outputMint) ??
                                    (await getMintDecimals(outputMint));

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

                            try {
                                const pool = await getPoolDetails(poolAddress);
                                if (!pool) {
                                    result = { error: "Pool not found." };
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
                                    result = {
                                        error: `Token ${depositToken} is not in this pool. This pool has ${pool.tokenXSymbol} and ${pool.tokenYSymbol}.`,
                                    };
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

                                const txResult = await buildAddLiquidityTx(
                                    poolAddress,
                                    walletAddress,
                                    amountX,
                                    amountY,
                                    pool.tokenXDecimals,
                                    pool.tokenYDecimals,
                                );

                                pendingAction = {
                                    type: "addLiquidity",
                                    transactions: txResult.transactions,
                                    poolAddress,
                                    positionAddress: txResult.positionAddress,
                                    poolName: pool.name,
                                    amountX,
                                    amountY,
                                    tokenXSymbol: pool.tokenXSymbol,
                                    tokenYSymbol: pool.tokenYSymbol,
                                };

                                result = {
                                    success: true,
                                    message: `Liquidity deposit prepared for ${pool.name}: ${amountX.toFixed(6)} ${pool.tokenXSymbol} + ${amountY.toFixed(6)} ${pool.tokenYSymbol}. Transaction ready for user to sign and confirm.`,
                                    positionAddress: txResult.positionAddress,
                                };
                            } catch (error) {
                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : "Add liquidity failed";
                                result = { error: msg };
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

                                    const mapped = events
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
                                                        m.closeTime - nowSec >
                                                            MIN_TIME_LEFT,
                                                )
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
                                                "No open prediction markets found. All matching markets are closed or expired.",
                                        };
                                    } else {
                                        result = {
                                            events: mapped,
                                            _note: "IMPORTANT: Use the exact marketId string (e.g. POLY-1928733-0) when calling buy_prediction. Do NOT use event titles or numbers.",
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
            pendingAction &&
            /\b(error|failed|fail|couldn'?t|could not|cannot|unable|insufficient|went wrong|problem|sorry)\b/i.test(
                assistantMessage,
            )
        ) {
            assistantMessage =
                "Your transaction is ready. Review the details below and tap Confirm to proceed.";
        }

        // When a portfolio card will render, the numbers come from the card (not the
        // model), so keep the text to a short, number-free intro to avoid the model
        // printing a mis-transcribed value alongside the correct card.
        if (portfolioView) {
            assistantMessage = "Here's your portfolio:";
        }

        const chatResponse: ChatResponse = { message: assistantMessage };
        if (portfolioView) {
            chatResponse.portfolio = portfolioView;
        }
        if (pendingAction) {
            chatResponse.action = pendingAction;
        }

        // Generate quick reply buttons from tool results (only when no pending action)
        if (!pendingAction && toolResults.length > 0) {
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
