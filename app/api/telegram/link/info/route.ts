import { NextRequest, NextResponse } from "next/server";
import { peekTelegramLinkToken } from "@/app/lib/telegram-session";

/**
 * Returns the Telegram identity bound to a link token without consuming it.
 * The link confirmation page uses this to show users which Telegram chat
 * will be linked to their wallet, so a phished token cannot silently bind
 * a victim's wallet to an attacker-controlled chat.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token")?.trim();
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  try {
    const identity = peekTelegramLinkToken(token);
    return NextResponse.json({
      ok: true,
      chatId: identity.chatId,
      username: identity.username ?? null,
      firstName: identity.firstName ?? null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Invalid link token";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
