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
    return <div className="p-6 text-text-secondary">Loading…</div>;
  }

  const identityLabel = identity
    ? identity.username
      ? `@${identity.username}`
      : identity.firstName
        ? `${identity.firstName} (chat ${identity.chatId})`
        : `chat ${identity.chatId}`
    : null;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-base px-4 text-text-primary">
      <div className="glow-violet pointer-events-none absolute inset-x-0 bottom-0 h-[360px]" />
      <div className="relative w-full max-w-md space-y-5 rounded-2xl border border-subtle bg-surface p-6 shadow-2xl">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-violet-600 text-base font-extrabold lowercase text-white">
            s
          </div>
          <h1 className="text-lg font-semibold">Link Telegram to Solens</h1>
        </div>

        {identityError ? (
          <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {identityError}
          </div>
        ) : !identity ? (
          <p className="text-sm text-text-secondary">Validating link token…</p>
        ) : (
          <div className="space-y-2 rounded-xl border border-violet-300/40 bg-elevated/50 p-3 text-sm">
            <div className="font-semibold text-violet-200">
              You are about to link this Telegram identity:
            </div>
            <div className="break-all font-mono text-white">{identityLabel}</div>
            <div className="text-xs text-text-secondary">
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
            className="w-full rounded-lg bg-violet-500 px-4 py-2.5 text-sm font-semibold text-on-brand transition-colors hover:bg-violet-400 disabled:opacity-50"
            disabled={!identity}
          >
            Login With Privy
          </button>
        ) : (
          <>
            <div className="text-sm text-text-secondary">
              Wallet:{" "}
              <span className="font-mono text-white">
                {walletAddress ?? (walletError ? "error" : "loading…")}
              </span>
            </div>
            {walletError && (
              <div className="text-xs text-danger">{walletError}</div>
            )}
            <label className="flex items-start gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--violet-500)]"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                disabled={!identity}
              />
              <span>
                I confirm that <span className="font-mono text-white">{identityLabel ?? "(unknown)"}</span>{" "}
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
              className="w-full rounded-lg bg-violet-500 px-4 py-2.5 text-sm font-semibold text-on-brand transition-colors hover:bg-violet-400 disabled:opacity-50"
            >
              {status === "loading" ? "Linking…" : "Confirm Telegram Link"}
            </button>
          </>
        )}

        {status !== "idle" && (
          <p className={`text-sm ${status === "success" ? "text-success" : "text-danger"}`}>
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
        <div className="flex min-h-screen items-center justify-center bg-base text-text-secondary">
          Loading…
        </div>
      }
    >
      <TelegramLinkInner />
    </Suspense>
  );
}
