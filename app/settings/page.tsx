"use client";

import { useState } from "react";
import AppShell from "../components/AppShell";

function Select({
  options,
  value,
  onChange,
  disabled,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`appearance-none rounded-lg bg-[#161616] border border-white/10 pl-4 pr-9 py-2 text-sm ${
          disabled ? "text-zinc-500 cursor-not-allowed" : "text-white"
        }`}
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
      <svg
        className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  );
}

function Row({
  icon,
  label,
  control,
}: {
  icon: React.ReactNode;
  label: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-5 border-b border-white/10">
      <div className="flex items-center gap-4">
        <span className="text-zinc-400">{icon}</span>
        <span className="text-sm font-medium">{label}</span>
      </div>
      {control}
    </div>
  );
}

export default function SettingsPage() {
  const [theme, setTheme] = useState("System");
  const [language, setLanguage] = useState("English");

  return (
    <AppShell>
      <div className="max-w-2xl mx-auto pt-10">
        <h1 className="text-3xl font-bold mb-8">Settings</h1>

        <Row
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h14a2 2 0 012 2v3H3V5zM3 8h18v11a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
          }
          label="Theme"
          control={<Select options={["System", "Dark", "Light"]} value={theme} onChange={setTheme} />}
        />

        <Row
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M6 18l3-9m0 0l3 9M21 21l-3-9-3 9" />
            </svg>
          }
          label="Language"
          control={
            <Select
              options={["English", "Español", "Français", "Deutsch", "中文"]}
              value={language}
              onChange={setLanguage}
            />
          }
        />

        <Row
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 6h18M3 12h18M3 18h18M7 6v12" />
            </svg>
          }
          label="Currency"
          control={<Select options={["US Dollar"]} value="US Dollar" onChange={() => {}} disabled />}
        />

        <Row
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 12v.01M4 12l9-9 7 7-9 9-7-7zm9 4l4-4" />
            </svg>
          }
          label="Refer & Earn"
          control={
            <span className="rounded-lg bg-[#161616] border border-white/10 px-3 py-2 text-sm">6KUGVZ</span>
          }
        />

        <button className="flex items-center justify-center gap-2 w-full mt-8 rounded-xl bg-white text-black py-3.5 text-sm font-medium hover:bg-zinc-200 transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Contact Support
        </button>
      </div>
    </AppShell>
  );
}
