"use client";

import AppShell from "../components/AppShell";

export default function TradingArenaPage() {
  return (
    <AppShell>
      <div className="grid place-items-center min-h-[60vh] text-center">
        <div>
          <span className="grid place-items-center w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-[#9945FF] to-[#14F195] text-2xl mb-5">
            ⚔️
          </span>
          <h1 className="text-3xl font-bold">Trading Arena</h1>
          <p className="text-zinc-500 mt-2">Coming soon.</p>
        </div>
      </div>
    </AppShell>
  );
}
