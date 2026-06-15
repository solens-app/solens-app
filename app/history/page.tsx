"use client";

import AppShell from "../components/AppShell";

export default function HistoryPage() {
  return (
    <AppShell>
      <h1 className="text-3xl font-bold mb-8">History</h1>
      <div className="rounded-2xl border border-white/10 overflow-hidden">
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-4 px-6 py-3 bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
          <span>Type</span>
          <span>Details</span>
          <span className="text-right">Status</span>
        </div>
        <div className="py-12 text-center font-bold text-lg text-zinc-300">
          No History on Solens
        </div>
      </div>
    </AppShell>
  );
}
