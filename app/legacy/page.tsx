"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useToken } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets, useSignTransaction } from "@privy-io/react-auth/solana";

interface WalletQuote {
  fromAddress: string;
  lamports: number;
  sol: number;
  transaction: string | null;
  reason?: string;
}

interface QuoteResponse {
  destinationAddress: string;
  quotes: WalletQuote[];
}

export default function LegacyDrainPage() {
  const { ready, authenticated, login } = usePrivy();
  const { getAccessToken } = useToken();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { signTransaction } = useSignTransaction();
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAddress, setBusyAddress] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("No Privy access token");
        const res = await fetch("/api/legacy/drain-quote", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || data.detail || "Could not load quotes");
          return;
        }
        setQuote(data as QuoteResponse);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Quote failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  const drain = useCallback(
    async (q: WalletQuote) => {
      if (!q.transaction) return;
      const wallet = solanaWallets.find((w) => w.address === q.fromAddress);
      if (!wallet) {
        setStatuses((s) => ({
          ...s,
          [q.fromAddress]: "Wallet is not connected in this browser session — log into Privy with the account that owns it.",
        }));
        return;
      }

      setBusyAddress(q.fromAddress);
      setStatuses((s) => ({ ...s, [q.fromAddress]: "Signing..." }));
      try {
        const txBytes = Uint8Array.from(atob(q.transaction), (c) => c.charCodeAt(0));
        const { signedTransaction } = await signTransaction({ transaction: txBytes, wallet });
        const signedBase64 = btoa(String.fromCharCode(...signedTransaction));
        const res = await fetch("/api/meteora/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signedTransactions: [signedBase64] }),
        });
        const data = await res.json();
        if (data.status === "Success" && data.signatures?.[0]) {
          setStatuses((s) => ({
            ...s,
            [q.fromAddress]: `Drained. https://solscan.io/tx/${data.signatures[0]}`,
          }));
        } else {
          setStatuses((s) => ({
            ...s,
            [q.fromAddress]: `Failed: ${data.error || data.status || "unknown"}`,
          }));
        }
      } catch (e) {
        setStatuses((s) => ({
          ...s,
          [q.fromAddress]: e instanceof Error ? e.message : "Sign/broadcast failed",
        }));
      } finally {
        setBusyAddress(null);
      }
    },
    [solanaWallets, signTransaction]
  );

  if (!ready) return <div className="p-6 text-zinc-300">Loading...</div>;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-start justify-center px-4 pt-20">
      <div className="w-full max-w-xl rounded-xl border border-white/10 bg-zinc-900 p-6 space-y-4">
        <h1 className="text-xl font-semibold">Drain legacy wallets</h1>
        <p className="text-sm text-zinc-400">
          Move funds from any user-owned Privy wallets you had before, into your new app wallet.
          Each drain requires a Privy popup to sign.
        </p>

        {!authenticated ? (
          <button
            onClick={login}
            className="w-full px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm font-medium"
          >
            Login With Privy
          </button>
        ) : error ? (
          <div className="text-sm text-rose-400">{error}</div>
        ) : !quote ? (
          <div className="text-sm text-zinc-500 animate-pulse">Loading quotes...</div>
        ) : (
          <>
            <div className="text-xs text-zinc-500">
              Destination:{" "}
              <span className="font-mono text-zinc-200">{quote.destinationAddress}</span>
            </div>
            <ul className="space-y-3">
              {quote.quotes.map((q) => (
                <li
                  key={q.fromAddress}
                  className="rounded-lg border border-white/10 bg-zinc-950 p-3 text-sm space-y-2"
                >
                  <div className="font-mono text-xs text-zinc-300 break-all">{q.fromAddress}</div>
                  <div className="text-zinc-400">
                    Drainable: <span className="text-zinc-100">{q.sol.toFixed(6)} SOL</span>
                    {q.reason ? <span className="text-zinc-500"> — {q.reason}</span> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => drain(q)}
                      disabled={!q.transaction || busyAddress !== null}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {busyAddress === q.fromAddress ? "Working..." : "Drain"}
                    </button>
                    {statuses[q.fromAddress] && (
                      <span className="text-xs text-zinc-400 break-all">
                        {statuses[q.fromAddress]}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
