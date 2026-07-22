"use client";

import { useRouter } from "next/navigation";

/**
 * Back control for standalone pages (Terms, etc.). Prefers browser history so
 * the user lands exactly where they came from; a deep link or fresh tab has no
 * history to pop, so it falls back to `fallbackHref` instead of dead-ending.
 */
export default function BackButton({
  fallbackHref = "/",
  label = "Back",
}: {
  fallbackHref?: string;
  label?: string;
}) {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== "undefined" && window.history.length > 1) {
          router.back();
        } else {
          router.push(fallbackHref);
        }
      }}
      className="-ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary"
    >
      <svg
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.9}
        aria-hidden
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      {label}
    </button>
  );
}
