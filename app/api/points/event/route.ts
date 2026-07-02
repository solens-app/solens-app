import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import {
  canonicalEventType,
  ONCHAIN_EVENTS,
  recordEvent,
  type CanonicalEvent,
} from "@/app/lib/points";
import { extractSwapMeta } from "@/app/lib/trade-meta";

export const dynamic = "force-dynamic";

const RPC_URL = process.env.SOLANA_RPC_URL;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Confirm a transaction signature landed successfully and that `wallet` is one
 * of its account keys, returning the fetched transaction so callers can enrich
 * feed metadata from it. `ok` is true only for a real, successful, on-chain tx
 * that involves the wallet. Retries briefly because `confirmed` state can lag a
 * freshly-broadcast tx.
 */
async function verifyOnChain(
  signature: string,
  wallet: string,
): Promise<{ ok: boolean; tx: VersionedTransactionResponse | null }> {
  if (!RPC_URL) throw new Error("SOLANA_RPC_URL is not configured");
  const connection = new Connection(RPC_URL, "confirmed");

  let walletPk: PublicKey;
  try {
    walletPk = new PublicKey(wallet);
  } catch {
    return { ok: false, tx: null };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    let tx: VersionedTransactionResponse | null;
    try {
      tx = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    } catch {
      tx = null;
    }

    if (tx) {
      if (tx.meta?.err) return { ok: false, tx: null }; // transaction failed on-chain
      let keys: PublicKey[] = [];
      try {
        const ak = tx.transaction.message.getAccountKeys({
          accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined,
        });
        keys = ak.keySegments().flat();
      } catch {
        const legacy = (tx.transaction.message as unknown as { accountKeys?: PublicKey[] }).accountKeys;
        keys = legacy ?? [];
      }
      return { ok: keys.some((k) => k.equals(walletPk)), tx };
    }

    if (attempt < 4) await sleep(800 * (attempt + 1));
  }
  return { ok: false, tx: null }; // not found after retries
}

/**
 * POST /api/points/event
 * Body: { wallet, type, signature?, meta? }
 *
 * Records a real activity event. On-chain action types are verified against
 * the chain (must have landed successfully and involve the wallet) before
 * being recorded. Recording is idempotent: an on-chain event keys on its
 * signature, a once-only interaction keys on the wallet.
 */
export async function POST(request: NextRequest) {
  let body: { wallet?: unknown; type?: unknown; signature?: unknown; meta?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const rawType = typeof body.type === "string" ? body.type.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  const meta = body.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : {};

  if (!wallet) return NextResponse.json({ error: "Missing wallet" }, { status: 400 });

  const type = canonicalEventType(rawType) as CanonicalEvent | null;
  if (!type) return NextResponse.json({ error: `Unknown event type: ${rawType}` }, { status: 400 });

  try {
    if (ONCHAIN_EVENTS.has(type)) {
      if (!signature) {
        return NextResponse.json({ error: "Missing signature for on-chain event" }, { status: 400 });
      }
      const { ok, tx } = await verifyOnChain(signature, wallet);
      if (!ok) {
        // Not (yet) confirmed, failed, or wallet not involved — do not award.
        return NextResponse.json({ recorded: false, verified: false }, { status: 202 });
      }

      // Enrich swaps with feed metadata (traded token, side, USD size) parsed
      // from the confirmed tx. Best-effort: never let this block recording.
      let enrichedMeta = meta;
      if (type === "swap" && tx) {
        try {
          const trade = await extractSwapMeta(tx, wallet);
          if (trade) enrichedMeta = { ...meta, trade };
        } catch (e) {
          console.error("[points] swap meta enrichment failed", e instanceof Error ? e.message : e);
        }
      }

      const result = await recordEvent({
        wallet,
        type,
        signature,
        dedupeKey: `sig:${signature}`,
        meta: enrichedMeta,
      });
      return NextResponse.json({ ...result, verified: true });
    }

    // Interaction event (wallet_connect / ai_message): once-only per wallet.
    const result = await recordEvent({
      wallet,
      type,
      dedupeKey: `${type}:${wallet}`,
      meta,
    });
    return NextResponse.json({ ...result, verified: true });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[points] event failed", { type, detail });
    return NextResponse.json({ error: "Event recording failed", detail }, { status: 500 });
  }
}
