# syntax=docker/dockerfile:1

# ---- Base: Node 22 (Debian slim avoids musl/native-crypto surprises) + pnpm 9 ----
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@9

# ---- Dependencies (cached unless the lockfile changes) ----
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- Builder ----
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the CLIENT bundle at BUILD time.
# They must be present here (--build-arg), not just at runtime, or the browser
# ships with empty strings. Server-only secrets (OPENAI_API_KEY, DATABASE_URL,
# TELEGRAM_*, etc.) are read at runtime and must NOT be baked into the image.
ARG NEXT_PUBLIC_PRIVY_APP_ID
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_PRIVY_LOGIN_METHODS
ARG NEXT_PUBLIC_ENABLE_PRIVY_EMBEDDED_WALLETS
ARG NEXT_PUBLIC_SOLANA_RPC_URL
ARG NEXT_PUBLIC_SOLANA_BROWSER_RPC_URL
ARG NEXT_PUBLIC_SOLANA_RPC_SUBSCRIPTIONS_URL
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_PRIVY_LOGIN_METHODS=$NEXT_PUBLIC_PRIVY_LOGIN_METHODS \
    NEXT_PUBLIC_ENABLE_PRIVY_EMBEDDED_WALLETS=$NEXT_PUBLIC_ENABLE_PRIVY_EMBEDDED_WALLETS \
    NEXT_PUBLIC_SOLANA_RPC_URL=$NEXT_PUBLIC_SOLANA_RPC_URL \
    NEXT_PUBLIC_SOLANA_BROWSER_RPC_URL=$NEXT_PUBLIC_SOLANA_BROWSER_RPC_URL \
    NEXT_PUBLIC_SOLANA_RPC_SUBSCRIPTIONS_URL=$NEXT_PUBLIC_SOLANA_RPC_SUBSCRIPTIONS_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- Runner (small, non-root, standalone server) ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
