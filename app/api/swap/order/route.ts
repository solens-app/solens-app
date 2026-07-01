import { NextRequest, NextResponse } from "next/server";
import {
  getSwapOrder,
  resolveTokenMint,
  getDecimals,
  getTokenPrices,
} from "@/app/lib/jupiter";

export async function POST(request: NextRequest) {
  try {
    const { inputToken, outputToken, amount, amountUsd, walletAddress } =
      await request.json();

    if (!inputToken || !outputToken || !walletAddress) {
      return NextResponse.json(
        { error: "Missing required fields: inputToken, outputToken, walletAddress" },
        { status: 400 }
      );
    }
    if (
      (typeof amount !== "number" || !Number.isFinite(amount)) &&
      (typeof amountUsd !== "number" || !Number.isFinite(amountUsd))
    ) {
      return NextResponse.json(
        { error: "Provide either 'amount' (token units) or 'amountUsd' (dollars)." },
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

    // Resolve the input-token amount. When the caller passes a dollar value,
    // convert USD→token here with a live price (never trust a client-computed
    // token amount) so multi-leg portfolio swaps size each leg correctly.
    let tokenAmount: number | undefined =
      typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : undefined;
    if (tokenAmount === undefined && typeof amountUsd === "number" && amountUsd > 0) {
      const [p] = await getTokenPrices([inputMint]);
      const unitPrice = p ? parseFloat(p.price) : NaN;
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        return NextResponse.json(
          { error: `Couldn't get a reliable USD price for ${inputToken} right now.` },
          { status: 400 }
        );
      }
      tokenAmount = amountUsd / unitPrice;
    }
    if (tokenAmount === undefined || !Number.isFinite(tokenAmount) || tokenAmount <= 0) {
      return NextResponse.json({ error: "Invalid swap amount." }, { status: 400 });
    }

    const decimals = getDecimals(inputMint);
    const order = await getSwapOrder(inputMint, outputMint, tokenAmount, decimals, walletAddress);

    // Echo back the resolved human-readable input amount so the UI can display it.
    return NextResponse.json({ ...order, amount: tokenAmount });
  } catch (error) {
    console.error("Swap order error:", error);
    const message = error instanceof Error ? error.message : "Failed to get swap order";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
