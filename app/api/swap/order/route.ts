import { NextRequest, NextResponse } from "next/server";
import { getSwapOrder, resolveTokenMint, getDecimals } from "@/app/lib/jupiter";

export async function POST(request: NextRequest) {
  try {
    const { inputToken, outputToken, amount, walletAddress } = await request.json();

    if (!inputToken || !outputToken || !amount || !walletAddress) {
      return NextResponse.json(
        { error: "Missing required fields: inputToken, outputToken, amount, walletAddress" },
        { status: 400 }
      );
    }

    const inputMint = await resolveTokenMint(inputToken);
    if (!inputMint) {
      return NextResponse.json({ error: `Could not resolve token: ${inputToken}` }, { status: 400 });
    }

    const outputMint = await resolveTokenMint(outputToken);
    if (!outputMint) {
      return NextResponse.json({ error: `Could not resolve token: ${outputToken}` }, { status: 400 });
    }

    const decimals = getDecimals(inputMint);
    const order = await getSwapOrder(inputMint, outputMint, amount, decimals, walletAddress);

    return NextResponse.json(order);
  } catch (error) {
    console.error("Swap order error:", error);
    const message = error instanceof Error ? error.message : "Failed to get swap order";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
