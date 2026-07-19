"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePrivy, useToken } from "@privy-io/react-auth";
import Markdown from "react-markdown";
import {
    recordPointsEvent,
    captureRefFromUrl,
    attributePendingRef,
} from "@/app/lib/points-client";

interface QuickReply {
    label: string;
    prompt: string;
}

interface PortfolioTokenRow {
    symbol: string;
    mint: string;
    amount: number;
    amountLabel: string;
    usdValue: number | null;
    usdLabel: string;
}

interface PortfolioPositionRow {
    poolAddress: string;
    poolName: string;
    pairLabel: string;
    amountLabel: string;
    usdLabel: string;
}

interface PortfolioView {
    walletAddress: string;
    solBalance: number;
    solBalanceLabel: string;
    solUsdValue: number | null;
    solUsdLabel: string;
    tokenCount: number;
    tokens: PortfolioTokenRow[];
    // Open Meteora liquidity positions (funds deposited outside spot balances).
    positions?: PortfolioPositionRow[];
    totalUsdValue: number | null;
    totalUsdLabel: string;
    pricesIncomplete: boolean;
}

interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    action?: MessageAction;
    quickReplies?: QuickReply[];
    portfolio?: PortfolioView;
}

// One leg of a multi-swap plan. 1-to-many (execute_portfolio) legs carry only
// `outputMint` + `amountUsd`. many-to-1 (consolidate_tokens) legs also carry a
// per-leg input (`inputMint`/`inputSymbol`) and an exact base-unit `rawAmount`.
interface SwapLeg {
    symbol: string;
    outputMint: string;
    amountUsd?: number;
    inputMint?: string;
    inputSymbol?: string;
    rawAmount?: string;
    inputDecimals?: number;
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
    // Per-leg input mint + exact base-unit size, so quote-refresh retries stay
    // exact and use the correct input (many-to-1 legs).
    inputMint?: string;
    rawAmount?: string;
    // Set when this swap is one leg of a multi-token split/portfolio build. The
    // UI walks the legs in order, preparing the next once this one confirms.
    // `independent` legs (consolidate) have no inter-leg dependency, so the UI
    // advances past a declined/failed one instead of abandoning the rest.
    portfolio?: {
        fundToken: string;
        legs: SwapLeg[];
        index: number;
        independent?: boolean;
    };
}

// Shape of the multi-leg plan returned by /api/chat (execute_portfolio / consolidate_tokens).
interface SwapPlan {
    fundToken: string;
    totalUsd: number;
    legs: SwapLeg[];
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

// Wrap (SOL → WSOL) or unwrap (WSOL → SOL). A single raw transaction that
// broadcasts through the same /api/meteora/execute path as a transfer.
interface WrapSolAction {
    type: "wrapSol";
    transaction: string;
    direction: "wrap" | "unwrap";
    amount: number;
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
    | WrapSolAction
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
    wrapSol: "Convert SOL",
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
                {
                    label: "Amount",
                    value: `${action.amountLabel ?? action.amount} ${action.assetSymbol}`,
                },
                { label: "Recipient", value: action.toAddress, mono: true },
            ];
        case "wrapSol":
            return [
                {
                    label: "Action",
                    value: action.direction === "wrap" ? "Wrap" : "Unwrap",
                },
                {
                    label: "From",
                    value: action.direction === "wrap" ? "SOL" : "WSOL",
                },
                {
                    label: "To",
                    value: action.direction === "wrap" ? "WSOL" : "SOL",
                },
                {
                    label: "Amount",
                    value: `${action.amount} ${action.direction === "wrap" ? "SOL" : "WSOL"}`,
                },
            ];
        case "swap":
            return [
                {
                    label: "From",
                    value: `${action.amount} ${action.inputToken}`,
                },
                {
                    label: "To (estimated)",
                    value: action.estimatedOutput
                        ? `~${action.estimatedOutput} ${action.outputToken}`
                        : action.outputToken,
                },
                {
                    label: "Request ID",
                    value: shortAddress(action.requestId),
                    mono: true,
                },
            ];
        case "addLiquidity":
            return [
                { label: "Pool", value: action.poolName },
                {
                    label: action.tokenXSymbol,
                    value: Number(action.amountX).toPrecision(6),
                },
                {
                    label: action.tokenYSymbol,
                    value: Number(action.amountY).toPrecision(6),
                },
                {
                    label: "Position",
                    value: shortAddress(action.positionAddress),
                    mono: true,
                },
            ];
        case "removeLiquidity":
            return [
                {
                    label: "Pool",
                    value: shortAddress(action.poolAddress),
                    mono: true,
                },
                {
                    label: "Position",
                    value: shortAddress(action.positionAddress),
                    mono: true,
                },
            ];
        case "launchToken":
            return [
                { label: "Token", value: action.tokenName },
                { label: "Symbol", value: `$${action.tokenSymbol}` },
                {
                    label: "Mint",
                    value: shortAddress(action.tokenMint),
                    mono: true,
                },
            ];
        case "claimFees":
            return [
                {
                    label: "Mint",
                    value: shortAddress(action.tokenMint),
                    mono: true,
                },
            ];
        case "predictionOrder":
            return [
                { label: "Market", value: action.marketTitle },
                { label: "Side", value: action.side },
                { label: "Wager", value: `$${action.amountUsd.toFixed(2)}` },
                { label: "Contracts", value: action.contracts },
                {
                    label: "Order",
                    value: shortAddress(action.orderPubkey),
                    mono: true,
                },
            ];
        case "sellPrediction":
            return [
                { label: "Market", value: action.marketTitle },
                {
                    label: "Position",
                    value: shortAddress(action.positionPubkey),
                    mono: true,
                },
            ];
        case "claimPrediction":
            return [
                { label: "Market", value: action.marketTitle },
                { label: "Payout", value: `$${action.payoutUsd}` },
                {
                    label: "Position",
                    value: shortAddress(action.positionPubkey),
                    mono: true,
                },
            ];
        case "buyNFT":
            return [
                { label: "NFT", value: action.nftName },
                { label: "Price", value: `${action.price} SOL` },
                {
                    label: "Mint",
                    value: shortAddress(action.tokenMint),
                    mono: true,
                },
            ];
        case "listNFT":
            return [
                { label: "NFT", value: action.nftName },
                { label: "Price", value: `${action.price} SOL` },
                {
                    label: "Mint",
                    value: shortAddress(action.tokenMint),
                    mono: true,
                },
            ];
    }
}

function summarizeAction(action: MessageAction): string {
    switch (action.type) {
        case "transfer":
            return `Send ${action.amountLabel ?? action.amount} ${action.assetSymbol} to ${action.toAddress.slice(0, 4)}...${action.toAddress.slice(-4)}`;
        case "wrapSol":
            return action.direction === "wrap"
                ? `Wrap ${action.amount} SOL → WSOL`
                : `Unwrap ${action.amount} WSOL → SOL`;
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

// Suggestion chips for the empty/hero state — mirrors the Figma "See what can
// Solens do" list, scoped to capabilities the backend actually supports.
const suggestedPrompts: { text: string; highlight?: boolean }[] = [
    { text: "How should I invest $100?" },
    { text: "Analyze my portfolio and suggest investments" },
    { text: "Show my portfolio, with total balance", highlight: true },
    { text: "Show me the trending memecoins right now" },
    { text: "What's the price of SOL?" },
    { text: "Swap 0.1 SOL for USDC" },
    { text: "Search Meteora pools for SOL-USDC" },
    { text: "Show my NFTs" },
];

function SolensAvatar() {
    return (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-violet-600 text-sm font-extrabold lowercase text-on-brand">
            s
        </div>
    );
}

function SendArrow({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 19V5m0 0-6 6m6-6 6 6"
            />
        </svg>
    );
}

export default function ChatArea() {
    const { ready, authenticated, login, logout } = usePrivy();
    const { getAccessToken } = useToken();
    const [walletAddress, setWalletAddress] = useState<string | null>(null);
    const [walletError, setWalletError] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [confirmingMsg, setConfirmingMsg] = useState<Message | null>(null);
    const [actionPending, setActionPending] = useState<string | null>(null);
    const [finishedActions, setFinishedActions] = useState<Set<string>>(
        () => new Set(),
    );
    const [copied, setCopied] = useState(false);
    const [walletMenuOpen, setWalletMenuOpen] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const walletMenuRef = useRef<HTMLDivElement>(null);

    // Close the account menu on any outside click (mirrors the header on the
    // other pages).
    useEffect(() => {
        if (!walletMenuOpen) return;
        const onClick = (e: MouseEvent) => {
            if (walletMenuRef.current && !walletMenuRef.current.contains(e.target as Node)) {
                setWalletMenuOpen(false);
            }
        };
        document.addEventListener("mousedown", onClick);
        return () => document.removeEventListener("mousedown", onClick);
    }, [walletMenuOpen]);

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
                // Real interactions for the Points system: wallet connected,
                // and attribute any pending referral code to this wallet.
                recordPointsEvent(data.address, "wallet_connect");
                attributePendingRef(data.address);
            } catch (e) {
                if (cancelled) return;
                setWalletError(
                    e instanceof Error ? e.message : "Wallet load failed",
                );
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [authenticated, getAccessToken]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // Remember a `?ref=CODE` from the landing URL until a wallet connects.
    useEffect(() => {
        captureRefFromUrl();
    }, []);

    // Build one leg of a multi-token split/portfolio as a swap action. The
    // dollar slice is converted to a token amount server-side (with a live
    // price) so each leg is sized correctly. Returns null if the quote fails.
    const buildLegAction = useCallback(
        async (
            plan: SwapPlan,
            index: number,
        ): Promise<{ action: SwapAction | null; error?: string }> => {
            if (!walletAddress)
                return { action: null, error: "Connect your wallet first." };
            const leg = plan.legs[index];
            // many-to-1 legs carry their own input mint + exact base-unit size;
            // 1-to-many legs fall back to the shared funding token + USD slice.
            const inputToken = leg.inputMint ?? plan.fundToken;
            const inputLabel = leg.inputSymbol ?? plan.fundToken;
            try {
                const res = await fetch("/api/swap/order", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        inputToken,
                        outputToken: leg.outputMint,
                        ...(leg.rawAmount
                            ? { rawAmount: leg.rawAmount }
                            : { amountUsd: leg.amountUsd }),
                        walletAddress,
                    }),
                });
                const d = await res.json();
                if (!res.ok || !d.transaction || !d.requestId)
                    return { action: null, error: d.error || d.detail };
                return {
                    action: {
                        type: "swap",
                        transaction: d.transaction,
                        requestId: d.requestId,
                        inputToken: inputLabel,
                        inputMint: leg.inputMint,
                        rawAmount: leg.rawAmount,
                        outputToken: leg.symbol,
                        // Prefer the exact base-unit balance for display (the
                        // order route's echoed amount can mis-decimal unknown
                        // mints); fall back to the route amount / USD slice.
                        amount:
                            leg.rawAmount &&
                            typeof leg.inputDecimals === "number"
                                ? Number(leg.rawAmount) /
                                  10 ** leg.inputDecimals
                                : typeof d.amount === "number"
                                  ? d.amount
                                  : (leg.amountUsd ?? 0),
                        estimatedOutput: d.estimatedOutput ?? null,
                        portfolio: {
                            fundToken: plan.fundToken,
                            legs: plan.legs,
                            index,
                            independent: !!leg.inputMint,
                        },
                    },
                };
            } catch {
                return { action: null };
            }
        },
        [walletAddress],
    );

    // Append the next leg of a split as its own confirmable swap card. The user
    // confirms it, then executeConfirmedAction prepares the leg after it.
    const appendPortfolioLeg = useCallback(
        async (plan: SwapPlan, index: number) => {
            const total = plan.legs.length;
            const leg = plan.legs[index];
            // Direction-agnostic labels: `from → to`. 1-to-many legs sell the
            // shared funding token; many-to-1 legs sell each leg's own input.
            const fromSym = leg.inputSymbol ?? plan.fundToken;
            const toSym = leg.symbol;
            const nextLeg = plan.legs[index + 1];
            const nextLabel = nextLeg
                ? (nextLeg.inputSymbol ?? nextLeg.symbol)
                : "";
            const sizeLabel =
                typeof leg.amountUsd === "number"
                    ? `~$${leg.amountUsd.toFixed(2)}`
                    : leg.rawAmount && typeof leg.inputDecimals === "number"
                      ? `${(
                            Number(leg.rawAmount) /
                            10 ** leg.inputDecimals
                        ).toLocaleString(undefined, {
                            maximumFractionDigits: 6,
                        })} ${fromSym}`
                      : `all your ${fromSym}`;
            const { action, error } = await buildLegAction(plan, index);
            // Insufficient balance is a hard failure — retrying won't help, so say
            // so plainly instead of implying a transient quote hiccup.
            const insufficientFunds =
                !!error && /insufficient|not enough|balance/i.test(error);
            const failureContent = insufficientFunds
                ? `Couldn't prepare the ${fromSym} → ${toSym} swap (leg ${index + 1} of ${total}): you don't have enough ${fromSym}. (Retrying won't help until the balance is there.)`
                : `Couldn't prepare the ${fromSym} → ${toSym} swap (leg ${index + 1} of ${total}) right now — the quote failed. Ask me to retry the rest.`;
            setMessages((prev) => [
                ...prev,
                action
                    ? {
                          id: `${Date.now()}-leg${index}`,
                          role: "assistant",
                          content: `Swap ${index + 1} of ${total}: ${fromSym} → ${toSym} (${sizeLabel}).${
                              index + 1 < total
                                  ? ` Confirm and I'll prepare ${nextLabel} next.`
                                  : " This is the final leg."
                          }`,
                          action,
                      }
                    : {
                          id: `${Date.now()}-leg${index}-err`,
                          role: "assistant",
                          content: failureContent,
                      },
            ]);
        },
        [buildLegAction],
    );

    const executeConfirmedAction = useCallback(
        async (msg: Message) => {
            if (!msg.action) return;
            if (finishedActions.has(msg.id)) return; // already completed, prevent double-submit
            const action = msg.action;
            setActionPending(msg.id);
            setConfirmingMsg(null);

            const appendAssistant = (content: string) =>
                setMessages((prev) => [
                    ...prev,
                    {
                        id: Date.now().toString(),
                        role: "assistant",
                        content,
                    },
                ]);

            const signAndBroadcast = async (act: MessageAction) => {
                const token = await getAccessToken();
                if (!token) throw new Error("Not authenticated");
                const res = await fetch("/api/sign-broadcast", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({ action: act }),
                });
                return (await res.json()) as {
                    ok?: boolean;
                    pending?: boolean;
                    signature?: string;
                    error?: string;
                    detail?: string;
                };
            };

            // Fetch a fresh quote (and blockhash) for a swap that failed due to
            // an expired quote or a transient fee error.
            const refetchSwap = async (
                swap: SwapAction,
            ): Promise<SwapAction> => {
                const res = await fetch("/api/swap/order", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        // Prefer the exact mint over the display symbol so unknown
                        // memecoins re-quote correctly on a consolidate leg.
                        inputToken: swap.inputMint ?? swap.inputToken,
                        outputToken: swap.outputToken,
                        ...(swap.rawAmount
                            ? { rawAmount: swap.rawAmount }
                            : { amount: swap.amount }),
                        walletAddress,
                    }),
                });
                const data = await res.json();
                if (!res.ok || !data.transaction || !data.requestId) {
                    throw new Error(
                        data.error || "Could not refresh the swap quote",
                    );
                }
                return {
                    ...swap,
                    transaction: data.transaction,
                    requestId: data.requestId,
                };
            };

            const isRetryableSwapError = (m: string) =>
                /expired|blockhash|not.*confirmed|insufficient|timed out|slippage|0x1/i.test(
                    m,
                );

            const label = ACTION_LABELS[action.type];
            try {
                let data = await signAndBroadcast(action);

                // Swaps: a stale quote/blockhash or transient fee error is
                // recoverable, so refresh the quote and retry once.
                if (
                    !data.ok &&
                    !data.pending &&
                    action.type === "swap" &&
                    walletAddress &&
                    isRetryableSwapError(String(data.error || ""))
                ) {
                    try {
                        const refreshed = await refetchSwap(action);
                        appendAssistant(
                            "The previous quote expired, so I refreshed it and am retrying the swap on the latest price.",
                        );
                        data = await signAndBroadcast(refreshed);
                    } catch {
                        // keep the original failure below
                    }
                }

                if (data.ok && data.signature) {
                    setFinishedActions((prev) => new Set(prev).add(msg.id));
                    // Record the real, on-chain action for the Points system.
                    // The server re-verifies the signature before awarding.
                    recordPointsEvent(walletAddress, action.type, data.signature);
                    appendAssistant(
                        `${label} successful! [View on Solscan](https://solscan.io/tx/${data.signature})`,
                    );
                    // Part of a multi-token split/consolidation: prepare the next
                    // leg (or finish).
                    if (action.type === "swap" && action.portfolio) {
                        const pf = action.portfolio;
                        if (pf.index + 1 < pf.legs.length) {
                            await appendPortfolioLeg(
                                {
                                    fundToken: pf.fundToken,
                                    totalUsd: pf.legs.reduce(
                                        (s, l) => s + (l.amountUsd ?? 0),
                                        0,
                                    ),
                                    legs: pf.legs,
                                },
                                pf.index + 1,
                            );
                        } else {
                            appendAssistant(
                                `All ${pf.legs.length} swaps done. 🎉`,
                            );
                        }
                    }
                } else if (data.pending) {
                    // Submitted but not confirmed: do not claim success, but lock
                    // the action so it is not re-submitted while it lands.
                    setFinishedActions((prev) => new Set(prev).add(msg.id));
                    const link = data.signature
                        ? ` [Check on Solscan](https://solscan.io/tx/${data.signature})`
                        : "";
                    appendAssistant(
                        `${label} submitted but not confirmed yet. It may still land.${link}`,
                    );
                } else {
                    appendAssistant(
                        `${label} failed: ${data.error || data.detail || "unknown"}`,
                    );
                    // Consolidate legs are independent — one failing shouldn't
                    // abandon the rest; move on to the next input token.
                    if (
                        action.type === "swap" &&
                        action.portfolio?.independent &&
                        action.portfolio.index + 1 <
                            action.portfolio.legs.length
                    ) {
                        const pf = action.portfolio;
                        await appendPortfolioLeg(
                            {
                                fundToken: pf.fundToken,
                                totalUsd: pf.legs.reduce(
                                    (s, l) => s + (l.amountUsd ?? 0),
                                    0,
                                ),
                                legs: pf.legs,
                            },
                            pf.index + 1,
                        );
                    }
                }
            } catch (e) {
                const errMsg =
                    e instanceof Error ? e.message : "Signing failed";
                appendAssistant(`${label} failed: ${errMsg}`);
            } finally {
                setActionPending(null);
            }
        },
        [getAccessToken, walletAddress, finishedActions, appendPortfolioLeg],
    );

    const handleActionCancel = useCallback(
        (msg: Message) => {
            const action = msg.action;
            if (!action) return;
            setMessages((prev) =>
                prev.map((m) =>
                    m.id === msg.id && m.action
                        ? {
                              ...m,
                              action: {
                                  ...m.action,
                                  cancelled: true,
                              } as MessageAction,
                          }
                        : m,
                ),
            );
            setMessages((prev) => [
                ...prev,
                {
                    id: Date.now().toString(),
                    role: "assistant",
                    content: `${ACTION_LABELS[action.type]} cancelled.`,
                },
            ]);
            // Consolidate legs are independent — declining one shouldn't abandon
            // the rest; prepare the next input token's swap.
            if (
                action.type === "swap" &&
                action.portfolio?.independent &&
                action.portfolio.index + 1 < action.portfolio.legs.length
            ) {
                const pf = action.portfolio;
                appendPortfolioLeg(
                    {
                        fundToken: pf.fundToken,
                        totalUsd: pf.legs.reduce(
                            (s, l) => s + (l.amountUsd ?? 0),
                            0,
                        ),
                        legs: pf.legs,
                    },
                    pf.index + 1,
                );
            }
        },
        [appendPortfolioLeg],
    );

    const handleSend = async (text?: string) => {
        const content = text || input;
        if (!content.trim() || isLoading) return;

        const userMsg: Message = {
            id: Date.now().toString(),
            role: "user",
            content,
        };

        setMessages((prev) =>
            prev.map((m) =>
                m.quickReplies ? { ...m, quickReplies: undefined } : m,
            ),
        );
        setMessages((prev) => [...prev, userMsg]);
        setInput("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setIsLoading(true);

        // Real interaction for the Points system (idempotent server-side, so
        // only the first message per wallet ever counts toward "Say Hello").
        recordPointsEvent(walletAddress, "ai_message");

        try {
            const history = messages.map((m) => ({
                role: m.role,
                content: m.content,
            }));
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
                portfolio: data.portfolio || undefined,
            };
            setMessages((prev) => [...prev, assistantMsg]);

            // A multi-token split/portfolio build: kick off the first leg. Each
            // leg is a normal swap card; confirming one prepares the next.
            const plan = data.swapPlan as SwapPlan | undefined;
            if (
                plan &&
                Array.isArray(plan.legs) &&
                plan.legs.length > 0 &&
                walletAddress
            ) {
                await appendPortfolioLeg(plan, 0);
            }
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
            <div className="flex flex-1 items-center justify-center">
                <div className="animate-pulse text-text-secondary">
                    Loading…
                </div>
            </div>
        );
    }

    const isEmpty = messages.length === 0;

    return (
        <div className="relative flex h-full flex-1 flex-col bg-base">
            {/* Topbar */}
            <header className="flex items-center justify-end border-b border-subtle px-4 py-2.5 sm:px-6">
                {!authenticated ? (
                    <button
                        onClick={login}
                        className="rounded-lg bg-violet-500 px-3.5 py-2 text-xs font-semibold text-on-brand transition-colors hover:bg-violet-400"
                    >
                        Login
                    </button>
                ) : walletAddress ? (
                    <div className="relative" ref={walletMenuRef}>
                        <button
                            onClick={() => setWalletMenuOpen((o) => !o)}
                            className="flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-violet-600 transition-colors hover:bg-violet-50"
                            aria-haspopup="menu"
                            aria-expanded={walletMenuOpen}
                        >
                            {walletAddress.slice(0, 4)}…{walletAddress.slice(-4)}
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M3 10h18M3 10v8a2 2 0 002 2h14a2 2 0 002-2v-8M3 10l2-5h14l2 5M16 14h.01"
                                />
                            </svg>
                        </button>

                        {walletMenuOpen && (
                            <div
                                role="menu"
                                className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl bg-surface card-shadow"
                            >
                                <div className="border-b border-subtle px-4 py-3">
                                    <p className="text-xs text-text-secondary/70">Signed in as</p>
                                    <p className="mt-0.5 font-mono text-sm text-text-primary">
                                        {walletAddress.slice(0, 4)}…{walletAddress.slice(-4)}
                                    </p>
                                </div>
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(walletAddress);
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 1500);
                                    }}
                                    className="flex w-full items-center justify-between px-4 py-3 text-sm text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary"
                                    role="menuitem"
                                >
                                    Copy address
                                    {copied && <span className="text-xs text-success">Copied!</span>}
                                </button>
                                <button
                                    onClick={() => {
                                        setWalletMenuOpen(false);
                                        void logout();
                                    }}
                                    className="flex w-full items-center gap-2 border-t border-subtle px-4 py-3 text-sm font-medium text-danger transition-colors hover:bg-danger/10"
                                    role="menuitem"
                                >
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                                        />
                                    </svg>
                                    Log out
                                </button>
                            </div>
                        )}
                    </div>
                ) : walletError ? (
                    <span className="text-xs text-danger" title={walletError}>
                        wallet error
                    </span>
                ) : (
                    <span className="animate-pulse text-xs text-text-secondary">
                        loading wallet…
                    </span>
                )}
            </header>

            {/* Bottom violet glow */}
            <div className="glow-violet pointer-events-none absolute inset-x-0 bottom-0 h-[360px]" />

            {/* Scroll area */}
            <div className="relative flex-1 overflow-y-auto px-4 py-8 sm:px-6 sm:py-10">
                {isEmpty ? (
                    <div className="mx-auto w-full max-w-3xl">
                        <div className="flex flex-col gap-3">
                            <h1 className="text-gradient-brand text-2xl font-semibold leading-tight sm:text-[32px]">
                                Welcome to Solens
                                <br />
                                The simplest way to trade crypto!
                            </h1>
                            <p className="max-w-xl text-sm leading-relaxed text-text-secondary">
                                New to crypto? You can ask me anything. Remember
                                I&apos;m an AI, I don&apos;t judge. Whenever
                                you&apos;re ready, I&apos;m here to help you do
                                transactions with ease and confidence.
                            </p>
                        </div>

                        <div className="mt-7 flex flex-col gap-2 rounded-2xl bg-surface p-3">
                            <p className="px-1 text-sm text-text-secondary">
                                See what Solens can do:
                            </p>
                            {suggestedPrompts.map(({ text, highlight }) => (
                                <button
                                    key={text}
                                    onClick={() =>
                                        authenticated
                                            ? handleSend(text)
                                            : login()
                                    }
                                    className={`rounded-xl px-4 py-2.5 text-left text-sm text-text-primary transition-colors hover:bg-elevated ${
                                        highlight
                                            ? "border border-violet-300 bg-elevated/40"
                                            : "bg-elevated/20"
                                    }`}
                                >
                                    {text}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="mx-auto w-full max-w-3xl space-y-5">
                        {messages.map((msg) => (
                            <div key={msg.id}>
                                <div
                                    className={`flex items-start gap-2.5 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                                >
                                    {msg.role === "assistant" && (
                                        <SolensAvatar />
                                    )}
                                    <div
                                        className={`max-w-[82%] overflow-hidden break-words rounded-2xl px-4 py-2.5 text-sm ${
                                            msg.role === "user"
                                                ? "bg-violet-500 text-on-brand"
                                                : "border border-subtle bg-surface text-text-primary"
                                        }`}
                                    >
                                        {msg.role === "assistant" ? (
                                            <Markdown
                                                components={{
                                                    p: ({ children }) => (
                                                        <p className="mb-2 last:mb-0">
                                                            {children}
                                                        </p>
                                                    ),
                                                    strong: ({ children }) => (
                                                        <strong className="font-semibold text-text-primary">
                                                            {children}
                                                        </strong>
                                                    ),
                                                    ul: ({ children }) => (
                                                        <ul className="mb-2 ml-4 list-disc">
                                                            {children}
                                                        </ul>
                                                    ),
                                                    ol: ({ children }) => (
                                                        <ol className="mb-2 ml-4 list-decimal">
                                                            {children}
                                                        </ol>
                                                    ),
                                                    li: ({ children }) => (
                                                        <li className="mb-0.5">
                                                            {children}
                                                        </li>
                                                    ),
                                                    a: ({ href, children }) => (
                                                        <a
                                                            href={href}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="break-all text-violet-300 underline hover:text-violet-200"
                                                        >
                                                            {children}
                                                        </a>
                                                    ),
                                                    code: ({ children }) => (
                                                        <code className="break-all rounded bg-elevated px-1 py-0.5 text-xs">
                                                            {children}
                                                        </code>
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

                                {msg.portfolio && (
                                    <div className="ml-[38px]">
                                        <PortfolioCard
                                            portfolio={msg.portfolio}
                                            onBuy={(prompt) =>
                                                handleSend(prompt)
                                            }
                                            disabled={isLoading}
                                        />
                                    </div>
                                )}

                                {msg.action &&
                                    !msg.action.cancelled &&
                                    !finishedActions.has(msg.id) && (
                                        <div className="ml-[38px]">
                                            <ActionCard
                                                action={msg.action}
                                                pending={
                                                    actionPending === msg.id
                                                }
                                                onConfirm={() =>
                                                    setConfirmingMsg(msg)
                                                }
                                                onCancel={() =>
                                                    handleActionCancel(msg)
                                                }
                                            />
                                        </div>
                                    )}

                                {msg.quickReplies &&
                                    msg.quickReplies.length > 0 && (
                                        <div className="ml-[38px] mt-2.5 flex max-w-[82%] flex-wrap gap-2">
                                            {msg.quickReplies.map((qr, i) => (
                                                <button
                                                    key={i}
                                                    onClick={() =>
                                                        handleSend(qr.prompt)
                                                    }
                                                    disabled={isLoading}
                                                    className="rounded-lg border border-subtle bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-all hover:border-violet-300 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    {qr.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex items-start justify-start gap-2.5">
                                <SolensAvatar />
                                <div className="rounded-2xl border border-subtle bg-surface px-4 py-3 text-sm">
                                    <span className="inline-flex gap-1">
                                        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-300" />
                                        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-300 [animation-delay:0.15s]" />
                                        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-300 [animation-delay:0.3s]" />
                                    </span>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>
                )}
            </div>

            {/* Confirm modal */}
            {confirmingMsg?.action &&
                (() => {
                    const action = confirmingMsg.action;
                    const txCount = actionTransactionCount(action);
                    const feeLamports = txCount * 5000;
                    const feeSol = feeLamports / 1_000_000_000;
                    const details = actionDetails(action);
                    return (
                        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
                            <div className="mx-4 w-full max-w-md space-y-4 rounded-2xl border border-subtle bg-surface p-6 shadow-2xl">
                                <div>
                                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-violet-300">
                                        {ACTION_LABELS[action.type]}
                                    </div>
                                    <div className="text-base text-text-primary">
                                        {summarizeAction(action)}
                                    </div>
                                </div>

                                <dl className="divide-y divide-subtle rounded-xl border border-subtle bg-base text-sm">
                                    {details.map((row) => (
                                        <div
                                            key={row.label}
                                            className="flex items-start justify-between gap-3 px-3 py-2"
                                        >
                                            <dt className="text-text-secondary">
                                                {row.label}
                                            </dt>
                                            <dd
                                                className={`break-all text-right text-text-primary ${row.mono ? "font-mono text-xs" : ""}`}
                                            >
                                                {row.value}
                                            </dd>
                                        </div>
                                    ))}
                                    <div className="flex items-start justify-between gap-3 px-3 py-2">
                                        <dt className="text-text-secondary">
                                            Transactions
                                        </dt>
                                        <dd className="text-text-primary">
                                            {txCount}
                                        </dd>
                                    </div>
                                    <div className="flex items-start justify-between gap-3 px-3 py-2">
                                        <dt className="text-text-secondary">
                                            Network fee (est.)
                                        </dt>
                                        <dd className="text-text-primary">
                                            ~{feeSol.toFixed(6)} SOL{" "}
                                            <span className="text-text-secondary">
                                                ({feeLamports.toLocaleString()}{" "}
                                                lamports)
                                            </span>
                                        </dd>
                                    </div>
                                    <div className="flex items-start justify-between gap-3 px-3 py-2">
                                        <dt className="text-text-secondary">
                                            Network
                                        </dt>
                                        <dd className="text-text-primary">
                                            Solana mainnet
                                        </dd>
                                    </div>
                                    <div className="flex items-start justify-between gap-3 px-3 py-2">
                                        <dt className="text-text-secondary">
                                            Signer
                                        </dt>
                                        <dd className="font-mono text-xs text-text-primary">
                                            {walletAddress
                                                ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-6)}`
                                                : "—"}
                                        </dd>
                                    </div>
                                </dl>

                                <p className="text-xs text-text-secondary">
                                    Network fee is the base Solana cost (5,000
                                    lamports per signature). Priority fees and
                                    program-specific costs (e.g. account
                                    creation rent) may add to this.
                                </p>

                                <div className="flex items-center justify-end gap-2 pt-1">
                                    <button
                                        onClick={() => setConfirmingMsg(null)}
                                        disabled={
                                            actionPending === confirmingMsg.id
                                        }
                                        className="rounded-lg bg-elevated px-4 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={() =>
                                            executeConfirmedAction(
                                                confirmingMsg,
                                            )
                                        }
                                        disabled={
                                            actionPending === confirmingMsg.id
                                        }
                                        className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-on-brand transition-colors hover:bg-violet-400 disabled:opacity-50"
                                    >
                                        {actionPending === confirmingMsg.id
                                            ? "Signing…"
                                            : "Confirm"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

            {/* Composer */}
            <div className="relative px-4 pb-6 sm:px-6">
                <div className="mx-auto w-full max-w-3xl">
                    <div className="flex items-end gap-2 rounded-2xl border border-subtle bg-surface px-3 py-2.5 focus-within:border-violet-300">
                        <textarea
                            ref={textareaRef}
                            value={input}
                            onChange={(e) => {
                                setInput(e.target.value);
                                e.target.style.height = "auto";
                                e.target.style.height =
                                    Math.min(e.target.scrollHeight, 150) + "px";
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSend();
                                }
                            }}
                            placeholder={
                                authenticated
                                    ? "Ask anything about crypto…"
                                    : "Login to get started…"
                            }
                            disabled={!authenticated || isLoading}
                            rows={1}
                            className="max-h-[150px] flex-1 resize-none self-center bg-transparent px-1 text-sm text-text-primary placeholder-text-secondary/70 outline-none disabled:cursor-not-allowed"
                        />
                        <button
                            onClick={() => handleSend()}
                            disabled={
                                !authenticated || !input.trim() || isLoading
                            }
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-500 text-on-brand transition-opacity hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
                            aria-label="Send"
                        >
                            <SendArrow className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function ActionCard({
    action,
    pending,
    onConfirm,
    onCancel,
}: {
    action: MessageAction;
    pending: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const details = actionDetails(action);
    return (
        <div className="mt-2.5 max-w-[82%] overflow-hidden rounded-2xl border border-subtle bg-surface">
            <div className="flex items-center justify-between border-b border-subtle px-4 py-2.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">
                    {ACTION_LABELS[action.type]}
                </span>
                <span className="text-xs text-text-secondary">
                    Review &amp; confirm
                </span>
            </div>
            <dl className="divide-y divide-subtle/60 px-4 py-1 text-sm">
                {details.map((row) => (
                    <div
                        key={row.label}
                        className="flex items-start justify-between gap-3 py-2"
                    >
                        <dt className="text-text-secondary">{row.label}</dt>
                        <dd
                            className={`break-all text-right text-text-primary ${row.mono ? "font-mono text-xs" : ""}`}
                        >
                            {row.value}
                        </dd>
                    </div>
                ))}
            </dl>
            <div className="flex items-center gap-2 px-4 py-3">
                <button
                    onClick={onConfirm}
                    disabled={pending}
                    className="flex-1 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-on-brand transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {pending ? "Signing…" : "Confirm"}
                </button>
                <button
                    onClick={onCancel}
                    disabled={pending}
                    className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}

function PortfolioCard({
    portfolio,
    onBuy,
    disabled,
}: {
    portfolio: PortfolioView;
    onBuy: (prompt: string) => void;
    disabled: boolean;
}) {
    const short = (a: string) =>
        a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;

    return (
        <div className="mt-2.5 max-w-[82%] overflow-hidden rounded-2xl border border-subtle bg-surface">
            <div className="flex items-center justify-between border-b border-subtle px-4 py-2.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">
                    Portfolio
                </span>
                <span className="font-mono text-xs text-text-secondary">
                    {short(portfolio.walletAddress)}
                </span>
            </div>

            {/* Total */}
            <div className="flex items-baseline justify-between px-4 py-3">
                <span className="text-sm text-text-secondary">Total value</span>
                <span className="text-lg font-semibold text-text-primary">
                    {portfolio.totalUsdLabel}
                </span>
            </div>

            {/* Holdings */}
            <dl className="divide-y divide-subtle/60 border-t border-subtle px-4 py-1 text-sm">
                <div className="flex items-center justify-between gap-3 py-2">
                    <dt className="flex flex-col">
                        <span className="text-text-primary">SOL</span>
                        <span className="text-xs text-text-secondary">
                            {portfolio.solBalanceLabel}
                        </span>
                    </dt>
                    <dd className="text-right text-text-primary">
                        {portfolio.solUsdLabel}
                    </dd>
                </div>

                {portfolio.tokens.map((t) => (
                    <div
                        key={t.mint}
                        className="flex items-center justify-between gap-3 py-2"
                    >
                        <dt className="flex min-w-0 flex-col">
                            <span className="truncate text-text-primary">
                                {t.symbol}
                            </span>
                            <span className="text-xs text-text-secondary">
                                {t.amountLabel}
                            </span>
                        </dt>
                        <dd className="flex items-center gap-2">
                            <span className="text-right text-text-primary">
                                {t.usdLabel}
                            </span>
                            <button
                                onClick={() =>
                                    onBuy(
                                        `Swap 0.05 SOL for ${t.symbol} (mint: ${t.mint})`,
                                    )
                                }
                                disabled={disabled}
                                className="rounded-md border border-subtle px-2 py-1 text-xs text-text-secondary transition-colors hover:border-violet-300 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Buy more
                            </button>
                        </dd>
                    </div>
                ))}
            </dl>

            {/* Liquidity positions — funds deposited into Meteora pools that live
                outside the spot balances, so they don't look "lost". */}
            {portfolio.positions && portfolio.positions.length > 0 && (
                <dl className="divide-y divide-subtle/60 border-t border-subtle px-4 py-1 text-sm">
                    <div className="pt-2 pb-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">
                            Liquidity positions
                        </span>
                    </div>
                    {portfolio.positions.map((p) => (
                        <div
                            key={p.poolAddress}
                            className="flex items-center justify-between gap-3 py-2"
                        >
                            <dt className="flex min-w-0 flex-col">
                                <span className="truncate text-text-primary">
                                    {p.pairLabel}
                                </span>
                                <span className="truncate text-xs text-text-secondary">
                                    {p.amountLabel}
                                </span>
                            </dt>
                            <dd className="flex items-center gap-2">
                                <span className="text-right text-text-primary">
                                    {p.usdLabel}
                                </span>
                                <button
                                    onClick={() =>
                                        onBuy(
                                            `Remove my liquidity from the ${p.poolName} pool (${p.poolAddress})`,
                                        )
                                    }
                                    disabled={disabled}
                                    className="rounded-md border border-subtle px-2 py-1 text-xs text-text-secondary transition-colors hover:border-violet-300 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Withdraw
                                </button>
                            </dd>
                        </div>
                    ))}
                    <p className="pb-2 pt-1 text-xs text-text-secondary">
                        Value includes deposited liquidity plus the refundable
                        SOL rent you reclaim when you withdraw.
                    </p>
                </dl>
            )}

            {portfolio.pricesIncomplete && (
                <p className="px-4 pb-3 pt-1 text-xs text-text-secondary">
                    Some token prices are unavailable right now, so the total is
                    partial.
                </p>
            )}
        </div>
    );
}
