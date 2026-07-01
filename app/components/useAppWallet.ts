"use client";

import { useEffect, useState } from "react";
import { usePrivy, useToken } from "@privy-io/react-auth";

/**
 * Resolves the app-managed wallet (via /api/wallet/ensure — the wallet that
 * actually transacts and earns EP) plus the user's real referral code.
 *
 * Must be used inside a component that is only mounted when Privy is
 * configured, since it calls usePrivy/useToken.
 */
export function useAppWallet() {
  const { authenticated, login, logout } = usePrivy();
  const { getAccessToken } = useToken();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [referralCode, setReferralCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!authenticated) {
        if (!cancelled) {
          setWalletAddress(null);
          setReferralCode(null);
        }
        return;
      }
      try {
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch("/api/wallet/ensure", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (cancelled || !res.ok || !data.address) return;
        setWalletAddress(data.address);

        // Fetch the real referral code from the points state.
        const pts = await fetch(`/api/points?wallet=${encodeURIComponent(data.address)}`, {
          cache: "no-store",
        });
        const ptsData = await pts.json();
        if (!cancelled && pts.ok && ptsData.referralCode) setReferralCode(ptsData.referralCode);
      } catch {
        /* leave nulls; callers render a fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  return { authenticated, walletAddress, referralCode, login, logout };
}
