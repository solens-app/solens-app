const API_KEY = process.env.JUPITER_API_KEY || "";
const BASE_URL = "https://api.jup.ag";
// The price/data API is served from the free lite host. Our swap API key returns
// 401 on the price endpoint (it is not scoped for it), so price calls go here
// without the key. Swap order/execute keep using BASE_URL with the key.
const PRICE_BASE_URL = "https://lite-api.jup.ag";

// Well-known token mints
const KNOWN_MINTS: Record<string, string> = {
    SOL: "So11111111111111111111111111111111111111112",
    // Wrapped SOL shares the native SOL mint. Pinning it here prevents the
    // fuzzy token search from matching a scam token that squats the "WSOL"
    // symbol (those have near-zero price, so a swap "to WSOL" would mint a
    // huge bag of a worthless token instead of wrapped SOL).
    WSOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    JLP: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
    RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    RNDR: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
    JUPUSD: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
};

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function looksLikeMint(value: string): boolean {
    return BASE58_RE.test(value.trim());
}

// A mint embedded in a longer phrase. The "buy" quick replies hand the model a
// prompt like `Swap 0.05 SOL for Jimothy (mint: Ge87…pump)`, and it sometimes
// passes that whole phrase through as the token instead of just the address.
const EMBEDDED_MINT_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

/**
 * The mint the caller actually meant, when the string contains one. An explicit
 * address is always authoritative — resolving it by fuzzy symbol search instead
 * can land on a different token that merely ranks well for the query.
 */
function extractMint(value: string): string | null {
    const trimmed = value.trim();
    if (looksLikeMint(trimmed)) return trimmed;
    const match = trimmed.match(EMBEDDED_MINT_RE);
    return match ? match[0] : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function requestJson<T>(
    baseUrl: string,
    path: string,
    useKey: boolean,
    init?: RequestInit,
    attempt = 0,
): Promise<T> {
    const headers: Record<string, string> = {
        ...(init?.headers as Record<string, string>),
    };
    if (useKey && API_KEY) {
        headers["x-api-key"] = API_KEY;
    }

    const MAX_RETRIES = 3;
    let res: Response;
    try {
        res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    } catch (e) {
        // Network error: retry with backoff before giving up.
        if (attempt < MAX_RETRIES) {
            await sleep(250 * 2 ** attempt);
            return requestJson<T>(baseUrl, path, useKey, init, attempt + 1);
        }
        throw e;
    }

    // Retry transient failures (rate limit + 5xx) with exponential backoff.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(300 * 2 ** attempt);
        return requestJson<T>(baseUrl, path, useKey, init, attempt + 1);
    }

    if (res.status === 429) {
        throw new Error(
            "Rate limited by Jupiter API. Please try again in a few seconds.",
        );
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Jupiter API error (${res.status}): ${text}`);
    }

    return res.json();
}

/** Swap/token API on the keyed pro host. */
function jupiterFetch<T>(path: string, init?: RequestInit): Promise<T> {
    return requestJson<T>(BASE_URL, path, true, init);
}

export async function resolveTokenMint(symbol: string): Promise<string | null> {
    const query = symbol.trim();

    const upper = query.toUpperCase();
    if (KNOWN_MINTS[upper]) return KNOWN_MINTS[upper];

    // A mint address — raw, or embedded in a phrase like "Jimothy (mint: …)" —
    // is used directly rather than fuzzy-searched.
    const explicitMint = extractMint(query);
    if (explicitMint) return explicitMint;

    // Try searching Jupiter token list. Many scam tokens squat popular symbols,
    // so we cannot just take the first result or the first exact-symbol match —
    // those rank by query relevance, not legitimacy. Prefer a verified token,
    // then the deepest-liquidity exact-symbol match, before falling back.
    try {
        const results = await jupiterFetch<
            Array<{
                id: string;
                symbol: string;
                isVerified?: boolean;
                liquidity?: number;
            }>
        >(`/tokens/v2/search?query=${encodeURIComponent(query)}`);
        if (results.length > 0) {
            const liq = (r: { liquidity?: number }) =>
                typeof r.liquidity === "number" ? r.liquidity : 0;
            const exactMatches = results.filter(
                (r) => r.symbol?.toUpperCase() === upper,
            );
            // 1) verified exact-symbol match with the most liquidity
            const verifiedExact = exactMatches
                .filter((r) => r.isVerified)
                .sort((a, b) => liq(b) - liq(a))[0];
            if (verifiedExact) return verifiedExact.id;
            // 2) any verified match
            const verifiedAny = results
                .filter((r) => r.isVerified)
                .sort((a, b) => liq(b) - liq(a))[0];
            if (verifiedAny) return verifiedAny.id;
            // 3) deepest-liquidity exact-symbol match
            const bestExact = exactMatches.sort((a, b) => liq(b) - liq(a))[0];
            if (bestExact) return bestExact.id;
            // 4) last resort: most-liquid result for the query
            return [...results].sort((a, b) => liq(b) - liq(a))[0].id;
        }
    } catch {
        // Fall through
    }

    return null;
}

export interface TokenMeta {
    mint: string;
    symbol: string;
    name: string;
    logo: string | null;
    decimals: number;
}

/**
 * Resolve a mint address to display metadata (symbol, name, icon) via the
 * Jupiter token search. Used to label trades in the social feed. Returns null
 * if the token can't be resolved; callers should fall back to a short mint.
 */
export async function getTokenMeta(mint: string): Promise<TokenMeta | null> {
    const query = mint.trim();
    if (!looksLikeMint(query)) return null;
    try {
        const results = await jupiterFetch<
            Array<{
                id: string;
                symbol?: string;
                name?: string;
                icon?: string;
                decimals?: number;
            }>
        >(`/tokens/v2/search?query=${encodeURIComponent(query)}`);
        // Exact mint only: we searched *by* mint, so a non-matching first result
        // is a different token and would mislabel the trade.
        const hit = results.find((r) => r.id === query);
        if (!hit || !hit.symbol) return null;
        return {
            mint: query,
            symbol: hit.symbol,
            name: hit.name ?? hit.symbol,
            logo: hit.icon ?? null,
            decimals: typeof hit.decimals === "number" ? hit.decimals : getDecimals(query),
        };
    } catch {
        return null;
    }
}

export interface TokenPrice {
    mint: string;
    price: string;
    confidenceLevel?: string;
}

// Short-lived price cache so a single failed/rate-limited Jupiter call does not
// blank out prices we successfully fetched moments ago.
const PRICE_TTL_MS = 30_000;
const PRICE_STALE_FALLBACK_MS = 5 * 60_000;
const priceCache = new Map<
    string,
    { price: string; confidenceLevel?: string; ts: number }
>();

export async function getTokenPrices(mints: string[]): Promise<TokenPrice[]> {
    const now = Date.now();
    const missing = mints.filter((m) => {
        const cached = priceCache.get(m);
        return !cached || now - cached.ts > PRICE_TTL_MS;
    });

    if (missing.length > 0) {
        try {
            const ids = missing.join(",");
            // price/v3 returns a flat map keyed by mint: { "<mint>": { usdPrice, decimals, ... } }
            const data = await requestJson<
                Record<string, { usdPrice?: number } | null>
            >(
                PRICE_BASE_URL,
                `/price/v3?ids=${encodeURIComponent(ids)}`,
                false,
            );
            if (data) {
                for (const mint of missing) {
                    const info = data[mint];
                    if (info && typeof info.usdPrice === "number") {
                        priceCache.set(mint, {
                            price: String(info.usdPrice),
                            ts: Date.now(),
                        });
                    }
                }
            }
        } catch (e) {
            // Network/rate-limit failure: fall back to recent cached values.
            console.error(
                "[jupiter] price fetch failed, using cache where possible:",
                e,
            );
        }
    }

    const results: TokenPrice[] = [];
    for (const mint of mints) {
        const cached = priceCache.get(mint);
        if (cached && Date.now() - cached.ts <= PRICE_STALE_FALLBACK_MS) {
            results.push({
                mint,
                price: cached.price,
                confidenceLevel: cached.confidenceLevel,
            });
        }
    }
    return results;
}

export interface SwapOrder {
    transaction: string; // base64-encoded VersionedTransaction
    requestId: string;
    inputMint: string;
    outputMint: string;
    inputAmount: string;
    estimatedOutput: string | null;
    error?: string;
}

export async function getSwapOrder(
    inputMint: string,
    outputMint: string,
    amount: number,
    inputDecimals: number,
    taker: string,
    outputDecimals?: number,
    // Exact base-unit amount as a string. When provided (e.g. "sell my whole
    // balance" legs), it is used verbatim so we never round *up* past the real
    // balance or mis-size a token whose decimals aren't in the known list.
    rawAmountOverride?: string,
): Promise<SwapOrder> {
    const rawAmount =
        rawAmountOverride && /^\d+$/.test(rawAmountOverride)
            ? rawAmountOverride
            : Math.round(amount * 10 ** inputDecimals).toString();

    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: rawAmount,
        taker,
    });

    const order = await jupiterFetch<{
        transaction: string | null;
        requestId: string;
        outAmount?: string;
        error?: string;
    }>(`/swap/v2/order?${params}`);

    if (!order.transaction) {
        throw new Error(order.error || "Failed to get swap order from Jupiter");
    }

    // Convert raw outAmount to human-readable using output token decimals
    let estimatedOutput: string | null = null;
    if (order.outAmount) {
        const outDecimals = outputDecimals ?? getDecimals(outputMint);
        const raw = parseFloat(order.outAmount);
        estimatedOutput = (raw / 10 ** outDecimals).toFixed(
            Math.min(outDecimals, 6),
        );
    }

    return {
        transaction: order.transaction,
        requestId: order.requestId,
        inputMint,
        outputMint,
        inputAmount: rawAmount,
        estimatedOutput,
    };
}

export interface SwapResult {
    status: string;
    signature?: string;
    code: number;
    inputAmountResult?: string;
    outputAmountResult?: string;
    error?: string;
}

export async function executeSwap(
    signedTransaction: string,
    requestId: string,
): Promise<SwapResult> {
    return jupiterFetch<SwapResult>("/swap/v2/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedTransaction, requestId }),
    });
}

// Helper: get decimals for a mint (SOL = 9, USDC = 6, etc.)
const KNOWN_DECIMALS: Record<string, number> = {
    So11111111111111111111111111111111111111112: 9,
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,
    DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5,
    JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6,
    "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": 6,
    JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: 6,
};

/** Decimals when known up-front, else undefined (caller should resolve on-chain). */
export function getKnownDecimals(mint: string): number | undefined {
    return KNOWN_DECIMALS[mint];
}

export function getDecimals(mint: string): number {
    return KNOWN_DECIMALS[mint] ?? 9;
}

export interface TrendingToken {
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    usdPrice: number | null;
    priceChange24h: number | null; // percent
    mcap: number | null;
    liquidity: number | null;
    volume24h: number | null;
    holderCount: number | null;
    organicScoreLabel: string | null;
    isVerified: boolean;
    tags: string[];
}

// Stablecoins / wrapped SOL we don't want to surface as "trending memecoins".
const TRENDING_EXCLUDE_MINTS = new Set<string>([
    "So11111111111111111111111111111111111111112", // wSOL
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD", // jupUSD
]);

const STABLE_SYMBOL_RE = /^(USD[CT]?|.*USD|PYUSD|USDe|FDUSD|DAI|UXD)$/i;

interface RawTrendingToken {
    id: string;
    symbol: string;
    name: string;
    decimals: number;
    usdPrice?: number;
    mcap?: number;
    liquidity?: number;
    holderCount?: number;
    organicScoreLabel?: string;
    isVerified?: boolean;
    tags?: string[];
    stats24h?: {
        priceChange?: number;
        buyVolume?: number;
        sellVolume?: number;
    };
}

/**
 * Top-traded tokens over an interval from Jupiter's token API, filtered to
 * exclude stablecoins / wrapped SOL. Served from the keyless lite host.
 */
export async function getTrendingTokens(
    interval: "5m" | "1h" | "6h" | "24h" = "24h",
    limit = 10,
): Promise<TrendingToken[]> {
    const raw = await requestJson<RawTrendingToken[]>(
        PRICE_BASE_URL,
        `/tokens/v2/toptraded/${interval}`,
        false,
    );
    if (!Array.isArray(raw)) return [];

    const tokens: TrendingToken[] = [];
    for (const t of raw) {
        if (!t.id || !t.symbol) continue;
        if (TRENDING_EXCLUDE_MINTS.has(t.id)) continue;
        if (STABLE_SYMBOL_RE.test(t.symbol)) continue;

        const vol =
            (t.stats24h?.buyVolume ?? 0) + (t.stats24h?.sellVolume ?? 0);
        tokens.push({
            mint: t.id,
            symbol: t.symbol,
            name: t.name,
            decimals: t.decimals,
            usdPrice: typeof t.usdPrice === "number" ? t.usdPrice : null,
            priceChange24h:
                typeof t.stats24h?.priceChange === "number"
                    ? t.stats24h.priceChange
                    : null,
            mcap: typeof t.mcap === "number" ? t.mcap : null,
            liquidity: typeof t.liquidity === "number" ? t.liquidity : null,
            volume24h: vol || null,
            holderCount:
                typeof t.holderCount === "number" ? t.holderCount : null,
            organicScoreLabel: t.organicScoreLabel ?? null,
            isVerified: Boolean(t.isVerified),
            tags: Array.isArray(t.tags) ? t.tags : [],
        });
        if (tokens.length >= limit) break;
    }
    return tokens;
}
