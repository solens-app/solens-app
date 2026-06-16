const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const PREDICTION_BASE_URL = "https://api.jup.ag/prediction/v1";

// USDC mint on Solana
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function predictionFetch<T>(
    path: string,
    init?: RequestInit,
    attempt = 0,
): Promise<T> {
    const headers: Record<string, string> = {
        "x-api-key": JUPITER_API_KEY,
        ...(init?.headers as Record<string, string>),
    };

    const MAX_RETRIES = 3;
    let res: Response;
    try {
        res = await fetch(`${PREDICTION_BASE_URL}${path}`, {
            ...init,
            headers,
        });
    } catch (e) {
        if (attempt < MAX_RETRIES) {
            await sleep(300 * 2 ** attempt);
            return predictionFetch<T>(path, init, attempt + 1);
        }
        throw e;
    }

    // Retry transient upstream failures (rate limit + 5xx) with backoff.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(400 * 2 ** attempt);
        return predictionFetch<T>(path, init, attempt + 1);
    }

    if (!res.ok) {
        let errMsg: string;
        try {
            const body = await res.json();
            errMsg = body.message || body.error || JSON.stringify(body);
        } catch {
            errMsg = await res.text();
        }
        throw new Error(`Prediction API error (${res.status}): ${errMsg}`);
    }

    return res.json();
}

// --- Types ---

export interface PredictionEvent {
    eventId: string;
    isActive: boolean;
    isLive: boolean;
    category: string;
    subcategory: string;
    tags: string[];
    metadata: {
        eventId: string;
        title: string;
        subtitle: string;
        slug: string;
        series: string;
        closeTime: string;
        imageUrl: string;
        isLive: boolean;
    };
    markets?: PredictionMarket[];
    volumeUsd: string;
    closeCondition: string;
    beginAt: string | null;
}

export interface PredictionMarket {
    marketId: string;
    status: "open" | "closed" | "cancelled";
    result: null | "yes" | "no";
    title: string;
    openTime: number;
    closeTime: number;
    resolveAt: number | null;
    marketResultPubkey: string | null;
    imageUrl: string;
    metadata: {
        title: string;
        status: string;
        openTime: number;
        closeTime: number;
        isTeamMarket: boolean;
        rulesPrimary: string;
        rulesSecondary: string;
    };
    pricing: {
        buyYesPriceUsd: number | null;
        buyNoPriceUsd: number | null;
        sellYesPriceUsd: number | null;
        sellNoPriceUsd: number | null;
        volume: number;
    };
}

export interface PredictionPosition {
    pubkey: string;
    ownerPubkey: string;
    marketId: string;
    isYes: boolean;
    contracts: string;
    avgPriceUsd: string;
    totalCostUsd: string;
    sizeUsd: string;
    valueUsd: string | null;
    markPriceUsd: string | null;
    sellPriceUsd: string | null;
    pnlUsd: string | null;
    pnlUsdPercent: number | null;
    pnlUsdAfterFees: string | null;
    pnlUsdAfterFeesPercent: number | null;
    realizedPnlUsd: number;
    feesPaidUsd: string;
    payoutUsd: string;
    claimable: boolean;
    claimed: boolean;
    claimedUsd: string;
    openOrders: number;
    openedAt: number;
    updatedAt: number;
    claimableAt: number | null;
    settlementDate: number | null;
    eventMetadata: {
        eventId: string;
        title: string;
        subtitle: string;
        imageUrl: string;
        isLive: boolean;
        isActive: boolean;
        category: string;
        subcategory: string;
    };
    marketMetadata: {
        marketId: string;
        eventId: string;
        title: string;
        subtitle: string;
        description: string;
        status: string;
        result: string;
        openTime: number;
        closeTime: number;
    };
}

export interface CreateOrderResponse {
    transaction: string; // base64 encoded unsigned transaction
    txMeta: {
        blockhash: string;
        lastValidBlockHeight: number;
    };
    order: {
        orderPubkey: string;
        positionPubkey: string;
        contracts: string;
        orderCostUsd: string;
        estimatedTotalFeeUsd: string;
    };
}

export interface ClosePositionResponse {
    transaction: string; // base64 encoded unsigned transaction
    txMeta: {
        blockhash: string;
        lastValidBlockHeight: number;
    };
}

export interface ClaimResponse {
    transaction: string; // base64 encoded unsigned transaction
    position: {
        pubkey: string;
        contracts: string;
        payoutAmountUsd: string;
    };
    blockhash: string;
    lastValidBlockHeight: number;
}

// --- Helper ---

/** Convert micro USD (1,000,000 = $1) to display string */
export function microUsdToDisplay(microUsd: string | number | null): string {
    if (microUsd === null || microUsd === undefined) return "N/A";
    return (Number(microUsd) / 1_000_000).toFixed(2);
}

/**
 * Convert USD to micro USD string for the API.
 * Adds a small buffer (1%) to avoid "Minimum order is $1" errors —
 * the API requires depositAmount to strictly exceed fees + contract cost.
 */
export function usdToMicro(usd: number): string {
    const buffered = usd * 1.01; // 1% buffer for fees
    return Math.round(buffered * 1_000_000).toString();
}

// --- API Functions ---

/**
 * List prediction events with optional filters.
 */
export async function listEvents(params?: {
    category?: string;
    filter?: string;
    includeMarkets?: boolean;
    start?: number;
    end?: number;
}): Promise<{
    data: PredictionEvent[];
    pagination: { total: number; hasNext: boolean };
}> {
    const searchParams = new URLSearchParams();
    if (params?.category) searchParams.set("category", params.category);
    if (params?.filter) searchParams.set("filter", params.filter);
    if (params?.includeMarkets) searchParams.set("includeMarkets", "true");
    if (params?.start !== undefined)
        searchParams.set("start", params.start.toString());
    if (params?.end !== undefined)
        searchParams.set("end", params.end.toString());

    const query = searchParams.toString();
    return predictionFetch(`/events${query ? `?${query}` : ""}`);
}

/**
 * Search events by keyword. Enriches results with market data
 * since the search endpoint returns empty markets arrays.
 */
export async function searchEvents(
    query: string,
    limit: number = 5,
): Promise<{ data: PredictionEvent[] }> {
    const result = await predictionFetch<{ data: PredictionEvent[] }>(
        `/events/search?${new URLSearchParams({ query, limit: limit.toString() })}`,
    );

    // Search endpoint returns empty markets — fetch each event to get markets
    const enriched = await Promise.all(
        result.data.map(async (event) => {
            try {
                const full = await getEvent(event.eventId);
                return { ...event, markets: full.markets };
            } catch {
                return event;
            }
        }),
    );

    return { data: enriched };
}

/**
 * Get a single event with its markets.
 */
export async function getEvent(eventId: string): Promise<PredictionEvent> {
    return predictionFetch(`/events/${encodeURIComponent(eventId)}`);
}

/**
 * Get market details including pricing.
 */
export async function getMarket(marketId: string): Promise<PredictionMarket> {
    return predictionFetch(`/markets/${encodeURIComponent(marketId)}`);
}

/**
 * Create a buy order. Returns an unsigned base64 transaction.
 */
export async function createOrder(params: {
    ownerPubkey: string;
    marketId: string;
    isYes: boolean;
    depositAmountUsd: number; // in USD (e.g. 2.0 = $2)
    depositMint?: string; // stablecoin to pay with (defaults to USDC)
}): Promise<CreateOrderResponse> {
    const body = JSON.stringify({
        ownerPubkey: params.ownerPubkey,
        marketId: params.marketId,
        isYes: params.isYes,
        isBuy: true,
        depositAmount: usdToMicro(params.depositAmountUsd),
        depositMint: params.depositMint || USDC_MINT,
    });

    // This endpoint only returns an unsigned transaction (no on-chain effect),
    // and it is occasionally flaky on the first hit, so retrying is safe and
    // prevents a transient first failure from reaching the user.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await predictionFetch<CreateOrderResponse>("/orders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            });
        } catch (e) {
            lastErr = e;
            await sleep(400 * 2 ** attempt);
        }
    }
    throw lastErr;
}

/**
 * Get user's prediction positions.
 */
export async function getPositions(ownerPubkey: string): Promise<{
    data: PredictionPosition[];
    pagination: { total: number; hasNext: boolean };
}> {
    const params = new URLSearchParams({ ownerPubkey });
    return predictionFetch(`/positions?${params}`);
}

/**
 * Close (sell all contracts in) a position.
 */
export async function closePosition(
    positionPubkey: string,
    ownerPubkey: string,
): Promise<ClosePositionResponse> {
    return predictionFetch(`/positions/${encodeURIComponent(positionPubkey)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerPubkey }),
    });
}

/**
 * Claim payout from a winning position.
 */
export async function claimPayout(
    positionPubkey: string,
    ownerPubkey: string,
): Promise<ClaimResponse> {
    return predictionFetch(
        `/positions/${encodeURIComponent(positionPubkey)}/claim`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerPubkey }),
        },
    );
}

/**
 * Check order status after submission.
 */
export async function getOrderStatus(
    orderPubkey: string,
): Promise<{ status: string; [key: string]: unknown }> {
    return predictionFetch(`/orders/status/${encodeURIComponent(orderPubkey)}`);
}
