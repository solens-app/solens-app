"use client";

import AppShell from "../components/AppShell";

export default function TradingArenaPage() {
  return (
    <AppShell>
      <div className="grid min-h-[60vh] place-items-center text-center">
        <div className="max-w-sm">
          <span className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-violet-400 to-violet-600 shadow-lg shadow-violet-500/20">
            <svg className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 2 4.5 12.5h6L9 22l9.5-11.5h-6L13 2Z" />
            </svg>
          </span>
          <h1 className="text-3xl font-bold">Trading Arena</h1>
          <p className="mt-3 text-text-secondary">
            Compete in live trading challenges, climb the leaderboard, and earn rewards.
          </p>
          <span className="mt-6 inline-block rounded-full border border-subtle bg-surface px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-violet-300">
            Coming soon
          </span>
        </div>
      </div>
    </AppShell>
  );
}
