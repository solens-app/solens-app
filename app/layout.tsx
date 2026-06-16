import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Providers from "./providers";
import "./globals.css";

const inter = Inter({
    variable: "--font-inter",
    subsets: ["latin"],
    display: "swap",
});

export const metadata: Metadata = {
    title: "Solens",
    description:
        "The simplest way to trade crypto — AI-powered Solana assistant",
};

export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
};

// Applied before first paint so the stored theme never flashes. Mirrors the
// logic in app/lib/theme.ts.
const themeInitScript = `(function(){try{var p=localStorage.getItem('solens_theme')||'system';var d=p==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;var e=document.documentElement;e.dataset.theme=d;e.classList.toggle('dark',d==='dark');e.classList.toggle('light',d==='light');e.style.colorScheme=d;}catch(e){}})();`;

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html
            lang="en"
            data-theme="dark"
            className={`${inter.variable} h-full antialiased dark`}
            suppressHydrationWarning
        >
            <head>
                <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
            </head>
            <body className="min-h-full flex flex-col bg-base text-text-primary">
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
