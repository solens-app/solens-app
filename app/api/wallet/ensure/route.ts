import { NextRequest, NextResponse } from "next/server";
import { verifyPrivyAccessTokenFromRequest } from "@/app/lib/privy-auth";
import { getOrCreateAppWalletForUser } from "@/app/lib/privy-app-wallet";

export async function POST(request: NextRequest) {
  let privyUserId: string;
  try {
    privyUserId = await verifyPrivyAccessTokenFromRequest(request);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "Unauthorized", detail }, { status: 401 });
  }

  try {
    const wallet = await getOrCreateAppWalletForUser(privyUserId);
    return NextResponse.json({ address: wallet.address });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[wallet/ensure] failed", { privyUserId, detail });
    return NextResponse.json({ error: "Wallet provision failed", detail }, { status: 500 });
  }
}
