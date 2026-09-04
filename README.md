# TelePilot Lite

Telegram-first scheduled posting bot deployed on Railway.

## Production entrypoints

- `startup.js` — updates the Telegram bot profile description and starts the app.
- `app.js` — key-gated multi-user control bot, per-user settings, posting scheduler, destination verification and activity tracking.

`npm start` runs `node startup.js`.

## How posting works

TelePilot no longer logs into customers' personal Telegram accounts.

A customer redeems an access key, adds `@TelePilottBot` as an admin in each authorized group/channel, saves a message and interval, then TelePilot posts as the bot account.

When a destination is added, TelePilot verifies that:

- `@TelePilottBot` is an administrator there.
- the customer adding it is also an administrator there.
- channels grant TelePilot permission to post messages.

Private groups can be linked with `/addhere` from inside the group by an administrator who has active TelePilot access.

## Access keys

Access keys are single-use and stored only as SHA-256 hashes in `/data/access-keys.json`. The plaintext key is shown once when generated.

Owner-only bot commands:

- `/genkey 30`
- `/genkey 90`
- `/genkey lifetime`
- `/keys`
- `/revoke <key or key ID>`

The owner/admin identity is loaded from `TELEPILOT_ADMIN_ID` or `OWNER_ID` when set, and can also be recovered from the legacy TelePilot owner data on the Railway volume.

## Persistent data

Runtime data is stored on the Railway volume mounted at `/data`.

Per-user settings are stored under:

`/data/users/<telegram_user_id>/settings.json`

Access-key metadata is stored at:

`/data/access-keys.json`

No customer Telegram login codes, 2FA passwords, MTProto auth keys or personal Telegram sessions are used by the current architecture.

## Required environment variables

- `BOT_TOKEN`

Optional:

- `TELEPILOT_ADMIN_ID`
- `OWNER_ID`
- `DATA_DIR` (defaults to `/data`)
- `PORT` (provided by Railway in production)

Legacy `API_ID` and `API_HASH` variables are no longer used and can be removed from Railway.

## Posting scope

TelePilot is intended only for groups/channels where both the customer and the bot are administrators. It does not discover, scrape, auto-join or send unsolicited direct messages.
