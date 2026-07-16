import { NextRequest, NextResponse } from "next/server";
import {
  getSwapOrder,
  resolveTokenMint,
  getDecimals,
  getTokenPrices,
} from "@/app/lib/jupiter";

export async function POST(request: NextRequest) {
  try {
    const { inputToken, outputToken, amount, amountUsd, rawAmount, walletAddress } =
      await request.json();

    if (!inputToken || !outputToken || !walletAddress) {
      return NextResponse.json(
        { error: "Missing required fields: inputToken, outputToken, walletAddress" },
        { status: 400 }
      );
    }
    // rawAmount is an exact base-unit balance (string) for "sell my whole
    // balance" legs — it bypasses USD/decimal conversion entirely.
    const hasRawAmount = typeof rawAmount === "string" && /^\d+$/.test(rawAmount) && rawAmount !== "0";
    if (
      !hasRawAmount &&
      (typeof amount !== "number" || !Number.isFinite(amount)) &&
      (typeof amountUsd !== "number" || !Number.isFinite(amountUsd))
    ) {
      return NextResponse.json(
        { error: "Provide 'rawAmount' (base units), 'amount' (token units), or 'amountUsd' (dollars)." },
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

    // Exact "sell whole balance" path: use the base-unit amount verbatim (it
    // already reflects the token's real decimals), skipping USD/decimal math
    // that would mis-size unknown mints (getDecimals falls back to 9).
    if (hasRawAmount) {
      const order = await getSwapOrder(
        inputMint,
        outputMint,
        0,
        decimals,
        walletAddress,
        undefined,
        rawAmount,
      );
      const humanAmount = Number(rawAmount) / 10 ** decimals;
      return NextResponse.json({ ...order, amount: humanAmount });
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

    const order = await getSwapOrder(inputMint, outputMint, tokenAmount, decimals, walletAddress);

    // Echo back the resolved human-readable input amount so the UI can display it.
    return NextResponse.json({ ...order, amount: tokenAmount });
  } catch (error) {
    console.error("Swap order error:", error);
    const message = error instanceof Error ? error.message : "Failed to get swap order";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
