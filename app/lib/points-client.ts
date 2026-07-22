/**
 * Browser-side helpers for the Points system. Safe to import in client
 * components only. All network calls are fire-and-forget — a failure never
 * blocks the user-facing flow.
 */

const REF_KEY = "solens_ref";

/**
 * Record a real activity event (fire-and-forget). The server verifies it and
 * sanitizes `meta` — only the display fields the social feed renders survive.
 */
export function recordPointsEvent(
  wallet: string | null | undefined,
  type: string,
  signature?: string,
  meta?: Record<string, unknown>,
): void {
  if (!wallet) return;
  try {
    void fetch("/api/points/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, type, signature, meta }),
    }).catch(() => {});
  } catch {
    /* no-op */
  }
}

/** Capture a `?ref=CODE` from the current URL and remember it until a wallet connects. */
export function captureRefFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const code = new URLSearchParams(window.location.search).get("ref");
    if (code && code.trim() && !window.localStorage.getItem(REF_KEY)) {
      window.localStorage.setItem(REF_KEY, code.trim());
    }
  } catch {
    /* localStorage unavailable */
  }
}

/** If a referral code is pending, attribute it to the connected wallet (once). */
export function attributePendingRef(wallet: string | null | undefined): void {
  if (!wallet || typeof window === "undefined") return;
  let code: string | null = null;
  try {
    code = window.localStorage.getItem(REF_KEY);
  } catch {
    return;
  }
  if (!code) return;

  try {
    void fetch("/api/points/referral", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, code }),
    })
      .then((r) => r.json())
      .then((res) => {
        // Clear once resolved (success, self, already-referred, or invalid code)
        // so we don't retry forever.
        if (res && (res.ok || res.reason)) {
          try {
            window.localStorage.removeItem(REF_KEY);
          } catch {
            /* no-op */
          }
        }
      })
      .catch(() => {});
  } catch {
    /* no-op */
  }
}
