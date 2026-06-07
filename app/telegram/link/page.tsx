"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePrivy, useToken } from "@privy-io/react-auth";

type LinkIdentity = {
  chatId: number;
  username: string | null;
  firstName: string | null;
};

function TelegramLinkInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const { ready, authenticated, login, user } = usePrivy();
  const { getAccessToken } = useToken();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<LinkIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  const privyUserId =
    typeof (user as { id?: unknown } | null)?.id === "string"
      ? ((user as { id: string }).id)
      : null;

  useEffect(() => {
    if (!token) {
      setIdentityError("Missing link token. Open the secure link from Telegram.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/telegram/link/info?token=${encodeURIComponent(token)}`);
        const data = (await res.json()) as Partial<LinkIdentity> & { ok?: boolean; error?: string };
        if (cancelled) return;
        if (!res.ok || !data.ok || typeof data.chatId !== "number") {
          setIdentityError(data.error ?? "Could not validate link token.");
          return;
        }
        setIdentity({
          chatId: data.chatId,
          username: data.username ?? null,
          firstName: data.firstName ?? null,
        });
      } catch (e) {
        if (cancelled) return;
        setIdentityError(e instanceof Error ? e.message : "Could not validate link token.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!authenticated) {
      setWalletAddress(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error("No Privy access token");
        const res = await fetch("/api/wallet/ensure", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.address) {
          setWalletError(data.error || "Could not load wallet");
          return;
        }
        setWalletAddress(data.address);
      } catch (e) {
        if (cancelled) return;
        setWalletError(e instanceof Error ? e.message : "Wallet load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  const handleConfirm = async () => {
    if (!token) {
      setStatus("error");
      setMessage("Missing link token. Please start linking again from Telegram.");
      return;
    }
    if (!walletAddress) {
      setStatus("error");
      setMessage("App wallet not ready yet. Please wait and try again.");
      return;
    }
    if (!identity) {
      setStatus("error");
      setMessage("Telegram identity not loaded yet. Please wait or refresh.");
      return;
    }
    if (!acknowledged) {
      setStatus("error");
      setMessage("Please confirm the Telegram identity that will be linked.");
      return;
    }

    setStatus("loading");
    setMessage("");
    try {
      const privyAuthToken = await getAccessToken();
      const res = await fetch("/api/telegram/link/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          privyUserId,
          privyAuthToken,
          expectedChatId: identity.chatId,
        }),
      });

      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to link Telegram session");
      }

      setStatus("success");
      setMessage("Telegram link complete. Return to Telegram and continue chatting.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Link failed");
    }
  };

  if (!ready) {
    return <div className="p-6 text-zinc-300">Loading...</div>;
  }

  const identityLabel = identity
    ? identity.username
      ? `@${identity.username}`
      : identity.firstName
        ? `${identity.firstName} (chat ${identity.chatId})`
        : `chat ${identity.chatId}`
    : null;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-zinc-900 p-6 space-y-4">
        <h1 className="text-xl font-semibold">Link Telegram to Solens</h1>

        {identityError ? (
          <div className="rounded-lg border border-rose-500/40 bg-rose-950/40 p-3 text-sm text-rose-200">
            {identityError}
          </div>
        ) : !identity ? (
          <p className="text-sm text-zinc-400">Validating link token...</p>
        ) : (
          <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 text-sm space-y-2">
            <div className="font-semibold text-amber-200">
              You are about to link this Telegram identity:
            </div>
            <div className="font-mono text-zinc-100 break-all">{identityLabel}</div>
            <div className="text-xs text-amber-200/80">
              After linking, this Telegram chat will be able to request transactions
              that are signed by your Solens wallet. Only continue if this is your
              own Telegram account. If a third party sent you this link, close this
              page.
            </div>
          </div>
        )}

        {!authenticated ? (
          <button
            onClick={login}
            className="w-full px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm font-medium"
            disabled={!identity}
          >
            Login With Privy
          </button>
        ) : (
          <>
            <div className="text-sm text-zinc-300">
              Wallet:{" "}
              <span className="font-mono text-zinc-100">
                {walletAddress ?? (walletError ? "error" : "loading...")}
              </span>
            </div>
            {walletError && (
              <div className="text-xs text-rose-400">{walletError}</div>
            )}
            <label className="flex items-start gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                disabled={!identity}
              />
              <span>
                I confirm that <span className="font-mono">{identityLabel ?? "(unknown)"}</span>{" "}
                is my own Telegram account and I want to bind it to my Solens wallet.
              </span>
            </label>
            <button
              onClick={handleConfirm}
              disabled={
                status === "loading" ||
                !walletAddress ||
                !identity ||
                !acknowledged
              }
              className="w-full px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium"
            >
              {status === "loading" ? "Linking..." : "Confirm Telegram Link"}
            </button>
          </>
        )}

        {status !== "idle" && (
          <p className={`text-sm ${status === "success" ? "text-emerald-400" : "text-rose-400"}`}>
            {message}
          </p>
        )}
      </div>
    </main>
  );
}

export default function TelegramLinkPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-300">
          Loading...
        </div>
      }
    >
      <TelegramLinkInner />
    </Suspense>
  );
}
