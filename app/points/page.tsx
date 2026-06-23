"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useToken } from "@privy-io/react-auth";
import AppShell from "../components/AppShell";
import { captureRefFromUrl, attributePendingRef } from "@/app/lib/points-client";
import type {
  PointsState,
  QuestView,
  QuestGroup,
  LeaderRow,
} from "@/app/lib/points";

const PRIVY_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

const TOP_TABS = ["Quests", "Leaderboard", "Points History"] as const;
type TopTab = (typeof TOP_TABS)[number];

const QUEST_TABS: QuestGroup[] = [
  "Daily Quests",
  "Weekly Quests",
  "Starter Quests",
  "Referrer Quests",
  "Protocol Explorer Quests",
];

const GROUP_SUBTITLE: Record<QuestGroup, string> = {
  "Daily Quests": "Refreshes everyday 00:00 UTC",
  "Weekly Quests": "Refreshes every Monday 00:00 UTC",
  "Starter Quests": "One-time quests to get you going",
  "Referrer Quests": "Earn EP for every friend you bring",
  "Protocol Explorer Quests": "Discover everything Solens can do",
};

// ---------------------------------------------------------------------------
// Entry point — mirror AppShell's Privy guard so the page renders without a
// configured Privy app (local preview) and with it (live wallet).
// ---------------------------------------------------------------------------

export default function PointsPage() {
  return PRIVY_ENABLED ? <PointsLive /> : <PointsDemo />;
}

function PointsLive() {
  const { authenticated, login } = usePrivy();
  const { getAccessToken } = useToken();
  const [wallet, setWallet] = useState<string | null>(null);

  useEffect(() => {
    captureRefFromUrl();
  }, []);

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
        if (!cancelled && res.ok && data.address) {
          setWallet(data.address);
          attributePendingRef(data.address);
        }
      } catch {
        /* leave wallet null; the page still renders the catalog */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  return <PointsView wallet={wallet} onRequireAuth={login} />;
}

// Privy not configured (no auth available) — render the anonymous catalog.
function PointsDemo() {
  return <PointsView wallet={null} onRequireAuth={() => {}} />;
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

function PointsView({
  wallet,
  onRequireAuth,
}: {
  wallet: string | null;
  onRequireAuth: () => void;
}) {
  const [data, setData] = useState<PointsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [activeTop, setActiveTop] = useState<TopTab>("Quests");
  const [activeQuest, setActiveQuest] = useState<QuestGroup>("Daily Quests");

  const refresh = useCallback(async () => {
    try {
      const qs = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
      const res = await fetch(`/api/points${qs}`, { cache: "no-store" });
      const json = (await res.json()) as PointsState;
      setData(json);
    } catch {
      /* keep prior data */
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  const claim = useCallback(
    async (questId: string) => {
      if (!wallet) {
        onRequireAuth();
        return;
      }
      setClaimingId(questId);
      try {
        const res = await fetch("/api/points/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet, questId }),
        });
        const json = await res.json();
        if (json?.state) setData(json.state as PointsState);
      } catch {
        /* ignore; user can retry */
      } finally {
        setClaimingId(null);
      }
    },
    [wallet, onRequireAuth],
  );

  return (
    <AppShell>
      {/* top tabs */}
      <div className="mb-8 flex items-center justify-between border-b border-subtle">
        <div className="flex items-center gap-8">
          {TOP_TABS.map((tab) => (
            <button key={tab} onClick={() => setActiveTop(tab)} className={tabClass(activeTop === tab)}>
              {tab}
            </button>
          ))}
        </div>
        <a href="#" className="pb-3 text-sm text-violet-300 underline underline-offset-2 hover:text-violet-200">
          Terms and Conditions
        </a>
      </div>

      {/* Level card — always visible */}
      <LevelCard data={data} loading={loading} />

      {activeTop === "Quests" && (
        <>
          <InviteCard data={data} />

          {/* Quest tabs */}
          <div className="mb-6 flex items-center gap-7 overflow-x-auto border-b border-subtle">
            {QUEST_TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveQuest(tab)}
                className={`${tabClass(activeQuest === tab)} whitespace-nowrap`}
              >
                {tab}
              </button>
            ))}
          </div>

          <h3 className="mb-1 text-2xl font-bold">{activeQuest}</h3>
          <p className="mb-6 text-sm text-text-secondary/70">{GROUP_SUBTITLE[activeQuest]}</p>

          {loading && !data ? (
            <QuestSkeleton />
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              {(data?.quests ?? [])
                .filter((q) => q.group === activeQuest)
                .map((q) => (
                  <QuestCard
                    key={q.id}
                    quest={q}
                    claiming={claimingId === q.id}
                    onClaim={() => claim(q.id)}
                  />
                ))}
            </div>
          )}
        </>
      )}

      {activeTop === "Leaderboard" && <Leaderboard rows={data?.leaderboard ?? []} loading={loading && !data} />}

      {activeTop === "Points History" && <History entries={data?.history ?? []} loading={loading && !data} />}
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Level card
// ---------------------------------------------------------------------------

function LevelCard({ data, loading }: { data: PointsState | null; loading: boolean }) {
  const level = data?.level;
  const tiers = data?.tiers ?? [];
  return (
    <div className="mb-10 rounded-3xl bg-surface card-shadow p-8">
      <div className="mb-8 flex items-center justify-center gap-3">
        {(tiers.length ? tiers : Array.from({ length: 7 }, () => null)).map((tier, i) => (
          <div
            key={tier?.name ?? i}
            className={`grid h-16 w-16 place-items-center rounded-full text-2xl transition-all ${
              tier?.active
                ? "bg-gradient-to-br from-violet-400 to-violet-600 shadow-lg shadow-violet-500/30"
                : tier?.unlocked
                  ? "bg-gradient-to-br from-violet-400/70 to-violet-600/70"
                  : "bg-elevated opacity-40 grayscale"
            }`}
            title={tier?.name}
          >
            {tier?.emoji ?? "•"}
          </div>
        ))}
      </div>

      <div className="text-center">
        <h2 className="text-2xl font-bold">EP3</h2>
        <p className="mt-1 text-text-secondary">
          {level ? `Level ${level.number} • ${level.name}` : "—"}
        </p>
        <p className="mb-6 mt-4 text-5xl font-extrabold text-gradient-brand">
          {loading && !data ? "…" : `${(data?.ep ?? 0).toLocaleString()} EP`}
        </p>
        <div className="h-3 overflow-hidden rounded-full bg-elevated">
          <div
            className="h-full bg-gradient-to-r from-violet-400 to-violet-600 transition-all duration-500"
            style={{ width: `${level?.percent ?? 0}%` }}
          />
        </div>
        <p className="mt-2 text-left text-sm text-text-secondary/70">
          {level && level.nextAt !== null
            ? `Need to earn ${level.toNext.toLocaleString()} EP to reach the next level`
            : level
              ? "You've reached the highest tier — Sovereign 👑"
              : ""}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invite & Earn
// ---------------------------------------------------------------------------

function InviteCard({ data }: { data: PointsState | null }) {
  const [copied, setCopied] = useState(false);
  const code = data?.referralCode ?? "······";
  const referrals = data?.referrals ?? 0;

  const referralLink =
    typeof window !== "undefined"
      ? `${window.location.origin}/?ref=${code}`
      : `https://solens.app/?ref=${code}`;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };

  const shareOnX = () => {
    const text = encodeURIComponent(
      `Trading on Solens — the AI-powered Solana assistant. Use my code ${code} to get started:`,
    );
    const url = encodeURIComponent(referralLink);
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const shareIt = async () => {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "Solens", text: `Use my code ${code} on Solens`, url: referralLink });
        return;
      } catch {
        /* user dismissed; fall through to copy */
      }
    }
    copy(referralLink);
  };

  return (
    <div className="mb-10 rounded-2xl bg-surface card-shadow p-6">
      <div className="mb-5 flex items-start gap-4">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-elevated text-violet-300">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z" />
          </svg>
        </span>
        <div className="flex-1">
          <h3 className="text-lg font-semibold">Invite &amp; Earn</h3>
          <p className="text-sm text-text-secondary/70">500 EP per referral + 1000 EP bonus at 5</p>
        </div>
        <span className="rounded-full bg-elevated px-3 py-1 text-sm font-medium text-violet-200">
          {referrals} referred
        </span>
      </div>
      <p className="mb-2 text-sm text-text-secondary/70">Your referral code</p>
      <div className="mb-4 flex items-center justify-between rounded-xl border border-transparent bg-elevated px-4 py-3">
        <span className="font-medium tracking-wide text-violet-200">{code}</span>
        <button
          onClick={() => copy(code)}
          className="flex items-center gap-1.5 text-text-secondary transition-colors hover:text-white"
          aria-label="Copy referral code"
        >
          {copied && <span className="text-xs text-success">Copied!</span>}
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={shareOnX}
          className="rounded-xl border border-transparent bg-elevated py-3 text-sm font-medium transition-colors hover:border-violet-300 hover:text-white"
        >
          𝕏 Share on X
        </button>
        <button
          onClick={shareIt}
          className="rounded-xl border border-transparent bg-elevated py-3 text-sm font-medium transition-colors hover:border-violet-300 hover:text-white"
        >
          ↗ Share it
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quest card
// ---------------------------------------------------------------------------

function QuestCard({
  quest,
  claiming,
  onClaim,
}: {
  quest: QuestView;
  claiming: boolean;
  onClaim: () => void;
}) {
  const target = quest.target ?? 0;
  const pct = quest.showBar && target > 0 ? Math.min(100, Math.round((quest.progress / target) * 100)) : 0;

  const accentBadge =
    quest.highlight === "green"
      ? "bg-success/15 text-success"
      : "bg-violet-500/15 text-violet-200";

  return (
    <div className="flex flex-col rounded-2xl bg-surface card-shadow card-shadow-hover p-5">
      <div className="mb-4 flex items-center justify-between">
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${accentBadge}`}>
          {quest.category}
        </span>
        <span className="rounded-full border border-transparent bg-elevated px-3 py-1 text-sm font-bold">
          {quest.ep.toLocaleString()} EP
        </span>
      </div>

      <h4 className="font-semibold">{quest.title}</h4>
      <p className="mt-1 text-sm text-text-secondary/70">{quest.desc}</p>

      {quest.showBar && (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-400 to-violet-600 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-2 text-right text-xs text-text-secondary/60">{quest.progressLabel}</p>
        </div>
      )}

      <div className="mt-5 flex items-center justify-between">
        {quest.completed ? (
          <span className="flex items-center gap-1.5 text-sm font-medium text-success">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Claimed · +{quest.ep.toLocaleString()} EP
          </span>
        ) : quest.claimable ? (
          <button
            onClick={onClaim}
            disabled={claiming}
            className="ml-auto rounded-xl bg-violet-500 px-5 py-2 text-sm font-semibold text-on-brand transition-colors hover:bg-violet-400 disabled:opacity-60"
          >
            {claiming ? "Claiming…" : "Claim"}
          </button>
        ) : (
          <span className="ml-auto rounded-xl border border-subtle px-4 py-2 text-sm text-text-secondary/60">
            In progress
          </span>
        )}
      </div>
    </div>
  );
}

function QuestSkeleton() {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-2xl bg-surface card-shadow p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="h-6 w-16 animate-pulse rounded-full bg-elevated" />
            <span className="h-6 w-16 animate-pulse rounded-full bg-elevated" />
          </div>
          <span className="mb-2 block h-4 w-32 animate-pulse rounded bg-elevated" />
          <span className="block h-3 w-48 animate-pulse rounded bg-elevated" />
          <span className="mt-6 ml-auto block h-9 w-24 animate-pulse rounded-xl bg-elevated" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

const MEDAL = ["🥇", "🥈", "🥉"];

function Leaderboard({ rows, loading }: { rows: LeaderRow[]; loading: boolean }) {
  return (
    <div className="overflow-hidden rounded-2xl bg-surface card-shadow">
      <div className="grid grid-cols-[auto_1fr_auto] gap-6 bg-elevated/40 px-6 py-3 text-xs uppercase tracking-wide text-text-secondary">
        <span className="w-10">Rank</span>
        <span>Trader</span>
        <span className="text-right">EP</span>
      </div>
      {loading ? (
        [0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-t border-subtle px-6 py-4">
            <span className="h-4 w-6 animate-pulse rounded bg-elevated" />
            <span className="h-4 w-40 animate-pulse rounded bg-elevated" />
            <span className="ml-auto h-4 w-16 animate-pulse rounded bg-elevated" />
          </div>
        ))
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-elevated text-violet-300">🏆</span>
          <p className="font-semibold">No ranked traders yet</p>
          <p className="text-sm text-text-secondary/70">Complete a quest to claim EP and land on the board.</p>
        </div>
      ) : (
        rows.map((r) => (
          <div
            key={`${r.rank}-${r.wallet}`}
            className={`grid grid-cols-[auto_1fr_auto] items-center gap-6 border-t border-subtle px-6 py-4 ${
              r.isYou ? "bg-violet-500/10" : ""
            }`}
          >
            <span className="w-10 text-lg font-semibold">{MEDAL[r.rank - 1] ?? r.rank}</span>
            <span className="flex items-center gap-2 font-medium">
              {r.short}
              {r.isYou && (
                <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-[11px] font-semibold text-violet-200">
                  You
                </span>
              )}
            </span>
            <span className="text-right font-semibold text-violet-200">{r.ep.toLocaleString()} EP</span>
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Points History
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

function History({ entries, loading }: { entries: { id: string; ts: number; label: string; ep: number }[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="overflow-hidden rounded-2xl bg-surface card-shadow">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between border-t border-subtle px-6 py-4 first:border-t-0">
            <span className="h-4 w-40 animate-pulse rounded bg-elevated" />
            <span className="h-4 w-16 animate-pulse rounded bg-elevated" />
          </div>
        ))}
      </div>
    );
  }

  if (!entries.length) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl bg-surface card-shadow px-6 py-16 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-elevated">
          <svg className="h-5 w-5 text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </span>
        <p className="font-semibold">No points yet</p>
        <p className="text-sm text-text-secondary/70">Complete a quest to start earning EP.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl bg-surface card-shadow">
      {entries.map((e) => (
        <div key={e.id} className="flex items-center justify-between border-t border-subtle px-6 py-4 first:border-t-0">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-elevated text-violet-300">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </span>
            <div>
              <div className="font-medium">{e.label}</div>
              <div className="text-xs text-text-secondary/60">{relativeTime(e.ts)}</div>
            </div>
          </div>
          <span className="font-semibold text-success">+{e.ep.toLocaleString()} EP</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function tabClass(active: boolean) {
  return `pb-3 text-sm transition-colors ${
    active ? "-mb-px border-b-2 border-violet-400 text-white" : "text-text-secondary/60 hover:text-text-secondary"
  }`;
}
