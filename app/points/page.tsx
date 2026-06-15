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

export default function PointsPage() {
  const [activeTop, setActiveTop] = useState(topTabs[0]);
  const [activeQuest, setActiveQuest] = useState(questTabs[0]);

  return (
    <AppShell>
      {/* top tabs */}
      <div className="flex items-center justify-between border-b border-white/10 mb-8">
        <div className="flex items-center gap-8">
          {topTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTop(tab)}
              className={`pb-3 text-sm transition-colors ${
                activeTop === tab
                  ? "text-white border-b-2 border-white -mb-px"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        <a href="#" className="pb-3 text-sm text-zinc-300 underline underline-offset-2 hover:text-white">
          Terms and Conditions
        </a>
      </div>

      {/* Level card */}
      <div className="rounded-3xl border border-white/10 bg-[#0e0e0e] p-8 mb-10">
        <div className="flex items-center justify-center gap-3 mb-8">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`grid place-items-center w-16 h-16 rounded-full text-2xl transition-all ${
                tier.active
                  ? "bg-gradient-to-br from-[#9945FF] to-[#7C3AED] shadow-lg shadow-purple-500/30"
                  : "bg-white/[0.04] grayscale opacity-40"
              }`}
              title={tier.name}
            >
              {tier.emoji}
            </div>
          ))}
        </div>

        <div className="text-center">
          <h2 className="text-2xl font-bold">EP3</h2>
          <p className="text-zinc-400 mt-1">Level 1 • Seeker</p>
          <p className="text-5xl font-extrabold mt-4 mb-6">0 EP</p>
          <div className="h-3 rounded-full bg-white/5 overflow-hidden">
            <div className="h-full w-0 bg-gradient-to-r from-[#9945FF] to-[#14F195]" />
          </div>
          <p className="text-left text-sm text-zinc-500 mt-2">Need to Earn 16,000 EP to Next level</p>
        </div>
      </div>

      {/* Invite & Earn */}
      <div className="rounded-2xl border border-white/10 bg-[#0e0e0e] p-6 mb-10">
        <div className="flex items-start gap-4 mb-5">
          <span className="grid place-items-center w-11 h-11 rounded-full bg-white/5">
            <svg className="w-5 h-5 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z" />
            </svg>
          </span>
          <div>
            <h3 className="text-lg font-semibold">Invite &amp; Earn</h3>
            <p className="text-sm text-zinc-500">500 EP per referral + 1000 EP bonus at 5</p>
          </div>
        </div>
        <p className="text-sm text-zinc-500 mb-2">Your referral code</p>
        <div className="flex items-center justify-between rounded-xl bg-[#161616] border border-white/10 px-4 py-3 mb-4">
          <span className="font-medium tracking-wide">6KUGVZ</span>
          <button className="text-zinc-400 hover:text-white" aria-label="Copy">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button className="rounded-xl bg-[#161616] border border-white/10 py-3 text-sm font-medium hover:bg-white/5 transition-colors">
            𝕏 Share on X
          </button>
          <button className="rounded-xl bg-[#161616] border border-white/10 py-3 text-sm font-medium hover:bg-white/5 transition-colors">
            ↗ Share it
          </button>
        </div>
      </div>

      {/* Quest tabs */}
      <div className="flex items-center gap-7 border-b border-white/10 mb-6 overflow-x-auto">
        {questTabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveQuest(tab)}
            className={`pb-3 text-sm whitespace-nowrap transition-colors ${
              activeQuest === tab
                ? "text-white border-b-2 border-white -mb-px"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab}
          </button>
        ))}
        <span className="text-zinc-500">···</span>
      </div>

      <h3 className="text-2xl font-bold mb-1">{activeQuest}</h3>
      <p className="text-sm text-zinc-500 mb-6">Refreshes Everyday 00:00 UTC</p>

      <div className="grid sm:grid-cols-2 gap-5">
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
    const bg =
      quest.highlight === "purple"
        ? "bg-gradient-to-br from-[#1a1024] to-[#0e0e0e]"
        : quest.highlight === "green"
          ? "bg-gradient-to-br from-[#0d1a14] to-[#0e0e0e]"
          : "bg-[#0e0e0e]";
    const badge =
      quest.highlight === "purple"
        ? "bg-[#9945FF]/15 text-[#c4a3ff]"
        : quest.highlight === "green"
          ? "bg-[#14F195]/15 text-[#7ef0c0]"
          : "bg-white/10 text-zinc-200";
    return (
      <div className={`rounded-2xl border border-white/10 ${bg} p-5 flex flex-col items-center text-center`}>
        <div className="w-full flex items-center justify-between mb-8">
          <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${badge}`}>{quest.category}</span>
          <span className="text-sm font-bold px-3 py-1 rounded-full bg-black/40 border border-white/10">{quest.ep}</span>
        </div>
        <span className="grid place-items-center w-16 h-16 rounded-full bg-white text-2xl mb-4">
          {quest.highlight === "purple" ? "↗" : quest.highlight === "green" ? "◎" : "🏆"}
        </span>
        <h4 className="font-semibold">{quest.title}</h4>
        <p className="text-sm text-zinc-500 mt-1">{quest.desc}</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0e0e0e] p-5">
      <div className="flex items-center justify-between mb-6">
        <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-[#9945FF]/15 text-[#c4a3ff]">
          ↗ {quest.category}
        </span>
        <span className="text-sm font-bold px-3 py-1 rounded-full bg-black/40 border border-white/10">{quest.ep}</span>
      </div>
      <h4 className="font-semibold">{quest.title}</h4>
      <p className="text-sm text-zinc-500 mt-1 mb-6">{quest.desc}</p>
      <div className="h-1 rounded-full bg-white/5 mb-3" />
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>{quest.resets}</span>
        <span>{quest.progress}</span>
      </div>
    </div>
  );
}
