# TelePilot Lite

Telegram-first posting controller deployed on Railway.

## Production entrypoints

- `startup.js` — starts the app and updates the Telegram bot profile description.
- `app.js` — multi-user control bot, per-user settings/session state, posting scheduler and activity tracking.
- `connect-server.js` — HTTPS account-connection flow for Telegram user authorization.

`npm start` runs `node startup.js`.

## Persistent data

Runtime data is stored outside the repository under the Railway volume mounted at `/data`.

Each control-bot user is isolated under:

`/data/users/<telegram_user_id>/`

This contains that user's settings and Teleproto session storage. Telegram login codes and 2-step-verification passwords are handled only during the live login flow and are not written to the settings file.

## Required environment variables

- `BOT_TOKEN`
- `API_ID`
- `API_HASH`

Optional:

- `PUBLIC_URL`
- `DATA_DIR` (defaults to `/data`)
- `PORT` (provided by Railway in production)

Do not commit credentials or `/data` session contents to this repository.

## Posting scope

TelePilot is intended for manually configured groups/channels where the connected Telegram account is already authorized to post. It does not discover, scrape, or auto-join destinations.
