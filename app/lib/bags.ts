const BAGS_API_KEY = process.env.BAGS_API_KEY || "";
const BAGS_BASE_URL = "https://public-api-v2.bags.fm/api/v1";

async function bagsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BAGS_API_KEY) {
    throw new Error("BAGS_API_KEY is not configured. Please add it to your .env file.");
  }

  const headers: Record<string, string> = {
    "x-api-key": BAGS_API_KEY,
    ...(init?.headers as Record<string, string>),
  };

  const res = await fetch(`${BAGS_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  const body = await res.json();

  if (!res.ok) {
    const errMsg = body?.error || body?.response || JSON.stringify(body);
    throw new Error(`Bags API error (${res.status}): ${errMsg}`);
  }

  // Bags API returns { success: false, error: "..." } even on 200 sometimes
  if (body.success === false) {
    const errMsg = body.error || body.response || "Unknown error";
    throw new Error(`Bags API: ${errMsg}`);
  }

  return body;
}

// --- Token Info & Analytics ---

export interface TokenCreator {
  username: string;
  pfp: string;
  royaltyBps: number;
  isCreator: boolean;
  wallet: string;
  provider: string;
  providerUsername: string;
}

export async function getTokenCreators(tokenMint: string): Promise<TokenCreator[]> {
  const data = await bagsFetch<{ success: boolean; response: TokenCreator[] }>(
    `/token-launch/creator/v3?tokenMint=${encodeURIComponent(tokenMint)}`
  );
  return data.response;
}

export async function getTokenLifetimeFees(tokenMint: string): Promise<string> {
  const data = await bagsFetch<{ success: boolean; response: string }>(
    `/token-launch/lifetime-fees?tokenMint=${encodeURIComponent(tokenMint)}`
  );
  return data.response; // lamports as string
}

// --- Claimable Positions ---

export interface ClaimablePosition {
  programId: string;
  isCustomFeeVault: boolean;
  baseMint: string;
  quoteMint: string | null;
  virtualPool: string;
  virtualPoolAddress: string | null;
  virtualPoolClaimableAmount: number | null;
  virtualPoolClaimableLamportsUserShare: number | null;
  dammPoolClaimableAmount: number | null;
  dammPoolClaimableLamportsUserShare: number | null;
  isMigrated: boolean;
  dammPoolAddress: string | null;
  dammPositionInfo: Record<string, unknown> | null;
  totalClaimableLamportsUserShare: number;
  claimableDisplayAmount: number | null;
  user: string;
}

export async function getClaimablePositions(walletAddress: string): Promise<ClaimablePosition[]> {
  const data = await bagsFetch<{ success: boolean; response: ClaimablePosition[] }>(
    `/token-launch/claimable-positions?wallet=${encodeURIComponent(walletAddress)}`
  );
  return data.response;
}

// --- Fee Claim Transactions ---

export interface ClaimTxResponse {
  transactions: Array<{
    blockhash: { blockhash: string; lastValidBlockHeight: number };
    transaction: string; // base58 encoded
  }>;
}

export async function createClaimTransactions(params: {
  feeClaimer: string;
  tokenMint: string;
  virtualPoolAddress: string;
  dammV2Position?: string;
  dammV2Pool?: string;
  dammV2PositionNftAccount?: string;
  tokenAMint?: string;
  tokenBMint?: string;
  tokenAVault?: string;
  tokenBVault?: string;
  claimVirtualPoolFees: boolean;
  claimDammV2Fees: boolean;
  isCustomFeeVault: boolean;
  feeShareProgramId: string;
}): Promise<ClaimTxResponse> {
  const data = await bagsFetch<{ success: boolean; response: ClaimTxResponse }>(
    "/token-launch/claim-txs/v2",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }
  );
  return data.response;
}

// --- Token Launch ---

export interface TokenInfoResponse {
  tokenMint: string;
  tokenMetadata: string; // IPFS URI
}

export async function createTokenInfo(params: {
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  twitter?: string;
  website?: string;
  telegram?: string;
}): Promise<TokenInfoResponse> {
  const data = await bagsFetch<{ success: boolean; response: TokenInfoResponse }>(
    "/token-launch/create-token-info",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }
  );
  return data.response;
}

export interface FeeShareConfigResponse {
  needsCreation: boolean;
  feeShareAuthority: string;
  meteoraConfigKey: string;
  transactions: Array<{
    transaction: string; // base58 encoded
    blockhash: { blockhash: string; lastValidBlockHeight: number };
  }>;
  bundles: string[][];
}

export async function createFeeShareConfig(params: {
  payer: string;
  baseMint: string;
  feeClaimers: Array<{ user: string; userBps: number }>;
  partner?: string;
  partnerConfig?: string;
}): Promise<FeeShareConfigResponse> {
  const body = {
    payer: params.payer,
    baseMint: params.baseMint,
    claimersArray: params.feeClaimers.map((fc) => fc.user),
    basisPointsArray: params.feeClaimers.map((fc) => fc.userBps),
    partner: params.partner,
    partnerConfig: params.partnerConfig,
    additionalLookupTables: [],
  };

  const data = await bagsFetch<{ success: boolean; response: FeeShareConfigResponse }>(
    "/fee-share/config",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return data.response;
}

/**
 * Creates a launch transaction. Returns the base58-encoded transaction string directly.
 */
export async function createLaunchTransaction(params: {
  ipfs: string;
  tokenMint: string;
  wallet: string;
  initialBuyLamports: number;
  configKey: string;
}): Promise<string> {
  const data = await bagsFetch<{ success: boolean; response: string }>(
    "/token-launch/create-launch-transaction",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }
  );
  return data.response; // base58-encoded transaction string
}

// --- Claim Stats ---

export interface ClaimStat {
  username: string;
  pfp: string;
  royaltyBps: number;
  isCreator: boolean;
  wallet: string;
  provider: string;
  providerUsername: string;
  totalClaimed: string;
}

export async function getTokenClaimStats(tokenMint: string): Promise<ClaimStat[]> {
  const data = await bagsFetch<{ success: boolean; response: ClaimStat[] }>(
    `/token-launch/claim-stats?tokenMint=${encodeURIComponent(tokenMint)}`
  );
  return data.response;
}
