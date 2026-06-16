import { NextRequest, NextResponse } from "next/server";
import { attributeReferral } from "@/app/lib/points";

export const dynamic = "force-dynamic";

/**
 * POST /api/points/referral
 * Body: { wallet: string, code: string }
 *
 * Attributes `wallet` to the referrer that owns `code`. One-time and never
 * self-referral. Safe to call repeatedly — only the first valid attribution
 * sticks. Returns `{ ok }` plus a reason on rejection.
 */
export async function POST(request: NextRequest) {
  let body: { wallet?: unknown; code?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";

  if (!wallet) return NextResponse.json({ error: "Missing wallet" }, { status: 400 });
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });

  try {
    const result = await attributeReferral(wallet, code);
    return NextResponse.json(result);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[points] referral failed", detail);
    return NextResponse.json({ error: "Referral attribution failed", detail }, { status: 500 });
  }
}
