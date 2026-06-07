const BASE_URL = "https://api-mainnet.magiceden.dev/v2";
const API_KEY = process.env.MAGIC_EDEN_API_KEY || "";

async function meFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { ...init, headers });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[magiceden] API error ${res.status} for ${init?.method || "GET"} ${path}:`, text);
    if (res.status === 401) {
      throw new Error(
        "Magic Eden API key required for transaction instructions. Get a free key at https://airtable.com/appe8frCT8yj415Us/pagDL0gFwzsrLUxIB/form and add MAGIC_EDEN_API_KEY to your .env file."
      );
    }
    throw new Error(`Magic Eden API error (${res.status}): ${text}`);
  }

  return res.json();
}

// --- Types ---

export interface MECollectionStats {
  symbol: string;
  floorPrice: number | null; // lamports
  listedCount: number;
  avgPrice24hr: number | null; // lamports
  volumeAll: number | null; // lamports
}

export interface MEListing {
  pdaAddress: string;
  auctionHouse: string;
  tokenAddress: string;
  tokenMint: string;
  seller: string;
  sellerReferral: string;
  tokenSize: number;
  price: number; // SOL
  expiry: number;
  listingSource?: string;
  extra?: { img?: string };
  token?: {
    mintAddress: string;
    name: string;
    image?: string;
    collection?: string;
    collectionName?: string;
    isCompressed?: boolean;
  };
}

export interface MENft {
  mintAddress: string;
  owner: string;
  name: string;
  image?: string;
  collection?: string;
  collectionName?: string;
  listStatus?: string;
  price?: number;
}

// --- Read Operations ---

export async function getCollectionStats(
  symbol: string
): Promise<MECollectionStats> {
  return meFetch<MECollectionStats>(`/collections/${symbol}/stats`);
}

export async function getCollectionListings(
  symbol: string,
  offset = 0,
  limit = 20
): Promise<MEListing[]> {
  return meFetch<MEListing[]>(
    `/collections/${symbol}/listings?offset=${offset}&limit=${limit}`
  );
}

export async function getWalletNFTs(
  walletAddress: string,
  offset = 0,
  limit = 50
): Promise<MENft[]> {
  return meFetch<MENft[]>(
    `/wallets/${walletAddress}/tokens?offset=${offset}&limit=${limit}`
  );
}

export async function getNFTByMint(mintAddress: string): Promise<MENft> {
  return meFetch<MENft>(`/tokens/${mintAddress}`);
}

// --- Transaction Builders ---

export async function getBuyNowTx(params: {
  buyer: string;
  seller: string;
  tokenMint: string;
  tokenATA: string;
  price: number; // SOL
  sellerExpiry: number;
  auctionHouseAddress?: string;
}): Promise<string> {
  const query = new URLSearchParams({
    buyer: params.buyer,
    seller: params.seller,
    tokenMint: params.tokenMint,
    tokenATA: params.tokenATA,
    price: params.price.toString(),
    sellerExpiry: (params.sellerExpiry || 0).toString(),
  });
  if (params.auctionHouseAddress) {
    query.set("auctionHouseAddress", params.auctionHouseAddress);
  }

  const result = await meFetch<{
    tx: { type: string; data: number[] };
  }>(`/instructions/buy_now?${query}`);

  // Convert Buffer data array to base64
  return Buffer.from(new Uint8Array(result.tx.data)).toString("base64");
}

export async function getListNFTTx(params: {
  seller: string;
  tokenMint: string;
  priceLamports: number;
}): Promise<string> {
  // POST to listing endpoint (creates a sell listing on Magic Eden)
  const result = await meFetch<{
    unsignedTransaction: string;
    blockhash: string;
  }>("/instructions/buy_now", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mintAddress: params.tokenMint,
      price: params.priceLamports,
      seller: params.seller,
    }),
  });

  return result.unsignedTransaction;
}
