import { NextRequest, NextResponse } from "next/server";
import { verifyPrivyAccessTokenFromRequest } from "@/app/lib/privy-auth";
import { getOrCreateAppWalletForUser } from "@/app/lib/privy-app-wallet";
import { signAndBroadcastAction } from "@/app/lib/sign-broadcast";

interface RequestBody {
    action?: {
        type?: string;
        transaction?: string;
        transactions?: string[];
        requestId?: string;
    };
}

function internalApiBaseUrl(): string {
    return (
        process.env.INTERNAL_API_BASE_URL?.trim() ||
        `http://127.0.0.1:${process.env.PORT || "3000"}`
    ).replace(/\/$/, "");
}

export async function POST(request: NextRequest) {
    let privyUserId: string;
    try {
        privyUserId = await verifyPrivyAccessTokenFromRequest(request);
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return NextResponse.json(
            { error: "Unauthorized", detail },
            { status: 401 },
        );
    }

    const body = (await request.json()) as RequestBody;
    if (!body.action || !body.action.type) {
        return NextResponse.json(
            { error: "action with type is required" },
            { status: 400 },
        );
    }

    try {
        const wallet = await getOrCreateAppWalletForUser(privyUserId);
        const exec = await signAndBroadcastAction({
            walletId: wallet.walletId,
            action: body.action as {
                type: string;
                transaction?: string;
                transactions?: string[];
                requestId?: string;
            },
            internalBaseUrl: internalApiBaseUrl(),
        });

        if (exec.ok) {
            return NextResponse.json({
                ok: true,
                signature: exec.signature,
                signatures: exec.signatures,
            });
        }
        return NextResponse.json(
            {
                ok: false,
                pending: exec.pending ?? false,
                signature: exec.signature,
                error: exec.error,
            },
            { status: exec.pending ? 202 : 400 },
        );
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error("[sign-broadcast] failed", { privyUserId, detail });
        return NextResponse.json(
            { error: "Sign-broadcast failed", detail },
            { status: 500 },
        );
    }
}
