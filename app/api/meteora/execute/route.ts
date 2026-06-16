import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL!;

// Poll for transaction confirmation instead of using WebSocket subscriptions
// (many RPC providers like Alchemy don't support signatureSubscribe)
async function pollForConfirmation(
    connection: Connection,
    signature: string,
    maxAttempts: number = 30,
    intervalMs: number = 2000,
): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
        const status = await connection.getSignatureStatus(signature);
        const value = status.value;

        if (value !== null) {
            if (value.err) {
                throw new Error(
                    `Transaction failed: ${JSON.stringify(value.err)}`,
                );
            }
            // confirmationStatus progresses: processed → confirmed → finalized
            if (
                value.confirmationStatus === "confirmed" ||
                value.confirmationStatus === "finalized"
            ) {
                return true;
            }
        }

        await new Promise((r) => setTimeout(r, intervalMs));
    }

    return false;
}

export async function POST(request: NextRequest) {
    try {
        const { signedTransactions } = (await request.json()) as {
            signedTransactions: string[];
        };

        if (!signedTransactions || signedTransactions.length === 0) {
            return NextResponse.json(
                { error: "Missing required field: signedTransactions" },
                { status: 400 },
            );
        }

        const connection = new Connection(RPC_URL, "confirmed");
        const signatures: string[] = [];

        for (const signedTxBase64 of signedTransactions) {
            const txBytes = Buffer.from(signedTxBase64, "base64");

            const signature = await connection.sendRawTransaction(txBytes, {
                skipPreflight: false,
                maxRetries: 3,
            });

            signatures.push(signature);

            // Poll for confirmation instead of using WS-based confirmTransaction
            const confirmed = await pollForConfirmation(connection, signature);

            if (!confirmed) {
                // Transaction was sent but confirmation timed out. It may still land,
                // so surface it as Pending (not a confirmed success) with the signature.
                return NextResponse.json({
                    status: "Pending",
                    signatures,
                    warning:
                        "Transaction was submitted but has not confirmed yet. Check the signature on Solscan before retrying.",
                });
            }
        }

        return NextResponse.json({
            status: "Success",
            signatures,
        });
    } catch (error) {
        console.error("Meteora execute error:", error);
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
