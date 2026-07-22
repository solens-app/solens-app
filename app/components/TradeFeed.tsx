"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types — mirror the server FeedEntry shape (app/lib/points.ts).
// ---------------------------------------------------------------------------

type FeedTrade = {
  token: { mint: string; symbol: string; logo: string | null };
  side: "buy" | "sell";
  amount: number;
  usd: number | null;
};

type FeedPrediction = {
  title: string;
  side: "YES" | "NO" | null;
  usd: number | null;
};

type FeedEntry = {
  id: string;
  wallet: string;
  short: string;
  type: string;
  label: string;
  signature: string | null;
  trade: FeedTrade | null;
  prediction?: FeedPrediction | null;
  detail?: string | null;
  ts: number;
};

type FeedResponse = {
  items?: FeedEntry[];
  nextCursor?: number | null;
  configured?: boolean;
};

type FilterKey = "all" | "swap" | "transfer" | "prediction";

const FILTERS: { key: FilterKey; label: string; match: (t: string) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "swap", label: "Swaps", match: (t) => t === "swap" },
  { key: "transfer", label: "Transfers", match: (t) => t === "transfer" },
  { key: "prediction", label: "Predictions", match: (t) => t.startsWith("prediction") },
];

const POLL_MS = 15_000;
const PAGE_SIZE = 30;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function compactUsd(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(2)}`;
}

function compactAmount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (abs >= 1) return n.toFixed(2);
  return n.toPrecision(2);
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

// Deterministic gradient avatar seeded by the wallet address.
function avatarGradient(wallet: string): string {
  let hash = 0;
  for (let i = 0; i < wallet.length; i++) hash = (hash * 31 + wallet.charCodeAt(i)) >>> 0;
  const h1 = hash % 360;
  const h2 = (h1 + 60 + ((hash >> 8) % 120)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))`;
}

// ---------------------------------------------------------------------------
// Demo feed — shown only when no database is configured (local preview), so the
// panel renders meaningfully without a live backend. Clearly labelled.
// ---------------------------------------------------------------------------

function demoItems(): FeedEntry[] {
  const now = Date.now();
  const mk = (
    id: string,
    wallet: string,
    secsAgo: number,
    trade: FeedTrade | null,
    type = "swap",
    label = "Swap",
  ): FeedEntry => ({
    id,
    wallet,
    short: wallet.length > 8 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet,
    type,
    label,
    signature: null,
    trade,
    ts: now - secsAgo * 1000,
  });
  return [
    mk("d1", "7xKqFz9aQm3pR8vT2nH4bC6dW1sL5gY0uE", 41, {
      token: { mint: "FLORK", symbol: "FLORK", logo: null },
      side: "buy",
      amount: 3600,
      usd: 3600,
    }),
    mk("d2", "9mNpLcVe2Xk7Yb4Rt6Ha3Qw8Zs1Df5Gj0oU", 54, {
      token: { mint: "WIF", symbol: "WIF", logo: null },
      side: "buy",
      amount: 1240,
      usd: 897,
    }),
    mk("d3", "3bHkQwRt7Ym2Nc9Xp4La6Vs1Zd8Gf5Uj0eP", 92, {
      token: { mint: "BONK", symbol: "BONK", logo: null },
      side: "sell",
      amount: 2400000,
      usd: 849,
    }),
    mk("d4", "5cWkPqLm8Xn3Rb6Yt2Ha9Vs4Zd7Gf1Uj0iO", 180, null, "transfer", "Transfer"),
  ];
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SocialFeedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z"
      />
    </svg>
  );
}

function Avatar({ wallet }: { wallet: string }) {
  return (
    <span
      aria-hidden
      className="h-8 w-8 flex-shrink-0 rounded-full ring-1 ring-black/10"
      style={{ background: avatarGradient(wallet) }}
    />
  );
}

function TokenLogo({ trade }: { trade: FeedTrade }) {
  const [broken, setBroken] = useState(false);
  if (trade.token.logo && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external token icons from arbitrary CDNs
      <img
        src={trade.token.logo}
        alt=""
        className="h-5 w-5 flex-shrink-0 rounded-full object-cover"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-elevated text-[10px] font-semibold text-text-secondary">
      {trade.token.symbol.slice(0, 1).toUpperCase()}
    </span>
  );
}

function SideBadge({ side }: { side: "buy" | "sell" }) {
  const isBuy = side === "buy";
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
        isBuy ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
      }`}
    >
      {isBuy ? "Buy" : "Sell"}
    </span>
  );
}

function SolscanLink({ signature }: { signature: string }) {
  return (
    <a
      href={`https://solscan.io/tx/${signature}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-text-secondary/60 transition-colors hover:text-violet-300"
      aria-label="View transaction on Solscan"
      onClick={(e) => e.stopPropagation()}
    >
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5m0 0v5m0-5L10 14M9 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-3" />
      </svg>
    </a>
  );
}

function PredictionSideBadge({ side }: { side: "YES" | "NO" }) {
  const isYes = side === "YES";
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
        isYes ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
      }`}
    >
      {side}
    </span>
  );
}

function FeedCard({ entry }: { entry: FeedEntry }) {
  const { trade, prediction, detail } = entry;
  return (
    <li className="border-b border-subtle px-4 py-3 transition-colors hover:bg-elevated/40">
      <div className="flex items-center gap-2">
        <Avatar wallet={entry.wallet} />
        <a
          href={`https://solscan.io/account/${entry.wallet}`}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate font-mono text-sm font-medium text-text-primary transition-colors hover:text-violet-300"
        >
          {entry.short}
        </a>
        {trade ? <SideBadge side={trade.side} /> : (
          <span className="rounded-md bg-elevated px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">
            {entry.label}
          </span>
        )}
        <span className="ml-auto flex-shrink-0 text-xs text-text-secondary/70">{relTime(entry.ts)}</span>
      </div>

      {trade ? (
        <div className="mt-2 flex items-center gap-2 pl-10">
          <TokenLogo trade={trade} />
          <span className="font-medium text-text-primary">{trade.token.symbol}</span>
          <span className="truncate text-xs text-text-secondary/60">
            {compactAmount(trade.amount)} {trade.token.symbol}
          </span>
          <span className="ml-auto flex flex-shrink-0 items-center gap-2">
            {compactUsd(trade.usd) && (
              <span className="text-sm font-semibold text-text-primary">{compactUsd(trade.usd)}</span>
            )}
            {entry.signature && <SolscanLink signature={entry.signature} />}
          </span>
        </div>
      ) : prediction ? (
        <div className="mt-2 flex items-start gap-2 pl-10">
          {prediction.side && <PredictionSideBadge side={prediction.side} />}
          <span className="min-w-0 flex-1 text-sm leading-snug text-text-primary">
            {prediction.title}
          </span>
          <span className="flex flex-shrink-0 items-center gap-2">
            {compactUsd(prediction.usd) && (
              <span className="text-sm font-semibold text-text-primary">
                {compactUsd(prediction.usd)}
              </span>
            )}
            {entry.signature && <SolscanLink signature={entry.signature} />}
          </span>
        </div>
      ) : (
        (detail || entry.signature) && (
          <div className="mt-1.5 flex items-center gap-2 pl-10 text-sm text-text-secondary">
            <span className="min-w-0 truncate">
              {detail ?? `On-chain ${entry.label.toLowerCase()}`}
            </span>
            {entry.signature && (
              <span className="ml-auto flex-shrink-0">
                <SolscanLink signature={entry.signature} />
              </span>
            )}
          </div>
        )
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Feed body — the actual list + header controls, shared by rail and drawer.
// ---------------------------------------------------------------------------

function FeedBody({
  onCollapse,
  onClose,
}: {
  onCollapse?: () => void;
  onClose?: () => void;
}) {
  const [items, setItems] = useState<FeedEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "demo">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const mounted = useRef(true);

  const merge = useCallback((incoming: FeedEntry[]) => {
    setItems((prev) => {
      const byId = new Map<string, FeedEntry>();
      for (const e of [...incoming, ...prev]) byId.set(e.id, e);
      return [...byId.values()].sort((a, b) => b.ts - a.ts);
    });
  }, []);

  // Initial load + poll for new items.
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const res = await fetch(`/api/feed?limit=${PAGE_SIZE}`, { cache: "no-store" });
        const data: FeedResponse = await res.json();
        if (!mounted.current) return;
        if (data.configured === false) {
          setItems(demoItems());
          setStatus("demo");
          return;
        }
        const next = data.items ?? [];
        merge(next);
        setCursor(data.nextCursor ?? null);
        setStatus("ready");
      } catch {
        if (!mounted.current) return;
        setStatus((s) => (s === "loading" ? "error" : s));
      }
    };

    void load();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);

    return () => {
      mounted.current = false;
      if (timer) clearInterval(timer);
    };
  }, [merge]);

  const loadMore = async () => {
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/feed?limit=${PAGE_SIZE}&before=${cursor}`, { cache: "no-store" });
      const data: FeedResponse = await res.json();
      merge(data.items ?? []);
      setCursor(data.nextCursor ?? null);
    } catch {
      /* leave existing items in place */
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  };

  const visible = items.filter((e) => FILTERS.find((f) => f.key === filter)!.match(e.type));

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-subtle px-4 py-3">
        <SocialFeedIcon className="h-4 w-4 text-violet-400" />
        <h2 className="text-sm font-semibold text-text-primary">Social Feed</h2>
        <div className="ml-auto flex items-center gap-1">
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="hidden rounded-lg p-1.5 text-text-secondary/70 transition-colors hover:bg-elevated hover:text-text-primary lg:block"
              aria-label="Collapse feed"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-text-secondary/70 transition-colors hover:bg-elevated hover:text-text-primary lg:hidden"
              aria-label="Close feed"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-subtle px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              filter === f.key
                ? "bg-violet-500 text-on-brand"
                : "bg-elevated text-text-secondary hover:text-text-primary"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === "loading" && (
          <p className="px-4 py-8 text-center text-sm text-text-secondary/70">Loading feed…</p>
        )}
        {status === "error" && (
          <p className="px-4 py-8 text-center text-sm text-text-secondary/70">
            Couldn&apos;t load the feed. Retrying…
          </p>
        )}
        {(status === "ready" || status === "demo") && visible.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-text-secondary/70">
            No trades yet. New activity shows up here live.
          </p>
        )}

        {visible.length > 0 && (
          <ul>
            {visible.map((e) => (
              <FeedCard key={e.id} entry={e} />
            ))}
          </ul>
        )}

        {status === "ready" && cursor != null && visible.length > 0 && (
          <div className="px-4 py-3">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full rounded-xl bg-elevated py-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {status === "demo" && (
        <p className="border-t border-subtle px-4 py-2 text-center text-[11px] text-text-secondary/60">
          Preview data · connect a database to show live trades
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TradeFeed — self-contained dock: desktop right rail (collapsible) + a mobile
// right-edge pull-tab that opens a slide-over drawer. Owns its own collapse /
// drawer state (collapse preference persisted), so any page can drop in a
// single <TradeFeed /> with no props.
// ---------------------------------------------------------------------------

const FEED_COLLAPSED_KEY = "solens_feed_collapsed";

export default function TradeFeed() {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Keep the drawer's FeedBody mounted through the slide-out so the exit
  // animation can play; unmount ~300ms after close so it stops polling.
  const [drawerRender, setDrawerRender] = useState(false);

  // Restore the desktop rail's collapsed preference after mount. Reading
  // localStorage in a useState initializer would run during SSR (no window)
  // and risk a hydration mismatch, so this one-time sync belongs in an effect.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe read of a client-only persisted preference
      if (window.localStorage.getItem(FEED_COLLAPSED_KEY) === "1") setCollapsed(true);
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(FEED_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* no-op */
      }
      return next;
    });
  };

  const openDrawer = () => {
    setDrawerRender(true); // mount before the open transition
    setDrawerOpen(true);
  };

  // Keep the drawer body mounted briefly after close so the slide-out
  // transition can finish, then unmount it (stops its polling).
  useEffect(() => {
    if (drawerOpen || !drawerRender) return;
    const t = setTimeout(() => setDrawerRender(false), 300);
    return () => clearTimeout(t);
  }, [drawerOpen, drawerRender]);

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <>
      {/* Desktop rail — a single width-animating container that cross-fades
          between the full feed and the collapsed strip. */}
      <aside
        className="relative hidden flex-shrink-0 overflow-hidden border-l border-subtle bg-surface transition-[width] duration-300 ease-in-out lg:block"
        style={{ width: collapsed ? 48 : 340 }}
      >
        {/* Full feed layer */}
        <div
          className={`absolute inset-0 w-[340px] transition-opacity duration-200 ${
            collapsed ? "pointer-events-none opacity-0" : "opacity-100 delay-150"
          }`}
        >
          <FeedBody onCollapse={toggleCollapsed} />
        </div>

        {/* Collapsed strip layer */}
        <div
          className={`absolute inset-0 flex w-12 flex-col items-center py-3 transition-opacity duration-200 ${
            collapsed ? "opacity-100 delay-150" : "pointer-events-none opacity-0"
          }`}
        >
          <button
            onClick={toggleCollapsed}
            className="flex flex-col items-center gap-3 rounded-lg p-1.5 text-text-secondary/70 transition-colors hover:bg-elevated hover:text-text-primary"
            aria-label="Expand social feed"
            title="Social Feed"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            <SocialFeedIcon className="h-5 w-5 text-violet-400" />
          </button>
        </div>
      </aside>

      {/* Mobile pull-tab — opens the drawer without touching page headers. */}
      {!drawerRender && (
        <button
          onClick={openDrawer}
          className="fixed right-0 top-1/2 z-40 flex -translate-y-1/2 flex-col items-center gap-1.5 rounded-l-xl border border-r-0 border-subtle bg-surface py-3 pl-2.5 pr-2 card-shadow lg:hidden"
          aria-label="Open social feed"
        >
          <SocialFeedIcon className="h-4 w-4 text-violet-400" />
          <span className="text-xs font-medium text-text-secondary [writing-mode:vertical-rl]">Feed</span>
        </button>
      )}

      {/* Mobile drawer — always mounted on mobile so the slide/fade can animate
          both directions; only interactive + polling while open. */}
      <div className={`fixed inset-0 z-50 lg:hidden ${drawerOpen ? "" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 bg-black/50 transition-opacity duration-300 ${
            drawerOpen ? "opacity-100" : "opacity-0"
          }`}
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
        <aside
          className={`absolute right-0 top-0 flex h-full w-[85%] max-w-sm flex-col bg-surface shadow-xl transition-transform duration-300 ease-out ${
            drawerOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          {drawerRender && <FeedBody onClose={() => setDrawerOpen(false)} />}
        </aside>
      </div>
    </>
  );
}
