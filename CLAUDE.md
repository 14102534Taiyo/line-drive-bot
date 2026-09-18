# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies
- `npm start` — run the bot (`node index.js`), listens on `PORT` (default 3000)
- `node -c index.js` — syntax check (there is no test suite or linter configured)
- `node get-google-token.js` — one-time interactive script that mints the bot-owner's `GOOGLE_OAUTH_REFRESH_TOKEN` (spins up a local server on port 53682, prints a Google consent URL, exchanges the resulting code)

There is no build step; `index.js` is the entire application. Local testing requires either `ngrok` (to expose `localhost` for LINE's webhook) or deploying to Render, since LINE won't call `localhost` directly.

## Architecture

Everything lives in one file, `index.js`, an Express app with a single LINE Messaging API webhook (`POST /webhook`) plus a handful of auxiliary HTTP routes. State is not kept in a database — a single Google Sheet (`GOOGLE_SHEET_ID`) is used as the datastore, split across three tabs, each with its own hardcoded range constant:

- **`ชีต1`** (`SHEET_RANGE`) — appointments created via `/นัด`: `[groupId, eventTimeIso, label, remindersSent]`, where `remindersSent` is a comma-separated list of `REMINDER_LEVELS` codes (`7d`, `1d`, `1h`, `5m`) already fired for that row, not a single boolean — `checkReminders()` sends whichever configured levels are newly due each run, so a missed check (e.g. the dyno was asleep) still catches up on every level that's now overdue instead of sending just one reminder. Note the tab name is the Thai-locale default for "Sheet1"; if a spreadsheet was created under an English-locale account the tab will actually be named `Sheet1` and `SHEET_NAME` must be updated to match, or every Sheets call on this tab fails with "Unable to parse range".
- **`DriveConfig`** — per-group Drive OAuth mapping for the multi-user feature: `[groupId, refreshToken, folderId]`. Created automatically on boot by `ensureDriveConfigSheet()` if missing.
- **`ChatLog`** — buffered chat history for the daily summary feature: `[groupId, timestamp, senderName, messageType, text]`. Created automatically by `ensureChatLogSheet()`.

### Two separate Google auth flows (this is the main non-obvious thing)

Service accounts have no Drive storage quota of their own, so a service account can create rows in a Sheet (editing something a human already owns) but cannot upload new files to Drive (`storageQuotaExceeded`). Because of that, this codebase authenticates to Sheets and Drive completely differently:

- `sheetsAuth` — a service-account JWT (`GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`), used only for the Sheets API.
- `driveAuth` — an OAuth2 client using the bot owner's own refresh token (`GOOGLE_OAUTH_CLIENT_ID` / `SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN`, minted once via `get-google-token.js`). This is the *default* Drive used for any group that hasn't run `/setup`.
- A separate **Web application** OAuth client (`GOOGLE_OAUTH_WEB_CLIENT_ID` / `SECRET`) powers the multi-user `/setup` flow (`GET /setup` → Google consent → `GET /oauth2callback`), letting each group link its own Drive instead of the owner's.

`getDriveClientForSource()` is the resolution point: check `driveClientCache` (in-memory) → check the `DriveConfig` sheet for a per-group OAuth token → fall back to the owner's default Drive with an auto-created per-group subfolder (`getOrCreateGroupFolder()`, named after the LINE group's real display name via `getGroupSummary`, cached in `groupFolderCache`).

### Chat log buffering

Every incoming message (any type) is pushed into an in-memory `chatLogBuffer` array by `logChatMessage()`. A `setInterval` flushes it to the `ChatLog` sheet every 30s as a single batched `append` call (and skips entirely if the buffer is empty) — this exists specifically to avoid burning through the Sheets API's per-minute write quota on a fast-moving group chat. `GET /cron/daily-summary` also flushes the buffer first before reading, so nothing in flight is missed.

### Why `/cron/daily-summary` is a route and not just a timer

Render's free tier suspends the whole Node process when idle, which kills in-process `setInterval` timers (this also affects `checkReminders`, the appointment-reminder loop, to a lesser degree — it only misfires if the process happens to be asleep at the exact reminder time). The daily summary is instead triggered by an **external** cron service (cron-job.org) hitting `GET /cron/daily-summary?secret=<CRON_SECRET>` once a day — the incoming HTTP request itself wakes the dyno if it was asleep. The route groups buffered `ChatLog` rows by `groupId` and summarizes every group **concurrently** (`Promise.all`), calling Gemini (`summarizeChat()`, with a 20s-per-attempt timeout via `AbortSignal.timeout` and retry on 503/429/network errors) to produce a Thai summary organized by topic, then pushes the result to that group only (groups with no messages are skipped since they never appear in the map). The whole `ChatLog` sheet is only cleared if **every** group's summarization succeeded — if any group errors out, nothing is cleared, so that day's chat history survives to be retried on the next cron run instead of being silently lost.

`summarizeChat()` explicitly tells Gemini today's date (Bangkok time) in the prompt so it can resolve relative references like "พรุ่งนี้" into an actual calendar date in the output — without that, the model has no reference point for "today".

### Timezone handling

There's no timezone library. Bangkok is treated as a fixed UTC+7 offset (`BANGKOK_UTC_OFFSET_HOURS`, correct since Thailand has no DST) in both `parseAppointment()` (converts the `/นัด` command's local time into a UTC epoch) and `formatBangkokDateTime()` (the inverse, for display).

### Chat commands (text messages only)

- `/setup` — replies with a personalized link (`buildSetupUrl`) to start the multi-user Drive OAuth flow for that group/user.
- `/นัด DDMMYYYY HH.MM <label>` — strict regex format (`APPOINTMENT_COMMAND`); an unrecognized `/นัด...` prefix now replies with a usage hint rather than failing silently.

Everything else falls through `handleEvent()` untouched (still logged to `ChatLog`, but no reply).

## Deployment

Deployed on Render (free tier) from this GitHub repo via auto-deploy on push to `main`. `BASE_URL` must exactly match the live Render URL — it's used to build the `/oauth2callback` redirect URI and the `/setup` links sent into chat. Environment variables must be kept in sync manually between local `.env` and Render's dashboard; `.env.example` lists every key that's needed. See `README.md` for the full first-time setup walkthrough (LINE channel, Google Cloud project/OAuth consent screen, Render, cron-job.org).
