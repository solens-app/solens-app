import { Connection, PublicKey, Keypair, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import BN from "bn.js";

const RPC_URL = process.env.SOLANA_RPC_URL!;

function getConnection() {
  return new Connection(RPC_URL, "confirmed");
}

// --- REST API: Pool Discovery ---

const DLMM_API = "https://dlmm.datapi.meteora.ag";

export interface MeteoraPool {
  address: string;
  name: string;
  tokenX: string;
  tokenY: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  tvl: number;
  apr: number;
  apy: number;
  fees24h: number;
  volume24h: number;
  binStep: number;
  baseFee: number;
  currentPrice: number;
}

interface DlmmApiPool {
  address: string;
  name: string;
  token_x: { address: string; symbol: string; decimals: number };
  token_y: { address: string; symbol: string; decimals: number };
  tvl: number;
  apr: number;
  apy: number;
  fees: { hour_1?: number; day_1?: number };
  volume: { hour_1?: number; day_1?: number };
  pool_config: { bin_step: number; base_fee_pct: number };
  current_price: number;
  is_blacklisted: boolean;
}

export async function searchPools(query: string): Promise<MeteoraPool[]> {
  const params = new URLSearchParams({
    page: "1",
    page_size: "10",
    query,
    sort_by: "tvl:desc",
    filter_by: "is_blacklisted=false",
  });

  const res = await fetch(`${DLMM_API}/pools?${params}`);
  if (!res.ok) {
    throw new Error(`DLMM API error (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  const pools: DlmmApiPool[] = json.data || [];

  return pools.map((p) => ({
    address: p.address,
    name: p.name,
    tokenX: p.token_x.address,
    tokenY: p.token_y.address,
    tokenXSymbol: p.token_x.symbol,
    tokenYSymbol: p.token_y.symbol,
    tokenXDecimals: p.token_x.decimals,
    tokenYDecimals: p.token_y.decimals,
    tvl: p.tvl,
    apr: p.apr,
    apy: p.apy,
    fees24h: p.fees?.day_1 ?? 0,
    volume24h: p.volume?.day_1 ?? 0,
    binStep: p.pool_config?.bin_step ?? 0,
    baseFee: p.pool_config?.base_fee_pct ?? 0,
    currentPrice: p.current_price,
  }));
}

export async function getPoolDetails(poolAddress: string): Promise<MeteoraPool | null> {
  const res = await fetch(`${DLMM_API}/pools/${poolAddress}`);
  if (!res.ok) return null;

  const p: DlmmApiPool = await res.json();
  return {
    address: p.address,
    name: p.name,
    tokenX: p.token_x.address,
    tokenY: p.token_y.address,
    tokenXSymbol: p.token_x.symbol,
    tokenYSymbol: p.token_y.symbol,
    tokenXDecimals: p.token_x.decimals,
    tokenYDecimals: p.token_y.decimals,
    tvl: p.tvl,
    apr: p.apr,
    apy: p.apy,
    fees24h: p.fees?.day_1 ?? 0,
    volume24h: p.volume?.day_1 ?? 0,
    binStep: p.pool_config?.bin_step ?? 0,
    baseFee: p.pool_config?.base_fee_pct ?? 0,
    currentPrice: p.current_price,
  };
}

// --- DLMM: User Positions (lightweight, no SDK) ---

// DLMM program ID
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

// PositionV2 layout offsets (total size: 8120 bytes):
// [0..8)     discriminator
// [8..40)    lbPair (pubkey)
// [40..72)   owner (pubkey)
// [72..7912) liquidityShares + rewardInfos + feeInfos
// [7912..7916) lowerBinId (i32)
// [7916..7920) upperBinId (i32)
const POS_LBPAIR_OFFSET = 8;
const POS_OWNER_OFFSET = 40;
const POS_LOWER_BIN_OFFSET = 7912;
const POS_UPPER_BIN_OFFSET = 7916;
const POS_DATA_SIZE = 8120;

export interface UserPosition {
  poolAddress: string;
  positionAddress: string;
  minBinId: number;
  maxBinId: number;
  totalXAmount: string;
  totalYAmount: string;
}

/**
 * Find user positions by scanning recent transaction history for DLMM interactions,
 * then fetching each position account directly with getAccountInfo.
 * This avoids getProgramAccounts which is rate-limited on Alchemy free tier.
 */
export async function getUserPositionsForPool(
  walletAddress: string,
  poolAddress?: string,
): Promise<UserPosition[]> {
  const connection = getConnection();
  const userPubKey = new PublicKey(walletAddress);

  // Step 1: Get recent transaction signatures for the user's DLMM interactions
  const signatures = await connection.getSignaturesForAddress(userPubKey, { limit: 50 });

  // Step 2: Fetch transaction details to find position accounts
  // Process in small batches with delays to avoid rate limits
  const positionAddresses = new Set<string>();
  const batchSize = 5;

  for (let i = 0; i < signatures.length; i += batchSize) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));

    const batch = signatures.slice(i, i + batchSize);
    const txs = await connection.getParsedTransactions(
      batch.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0 }
    );

    for (const tx of txs) {
      if (!tx || tx.meta?.err) continue;

      // Check if this transaction involves the DLMM program
      const accountKeys = tx.transaction.message.accountKeys;
      const involvesDlmm = accountKeys.some(
        (k) => (typeof k === "string" ? k : k.pubkey.toBase58()) === DLMM_PROGRAM_ID.toBase58()
      );

      if (!involvesDlmm) continue;

      // Find writable accounts that could be position accounts
      // Position accounts are signers (on creation) and writable
      for (const key of accountKeys) {
        const pubkey = typeof key === "string" ? key : key.pubkey.toBase58();
        const isWritable = typeof key === "string" ? false : key.writable;

        // Skip known non-position accounts
        if (!isWritable) continue;
        if (pubkey === walletAddress) continue;
        if (pubkey === DLMM_PROGRAM_ID.toBase58()) continue;

        positionAddresses.add(pubkey);
      }
    }

    // Stop early if we've found enough
    if (positionAddresses.size > 0 && i >= 15) break;
  }

  if (positionAddresses.size === 0) return [];

  // Step 3: Check each candidate account to see if it's actually a DLMM position
  // Use getMultipleAccountsInfo for efficiency (single RPC call, batched)
  const candidateKeys = [...positionAddresses].map((a) => new PublicKey(a));
  const positions: UserPosition[] = [];

  // Batch getMultipleAccountsInfo in groups of 100
  for (let i = 0; i < candidateKeys.length; i += 100) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    const batch = candidateKeys.slice(i, i + 100);
    const accounts = await connection.getMultipleAccountsInfo(batch);

    for (let j = 0; j < accounts.length; j++) {
      const account = accounts[j];
      if (!account) continue;

      // Check: is it owned by DLMM program and correct size?
      if (
        account.owner.toBase58() !== DLMM_PROGRAM_ID.toBase58() ||
        account.data.length !== POS_DATA_SIZE
      ) continue;

      const data = account.data;
      const owner = new PublicKey(data.subarray(POS_OWNER_OFFSET, POS_OWNER_OFFSET + 32));

      // Verify this position belongs to our user
      if (owner.toBase58() !== walletAddress) continue;

      const lbPair = new PublicKey(data.subarray(POS_LBPAIR_OFFSET, POS_LBPAIR_OFFSET + 32));

      // If poolAddress filter is provided, check it matches
      if (poolAddress && lbPair.toBase58() !== poolAddress) continue;

      const lowerBinId = data.readInt32LE(POS_LOWER_BIN_OFFSET);
      const upperBinId = data.readInt32LE(POS_UPPER_BIN_OFFSET);

      positions.push({
        poolAddress: lbPair.toBase58(),
        positionAddress: batch[j].toBase58(),
        minBinId: lowerBinId,
        maxBinId: upperBinId,
        totalXAmount: "0",
        totalYAmount: "0",
      });
    }
  }

  // Step 4: Enrich positions with actual token amounts using the DLMM SDK
  // Group positions by pool to minimize SDK calls
  if (positions.length > 0) {
    const poolGroups = new Map<string, UserPosition[]>();
    for (const pos of positions) {
      const group = poolGroups.get(pos.poolAddress) || [];
      group.push(pos);
      poolGroups.set(pos.poolAddress, group);
    }

    for (const [pool, poolPositions] of poolGroups) {
      try {
        // Small delay to avoid rate limits between pools
        await new Promise((r) => setTimeout(r, 1000));

        const dlmm = await DLMM.create(connection, new PublicKey(pool));

        for (const pos of poolPositions) {
          try {
            const posData = await dlmm.getPosition(new PublicKey(pos.positionAddress));
            // Use the SDK's pre-computed user totals (not bin totals)
            pos.totalXAmount = posData.positionData.totalXAmount;
            pos.totalYAmount = posData.positionData.totalYAmount;
          } catch {
            // Keep the "0" values if individual position fetch fails
          }
        }
      } catch (err) {
        console.error(`[meteora] Failed to enrich positions for pool ${pool}:`, err);
        // Positions still returned with "0" amounts
      }
    }
  }

  return positions;
}


// --- DLMM SDK: Add Liquidity ---

export interface AddLiquidityResult {
  transactions: string[]; // base64-encoded serialized transactions
  positionAddress: string;
  poolAddress: string;
}

// Minimum SOL needed for position rent + tx fees (~0.06 SOL)
const MIN_SOL_FOR_POSITION = 0.06;

export async function buildAddLiquidityTx(
  poolAddress: string,
  walletAddress: string,
  amountX: number,
  amountY: number,
  tokenXDecimals: number,
  tokenYDecimals: number,
  numBinsOneSide: number = 10,
): Promise<AddLiquidityResult> {
  const connection = getConnection();
  const pool = new PublicKey(poolAddress);
  const user = new PublicKey(walletAddress);

  // Check SOL balance — creating a DLMM position requires rent (~0.057 SOL)
  const solBalance = await connection.getBalance(user);
  const solBalanceInSol = solBalance / 1e9;
  if (solBalanceInSol < MIN_SOL_FOR_POSITION) {
    throw new Error(
      `Insufficient SOL for transaction fees and position rent. You have ${solBalanceInSol.toFixed(4)} SOL but need at least ~${MIN_SOL_FOR_POSITION} SOL. Please add more SOL to your wallet first.`
    );
  }

  const dlmm = await DLMM.create(connection, pool);

  // Validate token balances before building the transaction
  const tokenXMint = dlmm.tokenX.publicKey;
  const tokenYMint = dlmm.tokenY.publicKey;
  const solMint = "So11111111111111111111111111111111111111112";

  // Check token X balance
  if (amountX > 0) {
    if (tokenXMint.toBase58() === solMint) {
      // For SOL, check native balance (minus rent reserve)
      const solBal = solBalance / LAMPORTS_PER_SOL;
      const available = solBal - MIN_SOL_FOR_POSITION;
      if (amountX > available) {
        throw new Error(
          `Insufficient SOL. You want to deposit ${amountX} SOL but only have ~${available.toFixed(4)} SOL available (after reserving for fees/rent).`
        );
      }
    } else {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(user, { mint: tokenXMint });
      const balance = tokenAccounts.value[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
      if (amountX > balance) {
        throw new Error(
          `Insufficient token balance. You want to deposit ${amountX} but only have ${balance}.`
        );
      }
    }
  }

  // Check token Y balance
  if (amountY > 0) {
    if (tokenYMint.toBase58() === solMint) {
      const solBal = solBalance / LAMPORTS_PER_SOL;
      const available = solBal - MIN_SOL_FOR_POSITION;
      if (amountY > available) {
        throw new Error(
          `Insufficient SOL. You want to deposit ${amountY} SOL but only have ~${available.toFixed(4)} SOL available (after reserving for fees/rent).`
        );
      }
    } else {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(user, { mint: tokenYMint });
      const balance = tokenAccounts.value[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
      if (amountY > balance) {
        throw new Error(
          `Insufficient token balance. You want to deposit ${amountY} but only have ${balance}.`
        );
      }
    }
  }

  const activeBin = await dlmm.getActiveBin();
  const activeBinId = activeBin.binId;

  // Create new position keypair
  const positionKeypair = Keypair.generate();

  // Calculate bin range around active bin
  const minBinId = activeBinId - numBinsOneSide;
  const maxBinId = activeBinId + numBinsOneSide;

  const totalXAmount = new BN(Math.floor(amountX * 10 ** tokenXDecimals));
  const totalYAmount = new BN(Math.floor(amountY * 10 ** tokenYDecimals));

  const strategy: StrategyType = StrategyType.Spot;

  // Build the transaction - creates position and adds liquidity in one tx
  const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      maxBinId,
      minBinId,
      strategyType: strategy,
    },
    user,
    slippage: 100, // 1% slippage in BPS
  });

  // Set fee payer and recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = user;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  // Partial sign with position keypair (server-side)
  tx.partialSign(positionKeypair);

  // Serialize (allow missing user signature)
  const serialized = tx.serialize({ requireAllSignatures: false });
  const base64Tx = Buffer.from(serialized).toString("base64");

  return {
    transactions: [base64Tx],
    positionAddress: positionKeypair.publicKey.toBase58(),
    poolAddress,
  };
}

// --- DLMM SDK: Remove Liquidity ---

export interface RemoveLiquidityResult {
  transactions: string[]; // base64-encoded serialized transactions
  poolAddress: string;
  positionAddress: string;
}

export async function buildRemoveLiquidityTx(
  poolAddress: string,
  walletAddress: string,
  positionAddress: string,
  bpsToRemove: number = 10000, // 100% = 10000 BPS
  shouldClaimAndClose: boolean = true,
): Promise<RemoveLiquidityResult> {
  const connection = getConnection();
  const pool = new PublicKey(poolAddress);
  const user = new PublicKey(walletAddress);
  const position = new PublicKey(positionAddress);

  const dlmm = await DLMM.create(connection, pool);

  // Get position data to know the bin range
  const positionData = await dlmm.getPosition(position);
  const fromBinId = positionData.positionData.lowerBinId;
  const toBinId = positionData.positionData.upperBinId;

  // Build remove liquidity transactions
  const txs = await dlmm.removeLiquidity({
    user,
    position,
    fromBinId,
    toBinId,
    bps: new BN(bpsToRemove),
    shouldClaimAndClose,
  });

  // Set fee payer and recent blockhash for all transactions
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const serializedTxs: string[] = [];

  for (const tx of txs) {
    tx.feePayer = user;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;

    const serialized = tx.serialize({ requireAllSignatures: false });
    serializedTxs.push(Buffer.from(serialized).toString("base64"));
  }

  return {
    transactions: serializedTxs,
    poolAddress,
    positionAddress,
  };
}
