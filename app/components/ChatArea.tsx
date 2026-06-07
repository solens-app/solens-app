"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePrivy, useToken } from "@privy-io/react-auth";
import Markdown from "react-markdown";

interface QuickReply {
  label: string;
  prompt: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  action?: MessageAction;
  quickReplies?: QuickReply[];
}

interface SwapAction {
  type: "swap";
  transaction: string;
  requestId: string;
  inputToken: string;
  outputToken: string;
  amount: number;
  estimatedOutput: string | null;
  cancelled?: boolean;
}

interface TransferAction {
  type: "transfer";
  transaction: string;
  assetSymbol: string;
  amount: number;
  amountLabel?: string;
  toAddress: string;
  cancelled?: boolean;
}

interface AddLiquidityAction {
  type: "addLiquidity";
  transactions: string[];
  poolAddress: string;
  positionAddress: string;
  poolName: string;
  amountX: number;
  amountY: number;
  tokenXSymbol: string;
  tokenYSymbol: string;
  cancelled?: boolean;
}

interface RemoveLiquidityAction {
  type: "removeLiquidity";
  transactions: string[];
  poolAddress: string;
  positionAddress: string;
  cancelled?: boolean;
}

interface LaunchTokenAction {
  type: "launchToken";
  transactions: string[];
  tokenName: string;
  tokenSymbol: string;
  tokenMint: string;
  cancelled?: boolean;
}

interface ClaimFeesAction {
  type: "claimFees";
  transactions: string[];
  tokenMint: string;
  cancelled?: boolean;
}

interface PredictionOrderAction {
  type: "predictionOrder";
  transaction: string;
  marketId: string;
  side: "YES" | "NO";
  amountUsd: number;
  contracts: string;
  orderPubkey: string;
  marketTitle: string;
  cancelled?: boolean;
}

interface SellPredictionAction {
  type: "sellPrediction";
  transaction: string;
  positionPubkey: string;
  marketTitle: string;
  cancelled?: boolean;
}

interface ClaimPredictionAction {
  type: "claimPrediction";
  transaction: string;
  positionPubkey: string;
  payoutUsd: string;
  marketTitle: string;
  cancelled?: boolean;
}

interface BuyNFTAction {
  type: "buyNFT";
  transaction: string;
  tokenMint: string;
  price: number;
  nftName: string;
  cancelled?: boolean;
}

interface ListNFTAction {
  type: "listNFT";
  transaction: string;
  tokenMint: string;
  price: number;
  nftName: string;
  cancelled?: boolean;
}

type MessageAction =
  | TransferAction
  | SwapAction
  | AddLiquidityAction
  | RemoveLiquidityAction
  | LaunchTokenAction
  | ClaimFeesAction
  | PredictionOrderAction
  | SellPredictionAction
  | ClaimPredictionAction
  | BuyNFTAction
  | ListNFTAction;

const ACTION_LABELS: Record<MessageAction["type"], string> = {
  transfer: "Transfer",
  swap: "Swap",
  addLiquidity: "Add Liquidity",
  removeLiquidity: "Remove Liquidity",
  launchToken: "Launch Token",
  claimFees: "Claim Fees",
  predictionOrder: "Prediction Order",
  sellPrediction: "Sell Position",
  claimPrediction: "Claim Payout",
  buyNFT: "Buy NFT",
  listNFT: "List NFT",
};

type DetailRow = { label: string; value: string; mono?: boolean };

function actionTransactionCount(action: MessageAction): number {
  if ("transactions" in action && Array.isArray(action.transactions)) {
    return action.transactions.length;
  }
  if ("transaction" in action && typeof action.transaction === "string") {
    return 1;
  }
  return 0;
}

function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}...${a.slice(-4)}` : a;
}

function actionDetails(action: MessageAction): DetailRow[] {
  switch (action.type) {
    case "transfer":
      return [
        { label: "Asset", value: action.assetSymbol },
        { label: "Amount", value: `${action.amountLabel ?? action.amount} ${action.assetSymbol}` },
        { label: "Recipient", value: action.toAddress, mono: true },
      ];
    case "swap":
      return [
        { label: "From", value: `${action.amount} ${action.inputToken}` },
        {
          label: "To (estimated)",
          value: action.estimatedOutput
            ? `~${action.estimatedOutput} ${action.outputToken}`
            : action.outputToken,
        },
        { label: "Request ID", value: shortAddress(action.requestId), mono: true },
      ];
    case "addLiquidity":
      return [
        { label: "Pool", value: action.poolName },
        { label: action.tokenXSymbol, value: Number(action.amountX).toPrecision(6) },
        { label: action.tokenYSymbol, value: Number(action.amountY).toPrecision(6) },
        { label: "Position", value: shortAddress(action.positionAddress), mono: true },
      ];
    case "removeLiquidity":
      return [
        { label: "Pool", value: shortAddress(action.poolAddress), mono: true },
        { label: "Position", value: shortAddress(action.positionAddress), mono: true },
      ];
    case "launchToken":
      return [
        { label: "Token", value: action.tokenName },
        { label: "Symbol", value: `$${action.tokenSymbol}` },
        { label: "Mint", value: shortAddress(action.tokenMint), mono: true },
      ];
    case "claimFees":
      return [{ label: "Mint", value: shortAddress(action.tokenMint), mono: true }];
    case "predictionOrder":
      return [
        { label: "Market", value: action.marketTitle },
        { label: "Side", value: action.side },
        { label: "Wager", value: `$${action.amountUsd.toFixed(2)}` },
        { label: "Contracts", value: action.contracts },
        { label: "Order", value: shortAddress(action.orderPubkey), mono: true },
      ];
    case "sellPrediction":
      return [
        { label: "Market", value: action.marketTitle },
        { label: "Position", value: shortAddress(action.positionPubkey), mono: true },
      ];
    case "claimPrediction":
      return [
        { label: "Market", value: action.marketTitle },
        { label: "Payout", value: `$${action.payoutUsd}` },
        { label: "Position", value: shortAddress(action.positionPubkey), mono: true },
      ];
    case "buyNFT":
      return [
        { label: "NFT", value: action.nftName },
        { label: "Price", value: `${action.price} SOL` },
        { label: "Mint", value: shortAddress(action.tokenMint), mono: true },
      ];
    case "listNFT":
      return [
        { label: "NFT", value: action.nftName },
        { label: "Price", value: `${action.price} SOL` },
        { label: "Mint", value: shortAddress(action.tokenMint), mono: true },
      ];
  }
}

function summarizeAction(action: MessageAction): string {
  switch (action.type) {
    case "transfer":
      return `Send ${action.amountLabel ?? action.amount} ${action.assetSymbol} to ${action.toAddress.slice(0, 4)}...${action.toAddress.slice(-4)}`;
    case "swap":
      return action.estimatedOutput
        ? `Swap ${action.amount} ${action.inputToken} → ~${action.estimatedOutput} ${action.outputToken}`
        : `Swap ${action.amount} ${action.inputToken} → ${action.outputToken}`;
    case "addLiquidity":
      return `Add ${Number(action.amountX).toPrecision(6)} ${action.tokenXSymbol} + ${Number(action.amountY).toPrecision(6)} ${action.tokenYSymbol} to ${action.poolName}`;
    case "removeLiquidity":
      return `Remove liquidity from position ${action.positionAddress.slice(0, 8)}...`;
    case "launchToken":
      return `Launch ${action.tokenName} ($${action.tokenSymbol})`;
    case "claimFees":
      return `Claim fees for token ${action.tokenMint.slice(0, 8)}...`;
    case "predictionOrder":
      return `Bet $${action.amountUsd.toFixed(2)} ${action.side} on "${action.marketTitle}"`;
    case "sellPrediction":
      return `Sell position in "${action.marketTitle}"`;
    case "claimPrediction":
      return `Claim $${action.payoutUsd} from "${action.marketTitle}"`;
    case "buyNFT":
      return `Buy "${action.nftName}" for ${action.price} SOL`;
    case "listNFT":
      return `List "${action.nftName}" for ${action.price} SOL`;
  }
}

const suggestedPrompts = [
  "What is my wallet address?",
  "Show my SOL balance",
  "Show all my token holdings",
  "What's the price of SOL?",
  "Swap 0.1 SOL for USDC",
  "Search Meteora pools for SOL-USDC",
  "Show trending crypto prediction markets",
  "Show my NFTs",
  "Show me Mad Lads NFT collection",
];

export default function ChatArea() {
  const { ready, authenticated, login } = usePrivy();
  const { getAccessToken } = useToken();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [confirmingMsg, setConfirmingMsg] = useState<Message | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!authenticated) {
      setWalletAddress(null);
      setWalletError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("No Privy access token");
        const res = await fetch("/api/wallet/ensure", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.address) {
          setWalletError(data.error || "Could not load wallet");
          return;
        }
        setWalletAddress(data.address);
      } catch (e) {
        if (cancelled) return;
        setWalletError(e instanceof Error ? e.message : "Wallet load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const executeConfirmedAction = useCallback(
    async (msg: Message) => {
      if (!msg.action) return;
      const action = msg.action;
      setActionPending(msg.id);
      setConfirmingMsg(null);

      try {
        const token = await getAccessToken();
        if (!token) throw new Error("Not authenticated");

        const res = await fetch("/api/sign-broadcast", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action }),
        });
        const data = await res.json();

        const label = ACTION_LABELS[action.type];
        if (data.ok && data.signature) {
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              role: "assistant",
              content: `${label} successful! [View on Solscan](https://solscan.io/tx/${data.signature})`,
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              role: "assistant",
              content: `${label} failed: ${data.error || data.detail || "unknown"}`,
            },
          ]);
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Signing failed";
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: "assistant",
            content: `${ACTION_LABELS[action.type]} failed: ${errMsg}`,
          },
        ]);
      } finally {
        setActionPending(null);
      }
    },
    [getAccessToken]
  );

  const handleActionCancel = useCallback((msgId: string, actionType: MessageAction["type"]) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.action
          ? { ...m, action: { ...m.action, cancelled: true } as MessageAction }
          : m
      )
    );
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        role: "assistant",
        content: `${ACTION_LABELS[actionType]} cancelled.`,
      },
    ]);
  }, []);

  const handleSend = async (text?: string) => {
    const content = text || input;
    if (!content.trim() || isLoading) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content,
    };

    setMessages((prev) =>
      prev.map((m) => (m.quickReplies ? { ...m, quickReplies: undefined } : m))
    );
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setIsLoading(true);

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: content,
          walletAddress,
          history,
        }),
      });
      const data = await res.json();

      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: data.message || data.error || "Something went wrong.",
        action: data.action || undefined,
        quickReplies: data.quickReplies || undefined,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "Sorry, something went wrong. Please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  if (!ready) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      <header className="flex items-center justify-between px-6 py-3 border-b border-white/10">
        <div />
        {!authenticated ? (
          <button
            onClick={login}
            className="px-4 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 rounded-lg transition-colors"
          >
            Login
          </button>
        ) : (
          <div className="flex items-center gap-3">
            {walletAddress ? (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(walletAddress);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 font-mono transition-colors"
                title="Copy address"
              >
                {walletAddress.slice(0, 4)}...{walletAddress.slice(-4)}
                {copied ? (
                  <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            ) : walletError ? (
              <span className="text-xs text-rose-400" title={walletError}>wallet error</span>
            ) : (
              <span className="text-xs text-zinc-500 animate-pulse">loading wallet...</span>
            )}
            <div className="w-2 h-2 rounded-full bg-green-500" />
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-8">
        {messages.length === 0 ? (
          <div className="max-w-2xl mx-auto">
            <h2 className="text-lg text-zinc-400 mb-6">Try an example:</h2>
            <div className="space-y-2">
              {suggestedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => handleSend(prompt)}
                  className="block w-full text-left px-4 py-2.5 text-sm text-violet-400 hover:text-violet-300 hover:bg-white/5 rounded-lg transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-4">
            {messages.map((msg) => (
              <div key={msg.id}>
                <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm overflow-hidden break-words ${
                      msg.role === "user" ? "bg-violet-600 text-white" : "bg-zinc-800 text-zinc-200"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <Markdown
                        components={{
                          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                          ul: ({ children }) => <ul className="list-disc ml-4 mb-2">{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal ml-4 mb-2">{children}</ol>,
                          li: ({ children }) => <li className="mb-0.5">{children}</li>,
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300 underline break-all">
                              {children}
                            </a>
                          ),
                          code: ({ children }) => (
                            <code className="bg-zinc-700 px-1 py-0.5 rounded text-xs break-all">{children}</code>
                          ),
                        }}
                      >
                        {msg.content}
                      </Markdown>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
                {msg.action && !msg.action.cancelled && (
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={() => setConfirmingMsg(msg)}
                      disabled={actionPending === msg.id}
                      className="px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-500 disabled:bg-green-800 disabled:cursor-not-allowed rounded-xl transition-colors"
                    >
                      {actionPending === msg.id ? "Signing..." : `Confirm: ${summarizeAction(msg.action)}`}
                    </button>
                    <button
                      onClick={() => handleActionCancel(msg.id, msg.action!.type)}
                      disabled={actionPending === msg.id}
                      className="px-4 py-2 text-sm font-medium bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {msg.quickReplies && msg.quickReplies.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2 max-w-[80%]">
                    {msg.quickReplies.map((qr, i) => (
                      <button
                        key={i}
                        onClick={() => handleSend(qr.prompt)}
                        disabled={isLoading}
                        className="px-3 py-1.5 text-xs font-medium bg-white/5 hover:bg-violet-600/20 border border-white/10 hover:border-violet-500/40 text-zinc-300 hover:text-violet-300 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {qr.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-zinc-800 text-zinc-200 px-4 py-2.5 rounded-2xl text-sm">
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce">.</span>
                    <span className="animate-bounce [animation-delay:0.1s]">.</span>
                    <span className="animate-bounce [animation-delay:0.2s]">.</span>
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {confirmingMsg?.action && (() => {
        const action = confirmingMsg.action;
        const txCount = actionTransactionCount(action);
        const feeLamports = txCount * 5000;
        const feeSol = feeLamports / 1_000_000_000;
        const details = actionDetails(action);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-md mx-4 rounded-2xl border border-white/10 bg-zinc-900 p-6 space-y-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
                  {ACTION_LABELS[action.type]}
                </div>
                <div className="text-base text-zinc-100">{summarizeAction(action)}</div>
              </div>

              <dl className="rounded-lg border border-white/10 bg-zinc-950 divide-y divide-white/5 text-sm">
                {details.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-start justify-between gap-3 px-3 py-2"
                  >
                    <dt className="text-zinc-500">{row.label}</dt>
                    <dd
                      className={`text-zinc-100 text-right break-all ${row.mono ? "font-mono text-xs" : ""}`}
                    >
                      {row.value}
                    </dd>
                  </div>
                ))}
                <div className="flex items-start justify-between gap-3 px-3 py-2">
                  <dt className="text-zinc-500">Transactions</dt>
                  <dd className="text-zinc-100">{txCount}</dd>
                </div>
                <div className="flex items-start justify-between gap-3 px-3 py-2">
                  <dt className="text-zinc-500">Network fee (est.)</dt>
                  <dd className="text-zinc-100">
                    ~{feeSol.toFixed(6)} SOL{" "}
                    <span className="text-zinc-500">({feeLamports.toLocaleString()} lamports)</span>
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-3 px-3 py-2">
                  <dt className="text-zinc-500">Network</dt>
                  <dd className="text-zinc-100">Solana mainnet</dd>
                </div>
                <div className="flex items-start justify-between gap-3 px-3 py-2">
                  <dt className="text-zinc-500">Signer</dt>
                  <dd className="text-zinc-100 font-mono text-xs">
                    {walletAddress
                      ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-6)}`
                      : "—"}
                  </dd>
                </div>
              </dl>

              <p className="text-xs text-zinc-500">
                Network fee is the base Solana cost (5,000 lamports per signature). Priority fees and
                program-specific costs (e.g. account creation rent) may add to this.
              </p>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  onClick={() => setConfirmingMsg(null)}
                  disabled={actionPending === confirmingMsg.id}
                  className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => executeConfirmedAction(confirmingMsg)}
                  disabled={actionPending === confirmingMsg.id}
                  className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-500 rounded-lg transition-colors disabled:opacity-50"
                >
                  {actionPending === confirmingMsg.id ? "Signing..." : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="px-6 pb-6">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-end gap-2 bg-zinc-800/50 border border-white/10 rounded-xl px-4 py-3">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 150) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={
                authenticated
                  ? "Ask me anything about crypto... (Shift+Enter for new line)"
                  : "Login to get started..."
              }
              disabled={!authenticated || isLoading}
              rows={1}
              className="flex-1 bg-transparent outline-none text-sm text-white placeholder-zinc-500 resize-none max-h-[150px]"
            />
            <button
              onClick={() => handleSend()}
              disabled={!authenticated || !input.trim() || isLoading}
              className="p-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14m-7-7l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
