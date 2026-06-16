import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL!;

/**
 * Execute a signed prediction market transaction.
 * Jupiter docs require: skipPreflight: true, maxRetries: 0
 * This differs from the general execute endpoint.
 */
export async function POST(request: NextRequest) {
    try {
        const { signedTransaction } = (await request.json()) as {
            signedTransaction: string;
        };

        if (!signedTransaction) {
            return NextResponse.json(
                { error: "Missing required field: signedTransaction" },
                { status: 400 },
            );
        }

        const connection = new Connection(RPC_URL, "confirmed");
        const txBytes = Buffer.from(signedTransaction, "base64");

        // Jupiter prediction docs specify these exact settings
        const signature = await connection.sendRawTransaction(txBytes, {
            skipPreflight: true,
            maxRetries: 0,
            preflightCommitment: "confirmed",
        });

        // Poll for confirmation
        for (let i = 0; i < 30; i++) {
            const status = await connection.getSignatureStatus(signature);
            const value = status.value;

            if (value !== null) {
                if (value.err) {
                    return NextResponse.json({
                        status: "Failed",
                        error: `Transaction failed: ${JSON.stringify(value.err)}`,
                        signature,
                    });
                }
                if (
                    value.confirmationStatus === "confirmed" ||
                    value.confirmationStatus === "finalized"
                ) {
                    return NextResponse.json({
                        status: "Success",
                        signature,
                    });
                }
            }

            await new Promise((r) => setTimeout(r, 2000));
        }

        // Timed out waiting for confirmation. The tx may still land, but we must
        // not report it as a confirmed success.
        return NextResponse.json({
            status: "Pending",
            signature,
            warning:
                "Transaction was submitted but has not confirmed yet. Check the signature on Solscan before retrying.",
        });
    } catch (error) {
        console.error("Prediction execute error:", error);
        const message =
            error instanceof Error
                ? error.message
                : "Failed to execute transaction";
        return NextResponse.json(
            { error: message, status: "Failed" },
            { status: 500 },
        );
    }
}
