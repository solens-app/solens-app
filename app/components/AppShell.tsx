"use client";

import { useState } from "react";
import Sidebar from "./Sidebar";
import { useAppWallet } from "./useAppWallet";

const PRIVY_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

function truncateAddress(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function ReferralChip({ code }: { code: string }) {
  return (
    <div className="hidden items-center rounded-xl bg-surface card-shadow px-4 py-2.5 text-sm sm:flex">
      <span className="text-text-secondary">Refer &amp; Earn:&nbsp;</span>
      <span className="font-medium tracking-wide text-violet-300">{code}</span>
    </div>
  );
}

// Calls usePrivy (via useAppWallet) — only mounted when Privy is configured.
// Shows the app-managed wallet + the user's real referral code, so the header
// matches the wallet that actually transacts and earns EP.
function HeaderControls() {
  const { authenticated, walletAddress, referralCode, login } = useAppWallet();
  return (
    <>
      {referralCode && <ReferralChip code={referralCode} />}
      <button
        onClick={() => !authenticated && login()}
        className="flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-violet-600 transition-colors hover:bg-violet-50"
      >
        {authenticated && walletAddress ? truncateAddress(walletAddress) : "Login"}
        <WalletIcon />
      </button>
    </>
  );
}

// Static fallback used when Privy is not configured (local UI preview).
function DemoHeaderControls() {
  return (
    <button className="flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-violet-600 transition-colors hover:bg-violet-50">
      Login
      <WalletIcon />
    </button>
  );
}

function WalletIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M3 10v8a2 2 0 002 2h14a2 2 0 002-2v-8M3 10l2-5h14l2 5M16 14h.01" />
    </svg>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [showBanner, setShowBanner] = useState(true);

  return (
    <div className="flex h-screen bg-base text-text-primary">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        {showBanner && (
          <div className="relative flex items-center justify-center bg-surface py-2.5 pl-16 pr-10 text-sm md:px-4">
            <span className="flex items-center gap-2 text-text-secondary">
              <span className="text-violet-300">✦</span>
              Level up your game with Solens and unlock new adventures!{" "}
              <a href="#" className="text-violet-300 underline underline-offset-2 transition-colors hover:text-violet-200">
                Check it out
              </a>
            </span>
            <button
              onClick={() => setShowBanner(false)}
              className="absolute right-4 text-text-secondary/60 transition-colors hover:text-text-primary"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        <header className="flex items-center justify-end gap-3 px-6 py-4 lg:px-10">
          {PRIVY_ENABLED ? <HeaderControls /> : <DemoHeaderControls />}
        </header>

        <main className="flex-1 overflow-y-auto px-6 pb-16 lg:px-10">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
