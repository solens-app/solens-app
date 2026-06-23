## Solens

Solens is a Solana-focused AI assistant with:
- Web chat UI
- Wallet-aware tools (swaps, liquidity, prediction markets, NFTs)
- Telegram bot webhook support

## Local Development

Run the app:

```bash
pnpm dev
```

Open `http://localhost:3000`.

## Environment Variables

Core:

- `OPENAI_API_KEY` - required
- `OPENAI_MODEL` - optional (defaults to `gpt-4o-mini`)
- `OPENAI_BASE_URL` - optional; if empty, uses standard OpenAI API base URL
- `NEXT_PUBLIC_ENABLE_PRIVY_EMBEDDED_WALLETS` - optional; set `true` only when your runtime is consistently secure HTTPS
- `NEXT_PUBLIC_PRIVY_LOGIN_METHODS` - optional comma-separated login methods (e.g. `email` or `email,google`)

Telegram:

- `TELEGRAM_BOT_TOKEN` - required for Telegram bot
- `TELEGRAM_WEBHOOK_SECRET` - **required**; must match the `secret_token` registered with Telegram via `setWebhook`. The webhook rejects all requests when no secret is configured (otherwise an unauthenticated caller could forge updates and drive on-chain signing for any linked chat). `TELEGRAM_WEBHOOK_SECRETS` (comma-separated) is also accepted for rotation.
- `TELEGRAM_LINK_SECRET` - optional; if empty, auto-generated in-memory per process (set it in production)
- `TELEGRAM_LINK_BASE_URL` - optional explicit public app URL for generated link messages
- `NEXT_PUBLIC_APP_URL` - optional fallback base URL for Telegram link generation
- `INTERNAL_API_BASE_URL` - optional internal base URL used by Telegram webhook to call `/api/chat` (defaults to `http://127.0.0.1:3000`)

Points / rewards:

- `DATABASE_URL` - **required for the Points page**; Neon (or any) Postgres connection string. Backs `users`, `activity_events`, and `quest_claims`. EP is only awarded for real, on-chain-verified actions and recorded interactions; without this the `/api/points/*` routes return 500. Server-only — never exposed to the browser.

## Telegram Bot Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Set env vars (`TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` — both required).
3. Deploy your app to a public HTTPS URL.
4. Register the webhook (the `secret_token` you pass below must equal `TELEGRAM_WEBHOOK_SECRET`):

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<YOUR_DOMAIN>/api/telegram/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

Webhook endpoint:
- `POST /api/telegram/webhook`

Telegram commands:
- `/start` - show quick intro
- `/help` - show command help
- `/reset` - clear in-memory conversation history for the current chat
- `/connect` - generate one-time link to connect wallet via Privy login
- `/wallet` - view the currently bound wallet
- `/disconnect` - unlink wallet from current Telegram chat
