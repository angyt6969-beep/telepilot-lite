# TelePilot Lite

Telegram-first posting controller deployed on Railway.

## Current mode

TelePilot uses access keys and supports two posting identities:

- **Bot posting** — `@TelePilottBot` sends scheduled messages.
- **Personal account posting** — an authorized user can optionally connect a personal Telegram account and TelePilot sends through that account.

Personal-account connection is initiated from the bot. The phone number is deleted from the bot chat after it is used to request a login code. The Telegram login code and 2FA password are entered only on TelePilot's short-lived HTTPS connection page and are not sent as bot chat messages.

## Trust, privacy and support

TelePilot exposes branded public pages at `/privacy`, `/terms`, and `/support`. The secure connection page links to those pages and identifies the public Telegram support contact as `@noahxrp` by default.

Users can open `/support` or use the Support button in Tools to create a support case for login, posting, access-key, security, privacy/data, or other issues. Cases receive a `TP-SUP-...` diagnostic ID and store only a limited safe diagnostic summary. Login codes, 2FA passwords, raw Telegram sessions, API secrets, bot tokens and full access keys are not intentionally attached to support cases.

Admins have a Support Cases entry in the Admin Panel. They can review cases, reply through TelePilot, resolve cases, and process explicitly requested data deletion through a second confirmation step. User deletion removes the user's TelePilot directory and stored personal-account session, removes their Telegram ID from key ownership fields, and strips report contents from support cases. Limited audit/security records may remain where needed for service integrity.

Support case data is stored under `/data/support-cases.json`. A one-way deletion marker is stored under `/data/deleted-users.json` to stop an already-deleted in-memory account from continuing to use stale controls until the service lifecycle naturally clears it.

## Admin controls

Authorized TelePilot admins have an admin-only control panel in the Telegram dashboard and can also open it with `/admin`.

The panel provides customer/access management, access-key generation and revocation, active-post controls, expiring-access views, statistics, announcements, support cases, an audit log, and security/session controls. Existing `/genkey`, `/keys`, and `/revoke` commands remain available as shortcuts.

TelePilot does not impose an application-level maximum on the number of saved destinations. Large destination lists are paginated/truncated only for Telegram UI display, while the full saved list remains available for posting and management.

## Production entrypoints

- `startup.js` — installs the branded web/support layers, updates the Telegram bot profile description and starts the app.
- `app.js` — access keys, multi-user state, account connection, destination management, scheduler, posting, admin controls and health/web endpoints.
- `legal-pages.js` — Privacy Policy, Terms of Service, Support page, and trust links for the connection flow.
- `support-center.js` — support cases, safe diagnostics, admin replies and data-deletion requests.
- `support-ui.js` — Support entry points in Tools and the Admin Panel.

`npm start` runs `node startup.js`.

## Persistent data

Runtime data is stored outside the repository under the Railway volume mounted at `/data`.

Each bot user is isolated under:

`/data/users/<telegram_user_id>/`

Settings are stored in `settings.json`. Personal Telegram sessions are stored encrypted in `personal-session.enc` using AES-256-GCM. Current hardened deployments support a 32-byte master key supplied separately through `TELEPILOT_SESSION_KEY_B64`, keeping the primary session-encryption key outside the user/session files on the persistent volume. Legacy on-volume key material remains supported only for migration of older stored sessions.

Access keys are stored under `/data/access-keys.json`; only protected hashes of redeemable keys are persisted. Admin audit events are stored under `/data/admin-events.jsonl`, and security events under `/data/security-events.jsonl`.

## Required environment variables

- `BOT_TOKEN`
- `API_ID`
- `API_HASH`
- `TELEPILOT_SECURITY_SECRET` in hardened production deployments

Railway supplies `RAILWAY_PUBLIC_DOMAIN` and `PORT`. `PUBLIC_URL` can be set explicitly if needed.

Recommended production variables:

- `TELEPILOT_SESSION_KEY_B64` — base64-encoded 32-byte session-encryption master key
- `TELEPILOT_SUPPORT_USERNAME` — public Telegram support username; defaults to `noahxrp`

Optional:

- `DATA_DIR` (defaults to `/data`)
- `PUBLIC_URL`
- `TELEPILOT_ADMIN_ID` / `OWNER_ID` for explicit admin IDs; existing persisted admin IDs are also supported by the application

Do not commit credentials, access-key data, support databases, or `/data` session contents to the repository.

## Posting scope

TelePilot is intended for manually configured groups/channels where the user is authorized to post. It does not discover, scrape, auto-join, or mass-message users.
