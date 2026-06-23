import { NextRequest, NextResponse } from "next/server";
import { claimQuest } from "@/app/lib/points";

export const dynamic = "force-dynamic";

/**
 * POST /api/points/claim
 * Body: { wallet: string, questId: string }
 *
 * Claims a quest's EP for the wallet. The claim is rejected with
 * `{ ok: false, reason: "not_ready" }` unless the quest's real requirement is
 * already satisfied by recorded activity, and with `"already_claimed"` if it
 * was claimed in the current reset period. Returns the latest state either way.
 */
export async function POST(request: NextRequest) {
  let body: { wallet?: unknown; questId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const questId = typeof body.questId === "string" ? body.questId.trim() : "";

  if (!wallet) return NextResponse.json({ error: "Missing wallet" }, { status: 400 });
  if (!questId) return NextResponse.json({ error: "Missing questId" }, { status: 400 });

  try {
    const result = await claimQuest(wallet, questId);
    return NextResponse.json(result);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[points] claim failed", detail);
    return NextResponse.json({ error: "Claim failed", detail }, { status: 500 });
  }
}
