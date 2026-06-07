const API_KEY = process.env.JUPITER_API_KEY || "";
const BASE_URL = "https://api.jup.ag";

// Well-known token mints
const KNOWN_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  RNDR: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
  JUPUSD: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
};

async function jupiterFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (res.status === 429) {
    throw new Error("Rate limited by Jupiter API. Please try again in a few seconds.");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter API error (${res.status}): ${text}`);
  }

  return res.json();
}

export async function resolveTokenMint(symbol: string): Promise<string | null> {
  const upper = symbol.toUpperCase();
  if (KNOWN_MINTS[upper]) return KNOWN_MINTS[upper];

  // Try searching Jupiter token list
  try {
    const results = await jupiterFetch<Array<{ address: string; symbol: string }>>(
      `/tokens/v2/search?query=${encodeURIComponent(symbol)}`
    );
    if (results.length > 0) {
      return results[0].address;
    }
  } catch {
    // Fall through
  }

  return null;
}

export interface TokenPrice {
  mint: string;
  price: string;
  confidenceLevel?: string;
}

export async function getTokenPrices(mints: string[]): Promise<TokenPrice[]> {
  const ids = mints.join(",");
  const data = await jupiterFetch<{
    data: Record<string, { price: string; confidenceLevel?: string } | null>;
  }>(`/price/v3?ids=${encodeURIComponent(ids)}`);

  const results: TokenPrice[] = [];
  if (!data?.data) return results;
  for (const mint of mints) {
    const info = data.data[mint];
    if (info) {
      results.push({ mint, price: info.price, confidenceLevel: info.confidenceLevel });
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
  taker: string
): Promise<SwapOrder> {
  const rawAmount = Math.round(amount * 10 ** inputDecimals).toString();

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
    const outputDecimals = getDecimals(outputMint);
    const raw = parseFloat(order.outAmount);
    estimatedOutput = (raw / 10 ** outputDecimals).toFixed(Math.min(outputDecimals, 6));
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
  requestId: string
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
  JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: 6,
};

export function getDecimals(mint: string): number {
  return KNOWN_DECIMALS[mint] ?? 9;
}
