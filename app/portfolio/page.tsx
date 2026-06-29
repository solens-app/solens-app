"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy, useToken } from "@privy-io/react-auth";
import AppShell from "../components/AppShell";
import type { Portfolio } from "@/app/lib/portfolio";
import type { ActivityEntry } from "@/app/lib/points";

const PRIVY_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

// ---------------------------------------------------------------------------
// Entry — resolve the live app wallet (Privy) or fall back to a disconnected
// view for local preview, mirroring the History page.
// ---------------------------------------------------------------------------

export default function PortfolioPage() {
  return PRIVY_ENABLED ? <PortfolioLive /> : <PortfolioView wallet={null} onRequireAuth={() => {}} />;
}

function PortfolioLive() {
  const { authenticated, login } = usePrivy();
  const { getAccessToken } = useToken();
  const [wallet, setWallet] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!authenticated) {
        if (!cancelled) setWallet(null);
        return;
      }
      try {
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch("/api/wallet/ensure", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!cancelled && res.ok && data.address) setWallet(data.address);
      } catch {
        /* leave wallet null; render the connect prompt */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  return <PortfolioView wallet={wallet} onRequireAuth={login} />;
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

function PortfolioView({
  wallet,
  onRequireAuth,
}: {
  wallet: string | null;
  onRequireAuth: () => void;
}) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [dust, setDust] = useState(false);

  const refresh = useCallback(async () => {
    if (!wallet) {
      setPortfolio(null);
      setActivity([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [pRes, aRes] = await Promise.all([
        fetch(`/api/portfolio?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" }),
        fetch(`/api/points/activity?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" }),
      ]);
      const pJson = await pRes.json();
      if (pRes.ok && pJson.portfolio) setPortfolio(pJson.portfolio as Portfolio);
      const aJson = await aRes.json();
      setActivity(Array.isArray(aJson.activity) ? aJson.activity : []);
    } catch {
      /* keep prior data */
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // SOL is shown as a dedicated row; SPL tokens come from the portfolio.
  const tokenRows = useMemo(() => {
    if (!portfolio) return [];
    const rows = portfolio.tokens;
    // "Dust" = priced under 1¢ or no price at all.
    return dust ? rows : rows.filter((t) => (t.usdValue ?? 0) >= 0.01);
  }, [portfolio, dust]);

  const totalLabel = portfolio
    ? portfolio.totalUsdValue !== null
      ? `$${portfolio.totalUsdValue.toFixed(2)}`
      : `$${portfolio.knownUsdValue.toFixed(2)} (partial)`
    : "—";

  return (
    <AppShell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Portfolio</h1>
          {portfolio && wallet && (
            <p className="mt-1 text-sm text-text-secondary">
              Total value <span className="font-semibold text-text-primary">{totalLabel}</span>
              {portfolio.pricesIncomplete && (
                <span className="text-text-secondary/60"> · some prices unavailable</span>
              )}
            </p>
          )}
        </div>
        {wallet && (
          <button
            onClick={refresh}
            className="rounded-xl border border-transparent bg-elevated px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-violet-300 hover:text-text-primary"
          >
            ↻ Refresh
          </button>
        )}
      </div>

      {/* Tokens */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">Tokens</h2>
        <div className="overflow-hidden rounded-2xl bg-surface card-shadow">
          <div className="grid grid-cols-[1fr_auto] gap-4 bg-elevated/40 px-4 py-3 text-xs uppercase tracking-wide text-text-secondary sm:px-6">
            <span>Token</span>
            <span className="text-right">Value (USD)</span>
          </div>

          {!wallet ? (
            <ConnectState onRequireAuth={onRequireAuth} />
          ) : loading && !portfolio ? (
            <SkeletonRows />
          ) : !portfolio || (portfolio.solBalance === 0 && portfolio.tokens.length === 0) ? (
            <EmptyState title="No tokens yet" subtitle="Fund this wallet to see your holdings here." />
          ) : (
            <>
              <TokenRow
                symbol="SOL"
                amountLabel={`${portfolio.solBalance.toFixed(4)} SOL`}
                usdValue={portfolio.solUsdValue}
              />
              {tokenRows.map((t) => (
                <TokenRow
                  key={t.mint}
                  symbol={t.symbol}
                  amountLabel={`${formatAmount(t.amount)} ${t.symbol}`}
                  usdValue={t.usdValue}
                />
              ))}
              {portfolio.tokens.length > 0 && tokenRows.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-text-secondary/70 sm:px-6">
                  Only dust holdings — enable “Dust Tokens” to show them.
                </div>
              )}
            </>
          )}
        </div>

        <div className="mt-4">
          <Toggle label="Show dust tokens (under $0.01)" on={dust} onClick={() => setDust(!dust)} />
        </div>
      </section>

      {/* Activity */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">Recent activity</h2>
        <div className="overflow-hidden rounded-2xl bg-surface card-shadow">
          {!wallet ? (
            <EmptyState title="Connect your wallet" subtitle="Your recent on-chain activity will appear here." />
          ) : !activity ? (
            <SkeletonRows />
          ) : activity.length === 0 ? (
            <EmptyState title="No activity yet" subtitle="Your swaps, transfers and more will show up here." />
          ) : (
            activity.slice(0, 6).map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between gap-3 border-t border-subtle px-4 py-4 first:border-t-0 sm:px-6"
              >
                <div className="min-w-0">
                  <div className="font-medium">{tx.label}</div>
                  <div className="text-xs text-text-secondary/60">{relativeTime(tx.ts)}</div>
                </div>
                {tx.signature ? (
                  <a
                    href={`https://solscan.io/tx/${tx.signature}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success transition-colors hover:bg-success/20"
                  >
                    View
                  </a>
                ) : (
                  <span className="shrink-0 text-xs text-text-secondary/60">—</span>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Positions / orders — integrations not yet wired; honest empty states */}
      <section className="grid gap-6 sm:grid-cols-2">
        <PlaceholderCard
          title="Liquidity positions"
          subtitle="Meteora DLMM positions you open will appear here."
        />
        <PlaceholderCard
          title="Prediction positions"
          subtitle="Open prediction-market positions will appear here."
        />
        <PlaceholderCard
          title="Perp positions"
          subtitle="Drift perps integration coming soon."
        />
        <PlaceholderCard
          title="Limit orders"
          subtitle="Open limit orders will appear here."
        />
      </section>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Rows & states
// ---------------------------------------------------------------------------

function TokenRow({
  symbol,
  amountLabel,
  usdValue,
}: {
  symbol: string;
  amountLabel: string;
  usdValue: number | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-subtle px-4 py-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <TokenBadge symbol={symbol} />
        <div className="min-w-0">
          <div className="truncate font-medium">{symbol}</div>
          <div className="truncate text-xs text-text-secondary/60">{amountLabel}</div>
        </div>
      </div>
      <span className="shrink-0 text-right font-medium">
        {usdValue === null ? <span className="text-text-secondary/60">—</span> : `$${usdValue.toFixed(2)}`}
      </span>
    </div>
  );
}

function TokenBadge({ symbol }: { symbol: string }) {
  // Deterministic violet-tinted gradient seeded by the symbol so each token has
  // a stable colour without needing a logo fetch.
  const hue = [...symbol].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-bold text-on-brand"
      style={{
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 45%))`,
      }}
    >
      {symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "?"}
    </span>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center justify-between gap-3 border-t border-subtle px-4 py-4 first:border-t-0 sm:px-6">
          <span className="flex items-center gap-3">
            <span className="h-9 w-9 animate-pulse rounded-full bg-elevated" />
            <span className="h-4 w-24 animate-pulse rounded bg-elevated" />
          </span>
          <span className="h-4 w-16 animate-pulse rounded bg-elevated" />
        </div>
      ))}
    </>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-elevated">
        <svg className="h-5 w-5 text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M3 12h18M3 17h18" />
        </svg>
      </span>
      <p className="font-semibold">{title}</p>
      {subtitle && <p className="text-sm text-text-secondary/70">{subtitle}</p>}
    </div>
  );
}

function ConnectState({ onRequireAuth }: { onRequireAuth: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="font-semibold">Connect your wallet</p>
      <p className="text-sm text-text-secondary/70">Connect to see your live holdings and value.</p>
      {PRIVY_ENABLED && (
        <button
          onClick={onRequireAuth}
          className="mt-1 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-on-brand transition-colors hover:bg-violet-500"
        >
          Connect Wallet
        </button>
      )}
    </div>
  );
}

function PlaceholderCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="rounded-2xl bg-surface card-shadow">
      <div className="border-b border-subtle px-5 py-3 text-sm font-semibold">{title}</div>
      <div className="px-5 py-8 text-center text-sm text-text-secondary/70">{subtitle}</div>
    </div>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onClick}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-success" : "bg-elevated"}`}
        aria-pressed={on}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-5" : ""}`}
        />
      </button>
      {label && <span className="text-sm text-text-secondary">{label}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAmount(n: number): string {
  if (n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
