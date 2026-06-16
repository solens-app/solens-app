"use client";

import { useEffect, useState } from "react";
import AppShell from "../components/AppShell";
import { useAppWallet } from "../components/useAppWallet";
import {
  getStoredTheme,
  setTheme,
  subscribeSystemTheme,
  THEME_LABELS,
  labelToPref,
  type ThemePref,
} from "@/app/lib/theme";

const PRIVY_ENABLED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

function Select({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-lg border border-transparent bg-elevated py-2 pl-4 pr-9 text-sm text-text-primary transition-colors focus:border-violet-300 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  );
}

function ComingSoon({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-sm text-text-secondary/60">{value}</span>
      <span className="rounded-full bg-violet-500/15 px-2.5 py-1 text-[11px] font-semibold text-violet-300">
        Coming soon
      </span>
    </div>
  );
}

function Row({
  icon,
  label,
  control,
  last,
}: {
  icon: React.ReactNode;
  label: string;
  control: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between px-5 py-5 ${last ? "" : "border-b border-subtle"}`}>
      <div className="flex items-center gap-4">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-elevated text-violet-300">{icon}</span>
        <span className="text-sm font-medium">{label}</span>
      </div>
      {control}
    </div>
  );
}

// Real referral code — only mounted when Privy is configured.
function ReferralValue() {
  const { referralCode } = useAppWallet();
  return (
    <span className="rounded-lg bg-elevated px-3 py-2 text-sm font-medium tracking-wide text-violet-300">
      {referralCode ?? "—"}
    </span>
  );
}

export default function SettingsPage() {
  // Theme: initialise to a stable label, then sync from storage after mount
  // (avoids a server/client value mismatch).
  const [themeLabel, setThemeLabel] = useState<string>(THEME_LABELS.system);

  useEffect(() => {
    let cancelled = false;
    // Defer out of the synchronous effect body to avoid a cascading render.
    Promise.resolve().then(() => {
      if (!cancelled) setThemeLabel(THEME_LABELS[getStoredTheme()]);
    });
    const unsub = subscribeSystemTheme(getStoredTheme);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const onThemeChange = (label: string) => {
    setThemeLabel(label);
    const pref: ThemePref = labelToPref(label);
    setTheme(pref);
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl pt-10">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="mt-2 mb-8 text-text-secondary">Manage your preferences and account.</p>

        <div className="overflow-hidden rounded-2xl bg-surface card-shadow">
          <Row
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h14a2 2 0 012 2v3H3V5zM3 8h18v11a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
              </svg>
            }
            label="Theme"
            control={
              <Select
                options={[THEME_LABELS.system, THEME_LABELS.dark, THEME_LABELS.light]}
                value={themeLabel}
                onChange={onThemeChange}
              />
            }
          />

          <Row
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M6 18l3-9m0 0l3 9M21 21l-3-9-3 9" />
              </svg>
            }
            label="Language"
            control={<ComingSoon value="English" />}
          />

          <Row
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 6h18M3 12h18M3 18h18M7 6v12" />
              </svg>
            }
            label="Currency"
            control={<ComingSoon value="US Dollar" />}
          />

          <Row
            last
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 12v.01M4 12l9-9 7 7-9 9-7-7zm9 4l4-4" />
              </svg>
            }
            label="Refer & Earn"
            control={
              PRIVY_ENABLED ? (
                <ReferralValue />
              ) : (
                <span className="rounded-lg bg-elevated px-3 py-2 text-sm font-medium tracking-wide text-violet-300">
                  —
                </span>
              )
            }
          />
        </div>

        <button className="mt-8 flex w-full items-center justify-center gap-2 rounded-xl bg-violet-500 py-3.5 text-sm font-semibold text-on-brand transition-colors hover:bg-violet-400">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Contact Support
        </button>
      </div>
    </AppShell>
  );
}
