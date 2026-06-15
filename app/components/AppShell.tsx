"use client";

import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import Sidebar from "./Sidebar";

const REFERRAL_CODE = "6KUGVZ";
const PRIVY_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

function truncateAddress(address?: string) {
  if (!address) return "Connect Wallet";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

// Calls usePrivy — only mounted when a Privy provider exists.
function PrivyWalletButton() {
  const { user, login, authenticated } = usePrivy();
  const walletAddress = user?.wallet?.address;
  return (
    <button
      onClick={() => !authenticated && login()}
      className="flex items-center gap-2 rounded-xl bg-white text-black px-4 py-2.5 text-sm font-medium hover:bg-zinc-200 transition-colors"
    >
      {truncateAddress(walletAddress)}
      <WalletIcon />
    </button>
  );
}

// Static fallback used when Privy is not configured (local UI preview).
function DemoWalletButton() {
  return (
    <button className="flex items-center gap-2 rounded-xl bg-white text-black px-4 py-2.5 text-sm font-medium hover:bg-zinc-200 transition-colors">
      7Np4…9aR2
      <WalletIcon />
    </button>
  );
}

function WalletIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M3 10v8a2 2 0 002 2h14a2 2 0 002-2v-8M3 10l2-5h14l2 5M16 14h.01" />
    </svg>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [showBanner, setShowBanner] = useState(true);

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-white">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        {showBanner && (
          <div className="relative flex items-center justify-center px-4 py-2.5 text-sm bg-[#141414] border-b border-white/10">
            <span className="flex items-center gap-2 text-zinc-300">
              <span className="text-[#14F195]">📈</span>
              Level up your game with Solens and unlock new adventures!{" "}
              <a href="#" className="underline underline-offset-2 hover:text-white">
                Check it out
              </a>
            </span>
            <button
              onClick={() => setShowBanner(false)}
              className="absolute right-4 text-zinc-500 hover:text-white"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        <header className="flex items-center justify-end gap-3 px-6 lg:px-10 py-4">
          <div className="hidden sm:flex items-center rounded-xl bg-[#161616] border border-white/10 px-4 py-2.5 text-sm">
            <span className="text-zinc-400">Refer &amp; Earn:&nbsp;</span>
            <span className="font-medium">{REFERRAL_CODE}</span>
          </div>
          {PRIVY_ENABLED ? <PrivyWalletButton /> : <DemoWalletButton />}
        </header>

        <main className="flex-1 overflow-y-auto px-6 lg:px-10 pb-16">
          <div className="max-w-5xl mx-auto w-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
