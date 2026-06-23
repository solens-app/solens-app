/**
 * Client-side theme controller. The active theme is applied to
 * <html data-theme> (and a matching class + color-scheme); the CSS variable
 * overrides for "light" live in globals.css. Preference is persisted in
 * localStorage and a no-flash inline script in app/layout.tsx applies it
 * before first paint.
 */

export type ThemePref = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export const THEME_KEY = "solens_theme";

export function getStoredTheme(): ThemePref {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    /* localStorage unavailable */
  }
  return "system";
}

export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

/** Apply a resolved theme to the document without persisting. */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.dataset.theme = resolved;
  el.classList.toggle("dark", resolved === "dark");
  el.classList.toggle("light", resolved === "light");
  el.style.colorScheme = resolved;
}

/** Persist a preference and apply it immediately. */
export function setTheme(pref: ThemePref): void {
  try {
    window.localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
  applyResolvedTheme(resolveTheme(pref));
}

/**
 * Keep the document in sync with the OS theme while the preference is
 * "system". Returns an unsubscribe function.
 */
export function subscribeSystemTheme(getPref: () => ThemePref): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getPref() === "system") applyResolvedTheme(systemTheme());
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

// Map between the Settings UI labels and the stored preference.
export const THEME_LABELS: Record<ThemePref, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
};

export function labelToPref(label: string): ThemePref {
  const found = (Object.keys(THEME_LABELS) as ThemePref[]).find((k) => THEME_LABELS[k] === label);
  return found ?? "system";
}
