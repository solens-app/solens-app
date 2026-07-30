"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type IconProps = { className?: string };

const Icon = {
    home: (p: IconProps) => (
        <svg
            className={p.className}
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth={1.4}
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2 6.5 8 2l6 4.5V13a1 1 0 0 1-1 1h-2.5v-3.5h-3V14H3a1 1 0 0 1-1-1V6.5Z"
            />
        </svg>
    ),
    portfolio: (p: IconProps) => (
        <svg
            className={p.className}
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth={1.4}
        >
            <rect x="2" y="4" width="12" height="9" rx="2" />
            <path strokeLinecap="round" d="M2 7h12" />
        </svg>
    ),
    points: (p: IconProps) => (
        <svg
            className={p.className}
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth={1.4}
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m8 2 1.7 3.6 3.8.5-2.8 2.7.7 3.9L8 10.9 4.6 12.7l.7-3.9L2.5 6.1l3.8-.5L8 2Z"
            />
        </svg>
    ),
    settings: (p: IconProps) => (
        <svg
            className={p.className}
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth={1.4}
        >
            <circle cx="8" cy="8" r="2.2" />
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 1.5v1.6M8 12.9v1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M1.5 8h1.6M12.9 8h1.6M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
            />
        </svg>
    ),
    history: (p: IconProps) => (
        <svg
            className={p.className}
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth={1.4}
        >
            <circle cx="8" cy="8" r="6" />
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 5v3l2 1.5"
            />
        </svg>
    ),
    collapse: (p: IconProps) => (
        <svg
            className={p.className}
            fill="none"
            viewBox="0 0 20 20"
            stroke="currentColor"
            strokeWidth={1.5}
        >
            <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
            <path d="M7.5 3.5v13" />
        </svg>
    ),
    x: (p: IconProps) => (
        <svg className={p.className} viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
        </svg>
    ),
    telegram: (p: IconProps) => (
        <svg className={p.className} viewBox="0 0 24 24" fill="currentColor">
            <path d="M21.94 4.66 18.9 19.01c-.23 1.01-.83 1.26-1.68.78l-4.64-3.42-2.24 2.16c-.25.25-.46.46-.93.46l.33-4.72L18.5 6.9c.37-.33-.08-.51-.58-.18L7.36 13.4l-4.57-1.43c-.99-.31-1.01-.99.21-1.47l17.86-6.89c.83-.31 1.55.18 1.08 3.05Z" />
        </svg>
    ),
    globe: (p: IconProps) => (
        <svg
            className={p.className}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
        >
            <circle cx="12" cy="12" r="9" />
            <path
                strokeLinecap="round"
                d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"
            />
        </svg>
    ),
} as const;

const navItems = [
    { label: "Home", icon: Icon.home, href: "/" },
    { label: "Portfolio", icon: Icon.portfolio, href: "/portfolio" },
    { label: "Points", icon: Icon.points, href: "/points" },
    { label: "Settings", icon: Icon.settings, href: "/settings" },
    { label: "History", icon: Icon.history, href: "/history" },
] as const;

const LANDING_URL = "https://solens.app";

function Wordmark({ collapsed }: { collapsed: boolean }) {
    if (collapsed) {
        return (
            <a
                href={LANDING_URL}
                aria-label="Solens home"
                className="flex h-[26px] w-full items-center justify-center transition-opacity hover:opacity-80"
            >
                <span className="text-xl font-extrabold tracking-tight text-text-primary">
                    s
                </span>
            </a>
        );
    }
    return (
        <a
            href={LANDING_URL}
            aria-label="Solens home"
            className="text-[22px] font-extrabold lowercase tracking-tight text-text-primary transition-opacity hover:opacity-80"
        >
            sol
            <span className="text-violet-400">e</span>
            ns
        </a>
    );
}

export default function Sidebar() {
    const [collapsed, setCollapsed] = useState(false);
    const [mobileOpen, setMobileOpen] = useState(false);
    const pathname = usePathname();

    return (
        <>
        <aside
            className={`${collapsed ? "w-[72px]" : "w-60"} hidden h-full flex-col justify-between border-r border-subtle bg-base transition-[width] duration-200 md:flex`}
        >
            {/* Logo + collapse */}
            <div>
                <div className="flex items-center justify-between px-4 py-[18px]">
                    {!collapsed && <Wordmark collapsed={false} />}
                    {collapsed && <Wordmark collapsed />}
                    <button
                        onClick={() => setCollapsed((c) => !c)}
                        className={`${collapsed ? "hidden" : ""} flex items-center justify-center rounded-md bg-elevated p-1.5 text-text-secondary transition-colors hover:text-text-primary`}
                        aria-label="Collapse sidebar"
                    >
                        <Icon.collapse className="h-5 w-5" />
                    </button>
                </div>

                {/* Nav */}
                <nav className="flex flex-col gap-3 px-4 pt-2">
                    {navItems.map(({ label, icon: ItemIcon, href }) => {
                        const isActive =
                            href === "/"
                                ? pathname === "/"
                                : pathname.startsWith(href);
                        return (
                            <Link
                                key={label}
                                href={href}
                                title={collapsed ? label : undefined}
                                className={`group flex items-center gap-2 rounded-lg p-3 text-sm font-medium transition-colors ${
                                    isActive
                                        ? "bg-violet-500 text-on-brand"
                                        : "text-text-secondary hover:bg-elevated/60 hover:text-text-primary"
                                } ${collapsed ? "justify-center" : ""}`}
                            >
                                <ItemIcon className="h-4 w-4 shrink-0" />
                                {!collapsed && (
                                    <span className="whitespace-nowrap">
                                        {label}
                                    </span>
                                )}
                            </Link>
                        );
                    })}
                </nav>
            </div>

            {/* Bottom social row */}
            <div
                className={`flex items-center gap-6 p-4 text-text-secondary ${collapsed ? "flex-col" : ""}`}
            >
                <a
                    href="https://x.com/solens"
                    target="_blank"
                    rel="noreferrer"
                    className="transition-colors hover:text-text-primary"
                    aria-label="X"
                >
                    <Icon.x className="h-[18px] w-[18px]" />
                </a>
                <a
                    href="https://t.me/solens"
                    target="_blank"
                    rel="noreferrer"
                    className="transition-colors hover:text-text-primary"
                    aria-label="Telegram"
                >
                    <Icon.telegram className="h-5 w-5" />
                </a>
                <a
                    href={LANDING_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="transition-colors hover:text-text-primary"
                    aria-label="Website"
                >
                    <Icon.globe className="h-5 w-5" />
                </a>
            </div>
        </aside>

        {/* Mobile: floating menu button (the desktop sidebar is hidden < md). */}
        <button
            onClick={() => setMobileOpen(true)}
            className="fixed left-3 top-3 z-40 grid h-10 w-10 place-items-center rounded-xl border border-subtle bg-surface/90 text-text-primary backdrop-blur transition-colors hover:bg-elevated md:hidden"
            aria-label="Open menu"
        >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
        </button>

        {/* Mobile drawer */}
        <div
            className={`fixed inset-0 z-50 md:hidden ${mobileOpen ? "" : "pointer-events-none"}`}
            aria-hidden={!mobileOpen}
        >
            <div
                className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${mobileOpen ? "opacity-100" : "opacity-0"}`}
                onClick={() => setMobileOpen(false)}
            />
            <div
                className={`absolute left-0 top-0 flex h-full w-64 max-w-[80%] flex-col justify-between border-r border-subtle bg-base shadow-2xl transition-transform duration-200 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
            >
                <div>
                    <div className="flex items-center justify-between px-4 py-[18px]">
                        <Wordmark collapsed={false} />
                        <button
                            onClick={() => setMobileOpen(false)}
                            className="grid h-8 w-8 place-items-center rounded-md bg-elevated text-text-secondary transition-colors hover:text-text-primary"
                            aria-label="Close menu"
                        >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
                            </svg>
                        </button>
                    </div>
                    <nav className="flex flex-col gap-2 px-4 pt-2">
                        {navItems.map(({ label, icon: ItemIcon, href }) => {
                            const isActive =
                                href === "/"
                                    ? pathname === "/"
                                    : pathname.startsWith(href);
                            return (
                                <Link
                                    key={label}
                                    href={href}
                                    onClick={() => setMobileOpen(false)}
                                    className={`flex items-center gap-3 rounded-lg p-3 text-sm font-medium transition-colors ${
                                        isActive
                                            ? "bg-violet-500 text-on-brand"
                                            : "text-text-secondary hover:bg-elevated/60 hover:text-text-primary"
                                    }`}
                                >
                                    <ItemIcon className="h-4 w-4 shrink-0" />
                                    <span className="whitespace-nowrap">{label}</span>
                                </Link>
                            );
                        })}
                    </nav>
                </div>
                <div className="flex items-center gap-6 p-4 text-text-secondary">
                    <a href="https://x.com/solens" target="_blank" rel="noreferrer" className="transition-colors hover:text-text-primary" aria-label="X">
                        <Icon.x className="h-[18px] w-[18px]" />
                    </a>
                    <a href="https://t.me/solens" target="_blank" rel="noreferrer" className="transition-colors hover:text-text-primary" aria-label="Telegram">
                        <Icon.telegram className="h-5 w-5" />
                    </a>
                    <a href={LANDING_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-text-primary" aria-label="Website">
                        <Icon.globe className="h-5 w-5" />
                    </a>
                </div>
            </div>
        </div>
        </>
    );
}
