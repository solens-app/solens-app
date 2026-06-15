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
      className={`grid place-items-center w-9 h-9 rounded-full bg-gradient-to-br ${color} text-[11px] font-bold text-black`}
    >
      {symbol.slice(0, 3)}
    </span>
  );
}

export default function PortfolioPage() {
  const [dust, setDust] = useState(false);
  const [testnet, setTestnet] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [activeOrderTab, setActiveOrderTab] = useState(orderTabs[0]);

  return (
    <AppShell>
      <h1 className="text-3xl font-bold mb-8">Portfolio</h1>

      {/* Tokens */}
      <section className="mb-12">
        <h2 className="text-lg font-semibold mb-3">Tokens</h2>
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto] gap-6 px-6 py-3 bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
            <span>Tokens</span>
            <span className="text-right w-40">Balance ⇅</span>
            <span className="text-right w-28">Value (USD) ⇅</span>
          </div>
          {tokens.map((t) => (
            <div
              key={t.symbol}
              className="grid grid-cols-[1fr_auto_auto] gap-6 items-center px-6 py-4 border-t border-white/5"
            >
              <div className="flex items-center gap-3">
                <TokenIcon symbol={t.symbol} color={t.color} />
                <div>
                  <div className="font-medium">{t.symbol}</div>
                  <div className="text-xs text-zinc-500">{t.network}</div>
                </div>
              </div>
              <span className="text-right w-40 text-sm text-zinc-300">{t.balance}</span>
              <span className="text-right w-28 font-medium">{t.value}</span>
            </div>
          ))}
          <div className="grid grid-cols-[1fr_auto_auto] gap-6 items-center px-6 py-4 border-t border-white/10 bg-white/[0.02]">
            <span className="text-zinc-400">Total</span>
            <span className="w-40" />
            <span className="text-right w-28 font-semibold">$745.40</span>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <Toggle label="Dust Tokens" on={dust} onClick={() => setDust(!dust)} />
          <Toggle label="Testnet Tokens" on={testnet} onClick={() => setTestnet(!testnet)} />
        </div>
      </section>

      {/* Positions */}
      <section className="mb-12">
        <h2 className="text-2xl font-bold mb-4">Positions</h2>
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 px-6 py-3 bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
            <span>Token</span>
            <span>Amount</span>
            <span>Value (USD)</span>
            <span>APY</span>
            <span>Status</span>
          </div>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 items-center px-6 py-5 border-t border-white/5"
            >
              <div className="flex items-center gap-3">
                <span className="w-9 h-9 rounded-full bg-white/5 animate-pulse" />
                <span className="h-3 w-32 rounded bg-white/5 animate-pulse" />
              </div>
              <span className="h-3 w-16 rounded bg-white/5 animate-pulse" />
              <span className="h-3 w-16 rounded bg-white/5 animate-pulse" />
              <span className="h-3 w-12 rounded bg-white/5 animate-pulse" />
              <span className="h-3 w-14 rounded bg-white/5 animate-pulse" />
            </div>
          ))}
        </div>
      </section>

      {/* Perp Positions */}
      <section className="mb-12">
        <h2 className="text-2xl font-bold mb-4">Drift Perp Positions</h2>
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-4 px-6 py-3 bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
            <span>Tokens</span>
            <span className="text-right">Entry</span>
            <span className="text-right">LTP</span>
            <span className="text-right">PNL (USD) ⇅</span>
          </div>
          <div className="py-10 text-center font-bold text-lg text-zinc-300">
            No Perp Positions Found
          </div>
        </div>
      </section>

      {/* Prediction markets */}
      <section className="mb-12">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold">Prediction positions</h2>
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            Display closed positions
            <Toggle label="" on={showClosed} onClick={() => setShowClosed(!showClosed)} />
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 px-6 py-12 text-center">
          <p className="text-zinc-400 mb-5">
            Initialize prediction market credentials to view your positions and open orders.
          </p>
          <button className="rounded-xl bg-white text-black px-5 py-2.5 text-sm font-medium hover:bg-zinc-200 transition-colors">
            Initialize Prediction Markets
          </button>
        </div>
      </section>

      {/* Limit Orders */}
      <section className="mb-12">
        <div className="flex items-end justify-between mb-4">
          <h2 className="text-2xl font-bold">Limit Orders</h2>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-400 mb-1.5">Filter by Token</div>
            <button className="flex items-center justify-between gap-3 w-44 rounded-xl bg-[#11161f] border border-white/10 px-4 py-2.5 text-sm">
              SOL
              <svg className="w-4 h-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-white/10 mb-1">
          {orderTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveOrderTab(tab)}
              className={`px-3 py-2 text-sm rounded-lg transition-colors ${
                activeOrderTab === tab
                  ? "text-white bg-white/5"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 px-6 py-3 bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
            <span>Order</span>
            <span className="text-right">Price</span>
            <span className="text-right">Filled</span>
            <span className="text-right">Expires</span>
            <span className="text-right">Status</span>
          </div>
          <div className="py-10 text-center">
            <p className="font-semibold">Limit orders aren&apos;t available right now.</p>
            <p className="text-sm text-zinc-500 mt-1">No open limit orders.</p>
            <button className="mt-5 rounded-xl bg-white text-black px-5 py-2 text-sm font-medium hover:bg-zinc-200 transition-colors">
              Retry
            </button>
          </div>
        </div>
      </section>

      {/* Activities */}
      <section>
        <h2 className="text-2xl font-bold mb-4">Activities</h2>
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <div className="grid grid-cols-[1fr_1fr_1fr] gap-4 px-6 py-3 bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
            <span>Type</span>
            <span>Details</span>
            <span className="text-right">Status</span>
          </div>
          <div className="py-10 text-center font-bold text-lg text-zinc-300">
            No Activities on Solens
          </div>
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
        className={`relative w-11 h-6 rounded-full transition-colors ${
          on ? "bg-[#14F195]" : "bg-white/15"
        }`}
        aria-pressed={on}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
            on ? "translate-x-5" : ""
          }`}
        />
      </button>
      {label && <span className="text-sm text-zinc-300">{label}</span>}
    </div>
  );
}
