"use client";

import { useState } from "react";
import AppShell from "../components/AppShell";

const tokens = [
  { symbol: "SOL", network: "Solana", balance: "2.451030 SOL", value: "$382.41", color: "from-[#9945FF] to-[#14F195]" },
  { symbol: "USDC", network: "Solana", balance: "120.975302 USDC", value: "$120.97", color: "from-[#2775CA] to-[#2775CA]" },
  { symbol: "JUP", network: "Solana", balance: "340.220000 JUP", value: "$210.94", color: "from-[#C7F284] to-[#22C55E]" },
  { symbol: "BONK", network: "Solana", balance: "1,204,331 BONK", value: "$31.08", color: "from-[#F7931A] to-[#FACC15]" },
];

const orderTabs = ["All (0)", "Open (0)", "Filled (0)", "Cancelled (0)", "Expired (0)"];

function TokenIcon({ symbol, color }: { symbol: string; color: string }) {
  return (
    <span
      className={`grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br ${color} text-[11px] font-bold text-black`}
    >
      {symbol.slice(0, 3)}
    </span>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-elevated">
        <svg className="h-5 w-5 text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M3 12h18M3 17h18" />
        </svg>
      </span>
      <p className="font-semibold">{title}</p>
      {subtitle && <p className="text-sm text-text-secondary/70">{subtitle}</p>}
    </div>
  );
}

export default function PortfolioPage() {
  const [dust, setDust] = useState(false);
  const [testnet, setTestnet] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [activeOrderTab, setActiveOrderTab] = useState(orderTabs[0]);

  return (
    <AppShell>
      <h1 className="mb-8 text-3xl font-bold">Portfolio</h1>

      {/* Tokens */}
      <section className="mb-12">
        <h2 className="mb-3 text-lg font-semibold">Tokens</h2>
        <div className="overflow-hidden rounded-2xl border border-subtle bg-surface">
          <div className="grid grid-cols-[1fr_auto_auto] gap-6 border-b border-subtle bg-elevated/40 px-6 py-3 text-xs uppercase tracking-wide text-text-secondary">
            <span>Tokens</span>
            <span className="w-40 text-right">Balance ⇅</span>
            <span className="w-28 text-right">Value (USD) ⇅</span>
          </div>
          {tokens.map((t) => (
            <div
              key={t.symbol}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-6 border-t border-subtle px-6 py-4"
            >
              <div className="flex items-center gap-3">
                <TokenIcon symbol={t.symbol} color={t.color} />
                <div>
                  <div className="font-medium">{t.symbol}</div>
                  <div className="text-xs text-text-secondary/60">{t.network}</div>
                </div>
              </div>
              <span className="w-40 text-right text-sm text-text-secondary">{t.balance}</span>
              <span className="w-28 text-right font-medium">{t.value}</span>
            </div>
          ))}
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-6 border-t border-subtle bg-elevated/40 px-6 py-4">
            <span className="text-text-secondary">Total</span>
            <span className="w-40" />
            <span className="w-28 text-right font-semibold text-violet-200">$745.40</span>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <Toggle label="Dust Tokens" on={dust} onClick={() => setDust(!dust)} />
          <Toggle label="Testnet Tokens" on={testnet} onClick={() => setTestnet(!testnet)} />
        </div>
      </section>

      {/* Positions */}
      <section className="mb-12">
        <h2 className="mb-4 text-2xl font-bold">Positions</h2>
        <div className="overflow-hidden rounded-2xl border border-subtle bg-surface">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 border-b border-subtle bg-elevated/40 px-6 py-3 text-xs uppercase tracking-wide text-text-secondary">
            <span>Token</span>
            <span>Amount</span>
            <span>Value (USD)</span>
            <span>APY</span>
            <span>Status</span>
          </div>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] items-center gap-4 border-t border-subtle px-6 py-5"
            >
              <div className="flex items-center gap-3">
                <span className="h-9 w-9 animate-pulse rounded-full bg-elevated" />
                <span className="h-3 w-32 animate-pulse rounded bg-elevated" />
              </div>
              <span className="h-3 w-16 animate-pulse rounded bg-elevated" />
              <span className="h-3 w-16 animate-pulse rounded bg-elevated" />
              <span className="h-3 w-12 animate-pulse rounded bg-elevated" />
              <span className="h-3 w-14 animate-pulse rounded bg-elevated" />
            </div>
          ))}
        </div>
      </section>

      {/* Perp Positions */}
      <section className="mb-12">
        <h2 className="mb-4 text-2xl font-bold">Drift Perp Positions</h2>
        <div className="overflow-hidden rounded-2xl border border-subtle bg-surface">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-4 border-b border-subtle bg-elevated/40 px-6 py-3 text-xs uppercase tracking-wide text-text-secondary">
            <span>Tokens</span>
            <span className="text-right">Entry</span>
            <span className="text-right">LTP</span>
            <span className="text-right">PNL (USD) ⇅</span>
          </div>
          <EmptyState title="No perp positions found" subtitle="Open a position on Drift to see it here." />
        </div>
      </section>

      {/* Prediction markets */}
      <section className="mb-12">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Prediction positions</h2>
          <div className="flex items-center gap-3 text-sm text-text-secondary">
            Display closed positions
            <Toggle label="" on={showClosed} onClick={() => setShowClosed(!showClosed)} />
          </div>
        </div>
        <div className="rounded-2xl border border-subtle bg-surface px-6 py-12 text-center">
          <p className="mb-5 text-text-secondary">
            Initialize prediction market credentials to view your positions and open orders.
          </p>
          <button className="rounded-xl bg-violet-500 px-5 py-2.5 text-sm font-semibold text-on-brand transition-colors hover:bg-violet-400">
            Initialize Prediction Markets
          </button>
        </div>
      </section>

      {/* Limit Orders */}
      <section className="mb-12">
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-2xl font-bold">Limit Orders</h2>
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wide text-text-secondary">Filter by Token</div>
            <button className="flex w-44 items-center justify-between gap-3 rounded-xl border border-subtle bg-elevated px-4 py-2.5 text-sm transition-colors hover:border-violet-300">
              SOL
              <svg className="h-4 w-4 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        <div className="mb-1 flex items-center gap-2 border-b border-subtle">
          {orderTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveOrderTab(tab)}
              className={`rounded-lg px-3 py-2 text-sm transition-colors ${
                activeOrderTab === tab
                  ? "bg-elevated text-white"
                  : "text-text-secondary/60 hover:text-text-secondary"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="overflow-hidden rounded-2xl border border-subtle bg-surface">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 border-b border-subtle bg-elevated/40 px-6 py-3 text-xs uppercase tracking-wide text-text-secondary">
            <span>Order</span>
            <span className="text-right">Price</span>
            <span className="text-right">Filled</span>
            <span className="text-right">Expires</span>
            <span className="text-right">Status</span>
          </div>
          <div className="px-6 py-10 text-center">
            <p className="font-semibold">Limit orders aren&apos;t available right now.</p>
            <p className="mt-1 text-sm text-text-secondary/70">No open limit orders.</p>
            <button className="mt-5 rounded-xl border border-subtle bg-elevated px-5 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-violet-300 hover:text-white">
              Retry
            </button>
          </div>
        </div>
      </section>

      {/* Activities */}
      <section>
        <h2 className="mb-4 text-2xl font-bold">Activities</h2>
        <div className="overflow-hidden rounded-2xl border border-subtle bg-surface">
          <div className="grid grid-cols-[1fr_1fr_1fr] gap-4 border-b border-subtle bg-elevated/40 px-6 py-3 text-xs uppercase tracking-wide text-text-secondary">
            <span>Type</span>
            <span>Details</span>
            <span className="text-right">Status</span>
          </div>
          <EmptyState title="No activity yet" subtitle="Your Solens activity will appear here." />
        </div>
      </section>
    </AppShell>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onClick}
        className={`relative h-6 w-11 rounded-full transition-colors ${on ? "bg-success" : "bg-elevated"}`}
        aria-pressed={on}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            on ? "translate-x-5" : ""
          }`}
        />
      </button>
      {label && <span className="text-sm text-text-secondary">{label}</span>}
    </div>
  );
}
