/**
 * Trade-meta extraction for the social feed.
 *
 * Given a confirmed swap transaction and the wallet that made it, derive a
 * compact, display-ready summary: which token was traded, the side (buy/sell),
 * the token amount, and the USD size. Everything is read from the wallet's
 * pre/post SPL token balance deltas on the *actual* on-chain transaction, so
 * the feed never fabricates numbers.
 *
 * This is best-effort: any failure returns null and the caller records the
 * event without trade meta (the feed then shows a lean fallback card).
 */

import { Connection } from "@solana/web3.js";
import { getTokenMeta, getTokenPrices } from "@/app/lib/jupiter";

export type TradeMeta = {
  token: { mint: string; symbol: string; logo: string | null };
  side: "buy" | "sell";
  amount: number; // token amount traded (absolute)
  usd: number | null; // USD size of the trade
};

const SOL_MINT = "So11111111111111111111111111111111111111112";
const STABLES = new Set<string>([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD", // jupUSD
]);

// Minimal shape of the token-balance entries we read off a parsed transaction.
type TokenBalance = {
  mint?: string;
  owner?: string;
  uiTokenAmount?: { uiAmount?: number | null };
};

type ParsedTx = {
  meta?: {
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
  } | null;
} | null;

function shortMint(mint: string): string {
  return mint.length > 8 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/**
 * Signed uiAmount deltas per mint for accounts owned by `wallet`.
 * A positive delta means the wallet received that token; negative means it
 * sent it.
 */
function balanceDeltas(tx: ParsedTx, wallet: string): Map<string, number> {
  const deltas = new Map<string, number>();
  const add = (b: TokenBalance, sign: 1 | -1) => {
    if (!b.mint || b.owner !== wallet) return;
    const amt = b.uiTokenAmount?.uiAmount;
    if (typeof amt !== "number" || amt === 0) return;
    deltas.set(b.mint, (deltas.get(b.mint) ?? 0) + sign * amt);
  };
  for (const b of tx?.meta?.postTokenBalances ?? []) add(b, 1);
  for (const b of tx?.meta?.preTokenBalances ?? []) add(b, -1);
  return deltas;
}

/**
 * Derive trade meta from a confirmed swap transaction. Returns null when the
 * traded token can't be identified (e.g. a stable-to-stable move, or a tx with
 * no readable token balances for the wallet).
 */
export async function extractSwapMeta(
  tx: ParsedTx,
  wallet: string,
): Promise<TradeMeta | null> {
  if (!tx?.meta) return null;
  const deltas = balanceDeltas(tx, wallet);
  if (deltas.size === 0) return null;

  // The traded token is the non-stable, non-SOL mint the wallet's balance
  // moved the most — that's the memecoin/alt being bought or sold.
  let tradedMint: string | null = null;
  let tradedDelta = 0;
  for (const [mint, delta] of deltas) {
    if (mint === SOL_MINT || STABLES.has(mint)) continue;
    if (Math.abs(delta) > Math.abs(tradedDelta)) {
      tradedDelta = delta;
      tradedMint = mint;
    }
  }
  if (!tradedMint || tradedDelta === 0) return null;

  const side: "buy" | "sell" = tradedDelta > 0 ? "buy" : "sell";
  const amount = Math.abs(tradedDelta);

  // USD size: prefer the exact stable leg, then the SOL leg × SOL price, then
  // the traded token's own amount × current price. Each is derived from the
  // real balance change; the last is an approximation using live price.
  let usd: number | null = null;

  for (const [mint, delta] of deltas) {
    if (STABLES.has(mint) && Math.abs(delta) > 0) {
      usd = Math.abs(delta);
      break;
    }
  }

  if (usd == null) {
    const solDelta = deltas.get(SOL_MINT);
    if (solDelta && Math.abs(solDelta) > 0) {
      const [p] = await getTokenPrices([SOL_MINT]);
      const solPrice = p ? Number(p.price) : NaN;
      if (Number.isFinite(solPrice)) usd = Math.abs(solDelta) * solPrice;
    }
  }

  if (usd == null) {
    const [p] = await getTokenPrices([tradedMint]);
    const price = p ? Number(p.price) : NaN;
    if (Number.isFinite(price)) usd = amount * price;
  }

  const meta = await getTokenMeta(tradedMint);
  return {
    token: {
      mint: tradedMint,
      symbol: meta?.symbol ?? shortMint(tradedMint),
      logo: meta?.logo ?? null,
    },
    side,
    amount,
    usd: usd != null ? Math.round(usd * 100) / 100 : null,
  };
}

/**
 * Fetch a confirmed swap transaction from the chain and extract its trade meta.
 * Used to back-fill feed metadata for events recorded before enrichment shipped
 * (their `activity_events.meta` has no `trade`). Returns null if the tx can't be
 * fetched or parsed. Server-only (needs SOLANA_RPC_URL).
 */
export async function fetchAndExtractSwap(
  signature: string,
  wallet: string,
): Promise<TradeMeta | null> {
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) return null;
  try {
    const connection = new Connection(rpc, "confirmed");
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) return null;
    return await extractSwapMeta(tx, wallet);
  } catch {
    return null;
  }
}
