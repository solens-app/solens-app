"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useToken } from "@privy-io/react-auth";
import AppShell from "../components/AppShell";
import type { ActivityEntry } from "@/app/lib/points";

const PRIVY_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

// ---------------------------------------------------------------------------
// Entry point — mirror the Points page's Privy guard so the page renders both
// with a configured Privy app (live wallet) and without one (local preview).
// ---------------------------------------------------------------------------

export default function HistoryPage() {
  return PRIVY_ENABLED ? <HistoryLive /> : <HistoryDemo />;
}

function HistoryLive() {
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
        /* leave wallet null; the page renders the connect prompt */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  return <HistoryView wallet={wallet} onRequireAuth={login} />;
}

// Privy not configured (no auth available) — render the disconnected state.
function HistoryDemo() {
  return <HistoryView wallet={null} onRequireAuth={() => {}} />;
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

function HistoryView({
  wallet,
  onRequireAuth,
}: {
  wallet: string | null;
  onRequireAuth: () => void;
}) {
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!wallet) {
      setActivity([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/points/activity?wallet=${encodeURIComponent(wallet)}`, {
        cache: "no-store",
      });
      const json = await res.json();
      setActivity(Array.isArray(json.activity) ? json.activity : []);
    } catch {
      /* keep prior data */
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <AppShell>
      <h1 className="mb-8 text-3xl font-bold">History</h1>
      <div className="overflow-hidden rounded-2xl bg-surface card-shadow">
        <div className="grid grid-cols-[1.2fr_1.5fr_auto] gap-4 bg-elevated/40 px-6 py-3 text-xs uppercase tracking-wide text-text-secondary">
          <span>Type</span>
          <span>Details</span>
          <span className="text-right">Status</span>
        </div>

        {!wallet ? (
          <EmptyState
            title="Connect your wallet"
            subtitle="Connect your wallet to see your on-chain transactions."
            action={
              PRIVY_ENABLED ? (
                <button
                  onClick={onRequireAuth}
                  className="mt-1 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500"
                >
                  Connect Wallet
                </button>
              ) : null
            }
          />
        ) : loading ? (
          <SkeletonRows />
        ) : !activity || activity.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            subtitle="Your swaps, transfers, and more on Solens will show up here."
          />
        ) : (
          activity.map((tx) => <ActivityRow key={tx.id} tx={tx} />)
        )}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Rows & states
// ---------------------------------------------------------------------------

function ActivityRow({ tx }: { tx: ActivityEntry }) {
  return (
    <div className="grid grid-cols-[1.2fr_1.5fr_auto] items-center gap-4 border-t border-subtle px-6 py-4">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-elevated text-violet-300">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
          </svg>
        </span>
        <span className="font-medium">{tx.label}</span>
      </div>

      <div className="min-w-0">
        <div className="text-sm">{relativeTime(tx.ts)}</div>
        {tx.signature && (
          <div className="truncate font-mono text-xs text-text-secondary/60">{shortSig(tx.signature)}</div>
        )}
      </div>

      <div className="text-right">
        {tx.signature ? (
          <a
            href={`https://solscan.io/tx/${tx.signature}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success transition-colors hover:bg-success/20"
          >
            Confirmed
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5m0-5L10 14M5 7v12h12" />
            </svg>
          </a>
        ) : (
          <span className="inline-flex rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
            Confirmed
          </span>
        )}
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="grid grid-cols-[1.2fr_1.5fr_auto] items-center gap-4 border-t border-subtle px-6 py-4">
          <span className="flex items-center gap-3">
            <span className="h-9 w-9 animate-pulse rounded-full bg-elevated" />
            <span className="h-4 w-20 animate-pulse rounded bg-elevated" />
          </span>
          <span className="h-4 w-32 animate-pulse rounded bg-elevated" />
          <span className="ml-auto h-6 w-20 animate-pulse rounded-full bg-elevated" />
        </div>
      ))}
    </>
  );
}

function EmptyState({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-elevated">
        <svg className="h-5 w-5 text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </span>
      <p className="font-semibold">{title}</p>
      <p className="text-sm text-text-secondary/70">{subtitle}</p>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function shortSig(sig: string): string {
  return sig.length > 16 ? `${sig.slice(0, 8)}…${sig.slice(-8)}` : sig;
}
