import { NextRequest, NextResponse } from "next/server";
import { PrivyClient } from "@privy-io/node";
import { bindWalletToChat, consumeTelegramLinkToken } from "@/app/lib/telegram-session";
import { getOrCreateAppWalletForUser } from "@/app/lib/privy-app-wallet";

interface RequestBody {
  token?: string;
  privyUserId?: string;
  /** Privy access token used to verify the user owns the linking session. */
  privyAuthToken?: string;
  /**
   * The chatId the client *believes* it is linking to. Sent back to the
   * server so the user is binding the wallet to a Telegram identity they
   * actually saw on screen, not one silently encoded in a phished token.
   * Must match the chatId in the link token.
   */
  expectedChatId?: number;
}

let privyClient: PrivyClient | null = null;

function getPrivyServerClient(): PrivyClient {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error("Privy server signing is not configured (NEXT_PUBLIC_PRIVY_APP_ID / PRIVY_APP_SECRET).");
  }
  if (!privyClient) {
    privyClient = new PrivyClient({ appId, appSecret });
  }
  return privyClient;
}

async function verifyPrivyAccessToken(accessToken: string): Promise<string> {
  const privy = getPrivyServerClient();
  const payload = await privy.utils().auth().verifyAccessToken(accessToken);
  return payload.user_id;
}

async function notifyTelegramWalletLinked(
  chatId: number,
  walletAddress: string,
  privyUserId?: string
) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  const shortWallet = `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
  const userLine = privyUserId ? `\nPrivy User: ${privyUserId}` : "";
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `Wallet connected: ${shortWallet}${userLine}\n\nYou can sign transactions directly in Telegram. Try:\n- Show my SOL balance\n- What can I swap with SOL?`,
    }),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody;
    const token = body.token?.trim();
    const privyUserId = body.privyUserId?.trim();
    const privyAuthToken = body.privyAuthToken?.trim();
    const expectedChatId =
      typeof body.expectedChatId === "number" && Number.isFinite(body.expectedChatId)
        ? body.expectedChatId
        : null;

    if (!token) {
      return NextResponse.json({ error: "token is required" }, { status: 400 });
    }
    if (!privyAuthToken) {
      return NextResponse.json(
        { error: "Missing Privy access token. Log in with Privy and retry." },
        { status: 400 }
      );
    }
    if (expectedChatId === null) {
      return NextResponse.json(
        { error: "expectedChatId is required. Reload the link page." },
        { status: 400 }
      );
    }

    let verifiedPrivyUserId: string;
    try {
      verifiedPrivyUserId = await verifyPrivyAccessToken(privyAuthToken);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("[telegram-link] Privy token verify failed", { detail });
      return NextResponse.json(
        { error: "Privy token validation failed.", detail },
        { status: 400 }
      );
    }
    if (privyUserId && privyUserId !== verifiedPrivyUserId) {
      return NextResponse.json(
        { error: "Privy user mismatch. Please reconnect from Telegram." },
        { status: 400 }
      );
    }

    let appWallet: { walletId: string; address: string };
    try {
      appWallet = await getOrCreateAppWalletForUser(verifiedPrivyUserId);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("[telegram-link] app wallet provision failed", { detail });
      return NextResponse.json(
        { error: "Could not provision an app wallet.", detail },
        { status: 500 }
      );
    }

    const { chatId } = consumeTelegramLinkToken(token);
    if (chatId !== expectedChatId) {
      console.warn("[telegram-link] chatId mismatch on confirm", {
        expected: expectedChatId,
        actual: chatId,
        privyUserId: verifiedPrivyUserId,
      });
      return NextResponse.json(
        {
          error:
            "Telegram chat mismatch. The link token does not match the chat you confirmed. Restart from /connect in your own Telegram.",
        },
        { status: 400 }
      );
    }
    bindWalletToChat(chatId, appWallet.address, verifiedPrivyUserId);
    await notifyTelegramWalletLinked(chatId, appWallet.address, verifiedPrivyUserId);

    return NextResponse.json({
      ok: true,
      chatId,
      walletAddress: appWallet.address,
      privyUserId: verifiedPrivyUserId,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to confirm Telegram link";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
