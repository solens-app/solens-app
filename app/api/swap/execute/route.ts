import { NextRequest, NextResponse } from "next/server";
import { executeSwap } from "@/app/lib/jupiter";

export async function POST(request: NextRequest) {
  try {
    const { signedTransaction, requestId } = await request.json();

    if (!signedTransaction || !requestId) {
      return NextResponse.json(
        { error: "Missing required fields: signedTransaction, requestId" },
        { status: 400 }
      );
    }

    const result = await executeSwap(signedTransaction, requestId);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Swap execute error:", error);
    const message = error instanceof Error ? error.message : "Failed to execute swap";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
