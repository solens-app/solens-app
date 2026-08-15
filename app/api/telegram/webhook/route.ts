import { NextRequest, NextResponse } from "next/server";
import {
  createTelegramLinkToken,
  getLinkedWallet,
  getLinkedPrivyUser,
  unlinkWallet,
} from "@/app/lib/telegram-session";
import {
  getOrCreateAppWalletForUser,
  isAppWalletConfigured,
} from "@/app/lib/privy-app-wallet";
import { signAndBroadcastAction } from "@/app/lib/sign-broadcast";

interface TelegramUser {
  id?: number;
  username?: string;
  first_name?: string;
}

interface TelegramMessage {
  chat?: { id?: number; username?: string; title?: string };
  from?: TelegramUser;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatApiAction {
  type: string;
}

interface ChatApiQuickReply {
  label: string;
  prompt: string;
}

interface ChatApiPortfolioToken {
  mint: string;
  symbol: string;
  amountLabel: string;
  usdLabel: string;
}

interface ChatApiPortfolioPosition {
  poolAddress: string;
  pairLabel: string;
  amountLabel: string;
  usdLabel: string;
}

interface ChatApiPortfolio {
  walletAddress: string;
  solBalanceLabel: string;
  solUsdLabel: string;
  tokens: ChatApiPortfolioToken[];
  positions?: ChatApiPortfolioPosition[];
  totalUsdLabel: string;
  pricesIncomplete: boolean;
}

interface ChatApiResponse {
  message?: string;
  error?: string;
  action?: ChatApiAction | Record<string, unknown>;
  quickReplies?: ChatApiQuickReply[];
  portfolio?: ChatApiPortfolio;
}

const MAX_HISTORY_MESSAGES = 20;
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_SAFE_MESSAGE_LENGTH = 3800;
const ACTION_CONFIRM_CALLBACK = "act:confirm";
const ACTION_CANCEL_CALLBACK = "act:cancel";
const chatHistory = new Map<number, ChatMessage[]>();
const quickReplyPrompts = new Map<number, Map<string, string>>();
const pendingOnchainActionByChat = new Map<
  number,
  { actionJson: string; createdAt: number }
>();
let quickReplyCounter = 0;

function getHistory(chatId: number): ChatMessage[] {
  return chatHistory.get(chatId) ?? [];
}

function setHistory(chatId: number, history: ChatMessage[]) {
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  chatHistory.set(chatId, trimmed);
}

function splitTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_SAFE_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_SAFE_MESSAGE_LENGTH) {
    const slice = remaining.slice(0, TELEGRAM_SAFE_MESSAGE_LENGTH);
    const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"));
    const idx = breakAt > 400 ? breakAt : TELEGRAM_SAFE_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, idx).trimEnd());
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function normalizeTelegramText(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripMarkdownForFallback(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The web app presents this information in a PortfolioCard. Telegram receives
 * the same structured API response but cannot render that component, so turn
 * it into a plain-text summary before sending it to the chat.
 */
function formatTelegramPortfolio(portfolio: ChatApiPortfolio): string {
  const lines = [
    "Portfolio",
    `Total value: ${portfolio.totalUsdLabel}`,
    "",
    "Holdings",
    `• SOL: ${portfolio.solBalanceLabel} (${portfolio.solUsdLabel})`,
    ...portfolio.tokens.map(
      (token) =>
        `• ${token.symbol}: ${token.amountLabel} (${token.usdLabel})`
    ),
  ];

  if (portfolio.tokens.length === 0) {
    lines.push("• No other tokens yet");
  }

  if (portfolio.positions && portfolio.positions.length > 0) {
    lines.push("", "Liquidity positions");
    lines.push(
      ...portfolio.positions.map(
        (position) =>
          `• ${position.pairLabel}: ${position.amountLabel} (${position.usdLabel})`
      )
    );
  }

  if (portfolio.pricesIncomplete) {
    lines.push("", "Some token prices are unavailable, so the total is partial.");
  }

  return lines.join("\n");
}

function storeQuickReplies(chatId: number, quickReplies: ChatApiQuickReply[]) {
  const prompts = new Map<string, string>();
  for (const qr of quickReplies.slice(0, 8)) {
    const token = `qr:${Date.now().toString(36)}:${(quickReplyCounter++).toString(36)}`;
    prompts.set(token, qr.prompt);
  }
  quickReplyPrompts.set(chatId, prompts);
  return prompts;
}

function resolveCallbackPrompt(chatId: number, callbackData: string): string {
  if (!callbackData.startsWith("qr:")) return callbackData;
  const prompts = quickReplyPrompts.get(chatId);
  if (!prompts) return "";
  return prompts.get(callbackData) ?? "";
}

function isOnchainConfirmMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return [
    "confirm",
    "confirm swap",
    "confirm transaction",
    "approve",
    "approved",
    "done",
    "signed",
    "i signed",
    "i approved",
  ].includes(normalized);
}

function internalApiBaseUrl(): string {
  return (
    process.env.INTERNAL_API_BASE_URL?.trim() ||
    `http://127.0.0.1:${process.env.PORT || "3000"}`
  ).replace(/\/$/, "");
}

async function sendTelegramMessage(
  chatId: number,
  text: string,
  options?: { replyMarkup?: unknown }
) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const chunks = splitTelegramMessage(normalizeTelegramText(text));
  for (const chunk of chunks) {
    const safeText =
      chunk.length > TELEGRAM_MAX_MESSAGE_LENGTH
        ? `${chunk.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 3)}...`
        : chunk;

    let response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: safeText,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      }),
    });

    // Fallback for malformed markdown entities from model output.
    if (!response.ok) {
      const firstError = await response.text();
      if (firstError.includes("can't parse entities")) {
        response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: stripMarkdownForFallback(safeText),
            disable_web_page_preview: true,
            ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
          }),
        });
      } else {
        throw new Error(`Failed to send Telegram message: ${firstError}`);
      }
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to send Telegram message (${response.status}): ${body}`);
    }
  }
}

async function sendTelegramQuickReplies(
  chatId: number,
  text: string,
  quickReplies: ChatApiQuickReply[],
  options?: {
    actionButtons?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
    includeActionButtons?: boolean;
  }
) {
  const promptMap = storeQuickReplies(chatId, quickReplies);
  const buttons: Array<
    Array<{ text: string; callback_data?: string; url?: string }>
  > = [...promptMap.entries()].map(([token, prompt]) => {
    const label = quickReplies.find((q) => q.prompt === prompt)?.label ?? "Select";
    return [{ text: label.slice(0, 48), callback_data: token.slice(0, 64) }];
  });
  if (options?.actionButtons) {
    buttons.push(...options.actionButtons);
  } else if (options?.includeActionButtons) {
    buttons.push([
      { text: "Confirm", callback_data: ACTION_CONFIRM_CALLBACK },
      { text: "Cancel", callback_data: ACTION_CANCEL_CALLBACK },
    ]);
  }

  await sendTelegramMessage(chatId, text, {
    replyMarkup: { inline_keyboard: buttons },
  });
}

async function sendTelegramChatAction(chatId: number, action: "typing" = "typing") {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      action,
    }),
  });
}

async function answerCallbackQuery(callbackQueryId: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
    }),
  });
}

/** Internal fetch to /api/chat. LLM/tool loops can exceed default Undici headers timeout (~5m). */
function internalChatFetchTimeoutMs(): number {
  const raw = process.env.TELEGRAM_INTERNAL_CHAT_TIMEOUT_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

async function getAssistantReply(
  message: string,
  history: ChatMessage[],
  walletAddress: string | null
): Promise<ChatApiResponse> {
  const response = await fetch(new URL("/api/chat", internalApiBaseUrl()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      walletAddress,
      txSignerWalletAddress: walletAddress,
      history,
      chatChannel: "telegram",
      telegramSigningMode: "privy_server",
    }),
    signal: AbortSignal.timeout(internalChatFetchTimeoutMs()),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Chat API failed (${response.status}): ${body}`);
  }

  return (await response.json()) as ChatApiResponse;
}

function getTelegramWebhookSecrets(): string[] {
  const multi = process.env.TELEGRAM_WEBHOOK_SECRETS?.trim();
  if (multi) {
    const parts = multi
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts;
  }
  const single = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  return single ? [single] : [];
}

let didWarnMissingWebhookSecret = false;

/**
 * Accepts `X-Telegram-Bot-Api-Secret-Token` if it matches any configured secret.
 * Fails closed when no secret is configured: an attacker could otherwise POST
 * forged Telegram updates to drive on-chain signing for any linked chat.
 */
function isAuthorizedWebhook(request: NextRequest): boolean {
  const secrets = getTelegramWebhookSecrets();
  if (secrets.length === 0) {
    if (!didWarnMissingWebhookSecret) {
      didWarnMissingWebhookSecret = true;
      console.error(
        "[telegram] TELEGRAM_WEBHOOK_SECRET / TELEGRAM_WEBHOOK_SECRETS is not set. Rejecting all webhook requests. Configure the secret and register it with Telegram via setWebhook to enable the bot."
      );
    }
    return false;
  }

  const header = request.headers.get("x-telegram-bot-api-secret-token");
  if (!header) return false;
  return secrets.includes(header);
}

export async function POST(request: NextRequest) {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return NextResponse.json(
        { error: "Missing TELEGRAM_BOT_TOKEN" },
        { status: 500 }
      );
    }

    if (!isAuthorizedWebhook(request)) {
      return NextResponse.json({ error: "Unauthorized webhook" }, { status: 401 });
    }

    const update = (await request.json()) as TelegramUpdate;

    const callbackChatId = update.callback_query?.message?.chat?.id;
    const messageChatId = update.message?.chat?.id;
    const chatId = callbackChatId ?? messageChatId;

    const fromUser = update.message?.from ?? update.callback_query?.message?.from;
    const chatUsername = update.message?.chat?.username ?? update.callback_query?.message?.chat?.username;
    const linkIdentity = {
      username: fromUser?.username ?? chatUsername,
      firstName: fromUser?.first_name,
    };

    const callbackText = update.callback_query?.data?.trim();
    const messageText = update.message?.text?.trim();

    // Ignore updates without a chat target.
    if (!chatId) {
      return NextResponse.json({ ok: true });
    }

    const incomingText = callbackText
      ? resolveCallbackPrompt(chatId, callbackText)
      : messageText;

    if (callbackText && !incomingText) {
      await sendTelegramMessage(chatId, "That button expired. Ask again to get fresh options.");
      return NextResponse.json({ ok: true });
    }

    // Ignore non-text Telegram updates.
    if (!incomingText) {
      return NextResponse.json({ ok: true });
    }

    if (update.callback_query?.id) {
      await answerCallbackQuery(update.callback_query.id);
    }

    if (callbackText === ACTION_CANCEL_CALLBACK) {
      pendingOnchainActionByChat.delete(chatId);
      await sendTelegramMessage(chatId, "On-chain action cancelled.");
      return NextResponse.json({ ok: true });
    }

    if (incomingText === "/start" || incomingText === "/help") {
      await sendTelegramMessage(
        chatId,
        "Hey! I am Solens, your Solana AI copilot.\n\nI can help you track your wallet, check token prices, find swaps, explore liquidity pools, and navigate prediction markets or NFTs.\n\nTo get started, connect your wallet securely:\n/connect\n\nCommands:\n/connect - Link wallet with Privy\n/wallet - Show linked wallet\n/disconnect - Unlink wallet\n/reset - Clear chat context\n/help - Show this message\n\nTip: after connecting, try: \"Show my wallet overview\" or \"What can I swap with SOL?\"",
        {
          replyMarkup: {
            inline_keyboard: [
              [{ text: "Connect Wallet", callback_data: "/connect" }],
              [{ text: "Show Wallet", callback_data: "/wallet" }],
            ],
          },
        }
      );
      return NextResponse.json({ ok: true });
    }

    if (incomingText === "/connect") {
      const linkedWallet = getLinkedWallet(chatId);
      if (linkedWallet) {
        await sendTelegramMessage(
          chatId,
          `Wallet already linked: ${linkedWallet}\n\nUse /disconnect first if you want to connect a different wallet.`,
          {
            replyMarkup: {
              inline_keyboard: [[{ text: "Disconnect Wallet", callback_data: "/disconnect" }]],
            },
          }
        );
        return NextResponse.json({ ok: true });
      }

      const linkChallenge = createTelegramLinkToken(chatId, linkIdentity);
      const baseUrl =
        process.env.TELEGRAM_LINK_BASE_URL ||
        process.env.NEXT_PUBLIC_APP_URL ||
        request.nextUrl.origin;
      const link = `${baseUrl.replace(/\/$/, "")}/telegram/link?token=${encodeURIComponent(
        linkChallenge.token
      )}`;
      const minsLeft = Math.max(
        1,
        Math.ceil((linkChallenge.expiresAt - Date.now()) / 60000)
      );
      await sendTelegramMessage(
        chatId,
        linkChallenge.reused
          ? `You already have an active secure link. It expires in about ${minsLeft} minute(s).`
          : `Open this secure link to connect your Privy wallet. It expires in about ${minsLeft} minute(s) and can only be used once.`,
        {
          replyMarkup: {
            inline_keyboard: [[{ text: "Open Secure Link", url: link }]],
          },
        }
      );
      return NextResponse.json({ ok: true });
    }

    if (incomingText === "/wallet") {
      const wallet = getLinkedWallet(chatId);
      const privyUserId = getLinkedPrivyUser(chatId);
      await sendTelegramMessage(
        chatId,
        wallet
          ? `Current wallet: ${wallet}${privyUserId ? `\nPrivy user: ${privyUserId}` : ""}`
          : "No wallet linked yet. Use /connect to securely link with Privy."
      );
      return NextResponse.json({ ok: true });
    }

    if (incomingText === "/disconnect") {
      unlinkWallet(chatId);
      chatHistory.delete(chatId);
      pendingOnchainActionByChat.delete(chatId);
      await sendTelegramMessage(chatId, "Wallet unlinked for this Telegram chat.");
      return NextResponse.json({ ok: true });
    }

    if (incomingText === "/reset") {
      chatHistory.delete(chatId);
      pendingOnchainActionByChat.delete(chatId);
      await sendTelegramMessage(chatId, "Conversation history cleared.");
      return NextResponse.json({ ok: true });
    }

    if (incomingText?.startsWith("/") && !["/start", "/help", "/connect", "/wallet", "/disconnect", "/reset"].includes(incomingText)) {
      await sendTelegramMessage(chatId, "Unknown command. Use /help to see available commands.");
      return NextResponse.json({ ok: true });
    }

    const pendingAction = pendingOnchainActionByChat.get(chatId);
    if (
      pendingAction &&
      (callbackText === ACTION_CONFIRM_CALLBACK || isOnchainConfirmMessage(incomingText))
    ) {
      const actionJson =
        typeof pendingAction.actionJson === "string" && pendingAction.actionJson.length > 0
          ? pendingAction.actionJson
          : null;

      if (!actionJson) {
        pendingOnchainActionByChat.delete(chatId);
        await sendTelegramMessage(
          chatId,
          "That confirmation expired. Ask again to prepare a fresh action."
        );
        return NextResponse.json({ ok: true });
      }

      let parsed: { type: string; transaction?: string; transactions?: string[]; requestId?: string };
      try {
        const raw = JSON.parse(actionJson) as { type?: unknown };
        if (typeof raw.type !== "string") throw new Error("missing type");
        parsed = raw as typeof parsed;
      } catch {
        pendingOnchainActionByChat.delete(chatId);
        await sendTelegramMessage(chatId, "Pending action was invalid. Please ask again.");
        return NextResponse.json({ ok: true });
      }

      const privyUserId = getLinkedPrivyUser(chatId);
      if (!privyUserId || !isAppWalletConfigured()) {
        pendingOnchainActionByChat.delete(chatId);
        await sendTelegramMessage(
          chatId,
          "Telegram signing is not set up. /disconnect then /connect to link a wallet."
        );
        return NextResponse.json({ ok: true });
      }

      let appWallet: { walletId: string; address: string };
      try {
        appWallet = await getOrCreateAppWalletForUser(privyUserId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Wallet provisioning failed";
        pendingOnchainActionByChat.delete(chatId);
        await sendTelegramMessage(chatId, `Could not access your app wallet: ${msg}`);
        return NextResponse.json({ ok: true });
      }

      const exec = await signAndBroadcastAction({
        walletId: appWallet.walletId,
        action: parsed,
        internalBaseUrl: internalApiBaseUrl(),
      });
      pendingOnchainActionByChat.delete(chatId);

      if (exec.ok && exec.signature) {
        await sendTelegramMessage(
          chatId,
          `Submitted.\nhttps://solscan.io/tx/${exec.signature}`
        );
      } else {
        await sendTelegramMessage(
          chatId,
          `Transaction failed: ${exec.error ?? "unknown"}`
        );
      }
      return NextResponse.json({ ok: true });
    }

    const walletAddress = getLinkedWallet(chatId);

    const history = getHistory(chatId);
    await sendTelegramChatAction(chatId, "typing");
    const chatApiResponse = await getAssistantReply(incomingText, history, walletAddress);
    const reply =
      (typeof chatApiResponse.message === "string" &&
      chatApiResponse.message.trim().length > 0
        ? chatApiResponse.message
        : chatApiResponse.error) ??
      "I couldn't generate a reply right now. Please try again.";

    setHistory(chatId, [
      ...history,
      { role: "user", content: incomingText },
      { role: "assistant", content: reply },
    ]);

    const portfolioSummary = chatApiResponse.portfolio
      ? formatTelegramPortfolio(chatApiResponse.portfolio)
      : null;
    const isPortfolioIntro = /^here['’]s your portfolio:?$/i.test(reply.trim());
    let finalReply = portfolioSummary
      ? isPortfolioIntro
        ? portfolioSummary
        : `${reply}\n\n${portfolioSummary}`
      : reply;
    if (chatApiResponse.action) {
      pendingOnchainActionByChat.set(chatId, {
        actionJson: JSON.stringify(chatApiResponse.action),
        createdAt: Date.now(),
      });
      finalReply += "\n\nTap **Confirm** to sign and broadcast.";
    } else if (pendingAction && !isOnchainConfirmMessage(incomingText)) {
      pendingOnchainActionByChat.delete(chatId);
    }

    const actionButtons = chatApiResponse.action
      ? [
          [
            { text: "Confirm", callback_data: ACTION_CONFIRM_CALLBACK },
            { text: "Cancel", callback_data: ACTION_CANCEL_CALLBACK },
          ],
        ]
      : undefined;

    if (chatApiResponse.quickReplies && chatApiResponse.quickReplies.length > 0) {
      await sendTelegramQuickReplies(chatId, finalReply, chatApiResponse.quickReplies, {
        actionButtons,
      });
    } else {
      await sendTelegramMessage(chatId, finalReply, chatApiResponse.action
        ? {
            replyMarkup: {
              inline_keyboard: actionButtons,
            },
          }
        : undefined);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ ok: true });
  }
}
