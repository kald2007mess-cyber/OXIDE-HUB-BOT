# OXIDE HUB — Telegram Mini App

This repository contains the OXIDE HUB user interface, its Cloudflare Pages Functions, and a Telegram bot entry point.

## Cloudflare Pages setup

1. Connect this repository to Cloudflare Pages. Use the repository root as the project root; no framework build command is required.
2. In **Settings → Functions → D1 database bindings**, bind the existing D1 database as **DB**.
3. Add these variables/secrets to the Pages project (Production and Preview as appropriate):
   - `TELEGRAM_BOT_TOKEN` — bot token from BotFather (secret).
   - `SESSION_SECRET` — a long random secret used to sign visitor cookies (secret).
   - `TELEGRAM_WEBHOOK_SECRET` — a separate random secret for Telegram webhook verification (secret).
   - `TELEGRAM_WEBAPP_URL` — the deployed HTTPS URL of this Pages app, without a trailing slash.
   - `TELEGRAM_ADMIN_ID` — optional; defaults to the owner ID configured for the first launch.
4. Redeploy after adding bindings and variables.

## Telegram bot webhook

After deployment, set the webhook to:

`https://YOUR-PAGES-DOMAIN/api/telegram-webhook`

Use Telegram's `setWebhook` method with the same value as `TELEGRAM_WEBHOOK_SECRET` in the `secret_token` parameter. Keep the bot token and webhook secret private.

The bot's `/start` menu shows **🚀 فتح البوت** to everyone. **🔐 لوحة التحكم** is shown only to the owner or an active deputy. The admin API independently verifies Telegram Mini App `initData`; hiding the button is not the security boundary.

## Identity and rewards

The user app verifies Telegram Mini App `initData` server-side before creating the visitor session. The Telegram account maps consistently to a stable OXIDE visitor UUID. Existing reward redemption still requires the user's own UUID.

## Important

- The original repository is not modified.
- The original space background is temporarily loaded from the currently published original site, so it remains visually identical without copying its binary file.
- This project is not live until the Cloudflare Pages deployment, D1 binding, environment secrets, and Telegram webhook are configured.
