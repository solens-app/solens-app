import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { createLaunchTransaction } from "@/app/lib/bags";

const RPC_URL = process.env.SOLANA_RPC_URL!;

/**
 * Phase 2 of token launch: after fee config txs are confirmed on-chain,
 * create the actual launch transaction.
 */
export async function POST(request: NextRequest) {
  try {
    const {
      signedFeeConfigTxs,
      ipfs,
      tokenMint,
      wallet,
      initialBuyLamports,
      configKey,
    } = (await request.json()) as {
      signedFeeConfigTxs: string[]; // base64 signed transactions
      ipfs: string;
      tokenMint: string;
      wallet: string;
      initialBuyLamports: number;
      configKey: string;
    };

    const connection = new Connection(RPC_URL, "confirmed");

    // Step 1: Send fee config transactions sequentially
    for (const signedTxBase64 of signedFeeConfigTxs) {
      const txBytes = Buffer.from(signedTxBase64, "base64");

      const signature = await connection.sendRawTransaction(txBytes, {
        skipPreflight: false,
        maxRetries: 3,
      });

      // Poll for confirmation
      for (let i = 0; i < 30; i++) {
        const status = await connection.getSignatureStatus(signature);
        if (status.value?.confirmationStatus === "confirmed" || status.value?.confirmationStatus === "finalized") {
          break;
        }
        if (status.value?.err) {
          throw new Error(`Fee config tx failed: ${JSON.stringify(status.value.err)}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Step 2: Now create the launch transaction
    const launchTx = await createLaunchTransaction({
      ipfs,
      tokenMint,
      wallet,
      initialBuyLamports,
      configKey,
    });

    return NextResponse.json({
      status: "Success",
      launchTransaction: launchTx, // base58 encoded string, needs user signature
    });
  } catch (error) {
    console.error("Bags launch error:", error);
    const message = error instanceof Error ? error.message : "Failed to launch token";
    return NextResponse.json({ error: message, status: "Failed" }, { status: 500 });
  }
}
