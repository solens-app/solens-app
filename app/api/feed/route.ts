import { NextRequest, NextResponse } from "next/server";
import { getRecentActivity, setEventTrade, type FeedEntry } from "@/app/lib/points";
import { fetchAndExtractSwap } from "@/app/lib/trade-meta";
import { isDbConfigured } from "@/app/lib/db";

// Platform-wide live feed — never cache.
export const dynamic = "force-dynamic";

// Bound the read-time back-fill so a feed load can't fan out to dozens of RPC
// calls: enrich at most this many un-enriched swaps per request, a few at a
// time. Enriched rows are cached back to the DB, so the rest fill in over the
// next polls and steady-state loads do no RPC work.
const MAX_ENRICH = 10;
const ENRICH_CONCURRENCY = 4;

async function enrichMissing(items: FeedEntry[]): Promise<void> {
  const pending = items
    .filter((e) => e.type === "swap" && !e.trade && !e.tried && e.signature)
    .slice(0, MAX_ENRICH);
  if (pending.length === 0) return;

  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const entry = pending[cursor++];
      try {
        const trade = await fetchAndExtractSwap(entry.signature as string, entry.wallet);
        await setEventTrade(entry.id, trade); // caches result (or a "tried" marker)
        entry.trade = trade;
        entry.tried = true;
      } catch {
        /* leave the entry lean; it'll be retried on a later poll */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, pending.length) }, worker));
}

/**
 * GET /api/feed?limit=30&before=<ms>
 *
 * Recent on-chain trades across all Solens users, newest first. `before` is a
 * millisecond timestamp cursor for paging backwards (pass the previous page's
 * `nextCursor`). Swaps that were recorded before enrichment shipped are
 * back-filled with their traded token / side / USD size on demand and cached.
 * When no database is configured (local preview), responds with an empty list
 * and `configured: false` so the UI can fall back to a demo feed.
 */
export async function GET(request: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ items: [], nextCursor: null, configured: false });
  }

  const sp = request.nextUrl.searchParams;
  const limit = Number(sp.get("limit")) || 30;
  const beforeRaw = sp.get("before");
  const before = beforeRaw ? Number(beforeRaw) : undefined;

  try {
    const items = await getRecentActivity(limit, before);
    await enrichMissing(items);
    const nextCursor = items.length ? items[items.length - 1].ts : null;
    return NextResponse.json({ items, nextCursor, configured: true });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[feed] GET failed", detail);
    return NextResponse.json({ error: "Failed to load feed", detail }, { status: 500 });
  }
}
