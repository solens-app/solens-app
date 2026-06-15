"use client";

import { useState } from "react";
import AppShell from "../components/AppShell";

const topTabs = ["Quests", "Leaderboard", "Points History"];

const tiers = [
  { name: "Seeker", emoji: "🧭", active: true },
  { name: "Pathfinder", emoji: "✦", active: false },
  { name: "Alchemist", emoji: "⚗️", active: false },
  { name: "Sentinel", emoji: "🛡️", active: false },
  { name: "Arcanist", emoji: "🔮", active: false },
  { name: "Luminary", emoji: "🔱", active: false },
  { name: "Sovereign", emoji: "👑", active: false },
];

const questTabs = [
  "Daily Quests",
  "Weekly Quests",
  "Starter Quests",
  "Referrer Quests",
  "Protocol Explorer Quests",
];

type Quest = {
  category: string;
  ep: string;
  title: string;
  desc: string;
  resets?: string;
  progress?: string;
  highlight?: "purple" | "green" | "plain";
};

const quests: Quest[] = [
  { category: "SWAP", ep: "250 EP", title: "Swap It Up", desc: "Do a swap worth $10+ on Solana", highlight: "purple" },
  { category: "STAKE", ep: "600 EP", title: "Stake SOL", desc: "Stake $10+ of SOL using Solens", highlight: "green" },
  { category: "VOLUME", ep: "300 EP", title: "Mini Mover", desc: "Transact a total of $50 today", resets: "Resets in 10 hours", progress: "$0 / $50" },
  { category: "VOLUME", ep: "500 EP", title: "Daily Surge", desc: "Transact a total of $100 today", resets: "Resets in 10 hours", progress: "$0 / $100" },
  { category: "VOLUME", ep: "1000 EP", title: "Volume Sprinter", desc: "Transact a total of $500 today", resets: "Resets in 10 hours", progress: "$0 / $500" },
  { category: "VOLUME", ep: "2000 EP", title: "Quick Whale", desc: "Transact a total of $1000 today", resets: "Resets in 10 hours", progress: "$0 / $1,000" },
  { category: "VOLUME", ep: "500 EP", title: "Quick Win", desc: "Complete any 2 quests today", highlight: "plain" },
];

const tabClass = (active: boolean) =>
  `pb-3 text-sm transition-colors ${
    active ? "-mb-px border-b-2 border-violet-400 text-white" : "text-text-secondary/60 hover:text-text-secondary"
  }`;

export default function PointsPage() {
  const [activeTop, setActiveTop] = useState(topTabs[0]);
  const [activeQuest, setActiveQuest] = useState(questTabs[0]);

  return (
    <AppShell>
      {/* top tabs */}
      <div className="mb-8 flex items-center justify-between border-b border-subtle">
        <div className="flex items-center gap-8">
          {topTabs.map((tab) => (
            <button key={tab} onClick={() => setActiveTop(tab)} className={tabClass(activeTop === tab)}>
              {tab}
            </button>
          ))}
        </div>
        <a href="#" className="pb-3 text-sm text-violet-300 underline underline-offset-2 hover:text-violet-200">
          Terms and Conditions
        </a>
      </div>

      {/* Level card */}
      <div className="mb-10 rounded-3xl bg-surface card-shadow p-8">
        <div className="mb-8 flex items-center justify-center gap-3">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`grid h-16 w-16 place-items-center rounded-full text-2xl transition-all ${
                tier.active
                  ? "bg-gradient-to-br from-violet-400 to-violet-600 shadow-lg shadow-violet-500/30"
                  : "bg-elevated opacity-40 grayscale"
              }`}
              title={tier.name}
            >
              {tier.emoji}
            </div>
          ))}
        </div>

        <div className="text-center">
          <h2 className="text-2xl font-bold">EP3</h2>
          <p className="mt-1 text-text-secondary">Level 1 • Seeker</p>
          <p className="mb-6 mt-4 text-5xl font-extrabold text-gradient-brand">0 EP</p>
          <div className="h-3 overflow-hidden rounded-full bg-elevated">
            <div className="h-full w-0 bg-gradient-to-r from-violet-400 to-violet-600" />
          </div>
          <p className="mt-2 text-left text-sm text-text-secondary/70">Need to earn 16,000 EP to reach the next level</p>
        </div>
      </div>

      {/* Invite & Earn */}
      <div className="mb-10 rounded-2xl bg-surface card-shadow p-6">
        <div className="mb-5 flex items-start gap-4">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-elevated text-violet-300">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z" />
            </svg>
          </span>
          <div>
            <h3 className="text-lg font-semibold">Invite &amp; Earn</h3>
            <p className="text-sm text-text-secondary/70">500 EP per referral + 1000 EP bonus at 5</p>
          </div>
        </div>
        <p className="mb-2 text-sm text-text-secondary/70">Your referral code</p>
        <div className="mb-4 flex items-center justify-between rounded-xl border border-transparent bg-elevated px-4 py-3">
          <span className="font-medium tracking-wide text-violet-200">6KUGVZ</span>
          <button className="text-text-secondary transition-colors hover:text-white" aria-label="Copy">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button className="rounded-xl border border-transparent bg-elevated py-3 text-sm font-medium transition-colors hover:border-violet-300 hover:text-white">
            𝕏 Share on X
          </button>
          <button className="rounded-xl border border-transparent bg-elevated py-3 text-sm font-medium transition-colors hover:border-violet-300 hover:text-white">
            ↗ Share it
          </button>
        </div>
      </div>

      {/* Quest tabs */}
      <div className="mb-6 flex items-center gap-7 overflow-x-auto border-b border-subtle">
        {questTabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveQuest(tab)}
            className={`${tabClass(activeQuest === tab)} whitespace-nowrap`}
          >
            {tab}
          </button>
        ))}
        <span className="text-text-secondary/60">···</span>
      </div>

      <h3 className="mb-1 text-2xl font-bold">{activeQuest}</h3>
      <p className="mb-6 text-sm text-text-secondary/70">Refreshes everyday 00:00 UTC</p>

      <div className="grid gap-5 sm:grid-cols-2">
        {quests.map((q) => (
          <QuestCard key={q.title} quest={q} />
        ))}
      </div>
    </AppShell>
  );
}

function QuestCard({ quest }: { quest: Quest }) {
  const featured = quest.highlight === "purple" || quest.highlight === "green" || quest.highlight === "plain";

  if (featured) {
    const accent =
      quest.highlight === "green"
        ? { ring: "from-success/80 to-success/40", badge: "bg-success/15 text-success" }
        : { ring: "from-violet-400 to-violet-600", badge: "bg-violet-500/15 text-violet-200" };
    return (
      <div className="flex flex-col items-center rounded-2xl bg-surface card-shadow card-shadow-hover p-5 text-center">
        <div className="mb-8 flex w-full items-center justify-between">
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${accent.badge}`}>{quest.category}</span>
          <span className="rounded-full border border-transparent bg-elevated px-3 py-1 text-sm font-bold">{quest.ep}</span>
        </div>
        <span className={`mb-4 grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br ${accent.ring}`}>
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </span>
        <h4 className="font-semibold">{quest.title}</h4>
        <p className="mt-1 text-sm text-text-secondary/70">{quest.desc}</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-surface card-shadow card-shadow-hover p-5">
      <div className="mb-6 flex items-center justify-between">
        <span className="rounded-full bg-violet-500/15 px-2.5 py-1 text-[11px] font-semibold text-violet-200">
          {quest.category}
        </span>
        <span className="rounded-full border border-transparent bg-elevated px-3 py-1 text-sm font-bold">{quest.ep}</span>
      </div>
      <h4 className="font-semibold">{quest.title}</h4>
      <p className="mb-6 mt-1 text-sm text-text-secondary/70">{quest.desc}</p>
      <div className="mb-3 h-1 rounded-full bg-elevated" />
      <div className="flex items-center justify-between text-xs text-text-secondary/60">
        <span>{quest.resets}</span>
        <span>{quest.progress}</span>
      </div>
    </div>
  );
}
