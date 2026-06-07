import { NextRequest, NextResponse } from "next/server";
import { getOrderStatus } from "@/app/lib/prediction";

/**
 * Poll prediction order status after on-chain submission.
 * The order creation tx succeeds on-chain, but the keeper fills it asynchronously.
 * This endpoint polls until the order is filled, failed, or times out.
 */
export async function POST(request: NextRequest) {
  try {
    const { orderPubkey } = (await request.json()) as {
      orderPubkey: string;
    };

    if (!orderPubkey) {
      return NextResponse.json({ error: "orderPubkey is required" }, { status: 400 });
    }

    // Poll for up to 30 seconds (15 attempts x 2s)
    for (let i = 0; i < 15; i++) {
      try {
        const status = await getOrderStatus(orderPubkey);
        const orderStatus = (status as { status?: string }).status;

        if (orderStatus === "filled") {
          return NextResponse.json({
            status: "filled",
            message: "Order filled successfully",
            data: status,
          });
        }

        if (orderStatus === "failed") {
          return NextResponse.json({
            status: "failed",
            message: "Order failed to fill",
            data: status,
          });
        }

        // Still pending, wait and retry
      } catch {
        // "no order history found" is normal right after submission
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    // Timed out — order might still fill later
    return NextResponse.json({
      status: "pending",
      message: "Order is still being processed by the keeper network. Check your positions later.",
    });
  } catch (error) {
    console.error("Prediction status error:", error);
    const message = error instanceof Error ? error.message : "Failed to check order status";
    return NextResponse.json({ error: message, status: "error" }, { status: 500 });
  }
}
