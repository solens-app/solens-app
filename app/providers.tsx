"use client";
import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

const SOLANA_BROWSER_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_BROWSER_RPC_URL || "/api/solana/rpc";
const SOLANA_RPC_SUBSCRIPTIONS_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_SUBSCRIPTIONS_URL ||
  "wss://api.mainnet-beta.solana.com";

const solanaRpcs = {
  "solana:mainnet": {
    rpc: createSolanaRpc(SOLANA_BROWSER_RPC_URL),
    rpcSubscriptions: createSolanaRpcSubscriptions(SOLANA_RPC_SUBSCRIPTIONS_URL),
  },
};

const PRIVY_LOGIN_METHODS = [
  "wallet",
  "email",
  "sms",
  "google",
  "twitter",
  "discord",
  "github",
  "linkedin",
  "spotify",
  "instagram",
  "tiktok",
  "line",
  "twitch",
  "apple",
  "farcaster",
  "telegram",
  "passkey",
] as const;

type AllowedPrivyLoginMethod = NonNullable<PrivyClientConfig["loginMethods"]>[number];

function normalizePrivyLoginMethod(value: string): string {
  if (value === "gmail") return "google";
  return value;
}

function isAllowedPrivyLoginMethod(value: string): value is AllowedPrivyLoginMethod {
  return (
    value.startsWith("privy:") ||
    PRIVY_LOGIN_METHODS.includes(value as (typeof PRIVY_LOGIN_METHODS)[number])
  );
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const enableEmbeddedWallets =
    process.env.NEXT_PUBLIC_ENABLE_PRIVY_EMBEDDED_WALLETS === "true";
  const loginMethods = (
    process.env.NEXT_PUBLIC_PRIVY_LOGIN_METHODS || "email"
  )
    .split(",")
    .map((m) => m.trim())
    .map(normalizePrivyLoginMethod)
    .filter(Boolean)
    .filter(isAllowedPrivyLoginMethod);

  const privyConfig = {
    appearance: {
      theme: "dark",
      accentColor: "#7C3AED",
      loginMessage: "Welcome to Solens",
    },
    loginMethods,
    externalWallets: {
      solana: {
        connectors: toSolanaWalletConnectors(),
      },
    },
    ...(enableEmbeddedWallets
      ? {
          embeddedWallets: {
            solana: {
              createOnLogin: "users-without-wallets",
            },
          },
        }
      : {}),
    solana: {
      rpcs: solanaRpcs,
    },
  } satisfies PrivyClientConfig;

  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={privyConfig}
    >
      {children}
    </PrivyProvider>
  );
}
