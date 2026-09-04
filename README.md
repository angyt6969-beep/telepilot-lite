# TelePilot Lite

Telegram-first posting controller deployed on Railway.

## Current mode

TelePilot uses access keys and supports two posting identities:

- **Bot posting** — `@TelePilottBot` sends scheduled messages.
- **Personal account posting** — an authorized user can optionally connect a personal Telegram account and TelePilot sends through that account.

Personal-account connection is initiated from the bot. The phone number is deleted from the bot chat after it is used to request a login code. The Telegram login code and 2FA password are entered only on TelePilot's short-lived HTTPS connection page and are not sent as bot chat messages.

## Production entrypoints

- `startup.js` — updates the Telegram bot profile description and starts the app.
- `app.js` — access keys, multi-user state, account connection, destination management, scheduler, posting and health/web endpoints.

`npm start` runs `node startup.js`.

## Persistent data

Runtime data is stored outside the repository under the Railway volume mounted at `/data`.

Each bot user is isolated under:

`/data/users/<telegram_user_id>/`

Settings are stored in `settings.json`. Personal Telegram sessions are stored encrypted in `personal-session.enc`. The encryption key is generated once and stored with restrictive permissions on the same persistent Railway volume.

Access keys are stored under `/data/access-keys.json`; only hashes of redeemable keys are persisted.

## Required environment variables

- `BOT_TOKEN`
- `API_ID`
- `API_HASH`

Railway supplies `RAILWAY_PUBLIC_DOMAIN` and `PORT`. `PUBLIC_URL` can be set explicitly if needed.

Optional:

- `DATA_DIR` (defaults to `/data`)
- `PUBLIC_URL`

Do not commit credentials, access-key data, or `/data` session contents to the repository.

## Posting scope

TelePilot is intended for manually configured groups/channels where the user is authorized to post. It does not discover, scrape, auto-join, or mass-message users.
