"use client";

import AppShell from "../components/AppShell";

export default function HistoryPage() {
  return (
    <AppShell>
      <h1 className="mb-8 text-3xl font-bold">History</h1>
      <div className="overflow-hidden rounded-2xl border border-subtle bg-surface">
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-4 border-b border-subtle bg-elevated/40 px-6 py-3 text-xs uppercase tracking-wide text-text-secondary">
          <span>Type</span>
          <span>Details</span>
          <span className="text-right">Status</span>
        </div>
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-elevated">
            <svg className="h-5 w-5 text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </span>
          <p className="font-semibold">No history yet</p>
          <p className="text-sm text-text-secondary/70">Your transactions on Solens will show up here.</p>
        </div>
      </div>
    </AppShell>
  );
}
