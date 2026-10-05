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

- **`ชีต1`** (`SHEET_RANGE`) — appointments created via `/นัด`: `[groupId, eventTimeIso, label, remindersSent]`, where `remindersSent` is a comma-separated list of `REMINDER_LEVELS` codes (`7d`, `3d`, `1d`, `1h`) already handled for that row, not a single boolean (older rows may hold a legacy `FALSE`, which is harmless) — see "Reminders and the LINE quota" below. Note the tab name is the Thai-locale default for "Sheet1"; if a spreadsheet was created under an English-locale account the tab will actually be named `Sheet1` and `SHEET_NAME` must be updated to match, or every Sheets call on this tab fails with "Unable to parse range".
- **`DriveConfig`** — per-group Drive OAuth mapping for the multi-user feature: `[groupId, refreshToken, folderId]`. Created automatically on boot by `ensureDriveConfigSheet()` if missing.
- **`ChatLog`** — full chat history, retained on a rolling **30-day window** (`CHAT_LOG_RETENTION_MS`, pruned by `pruneOldChatLog()`): `[groupId, timestamp, senderName, messageType, text]`. Created automatically by `ensureChatLogSheet()`. This is now a persistent log, not a queue — see "Chat log buffering" below for why it's never wiped on summarize.
- **`SummaryState`** — one row per group, `[groupId, lastSummarizedAt]`, a watermark tracking how far summarization has progressed for that group. Created automatically by `ensureSummaryStateSheet()`.

### Two separate Google auth flows (this is the main non-obvious thing)

Service accounts have no Drive storage quota of their own, so a service account can create rows in a Sheet (editing something a human already owns) but cannot upload new files to Drive (`storageQuotaExceeded`). Because of that, this codebase authenticates to Sheets and Drive completely differently:

- `sheetsAuth` — a service-account JWT (`GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`), used only for the Sheets API.
- `driveAuth` — an OAuth2 client using the bot owner's own refresh token (`GOOGLE_OAUTH_CLIENT_ID` / `SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN`, minted once via `get-google-token.js`). This is the *default* Drive used for any group that hasn't run `/setup`.
- A separate **Web application** OAuth client (`GOOGLE_OAUTH_WEB_CLIENT_ID` / `SECRET`) powers the multi-user `/setup` flow (`GET /setup` → Google consent → `GET /oauth2callback`), letting each group link its own Drive instead of the owner's.

`getDriveClientForSource()` is the resolution point: check `driveClientCache` (in-memory) → check the `DriveConfig` sheet for a per-group OAuth token → fall back to the owner's default Drive with an auto-created per-group subfolder (`getOrCreateGroupFolder()`, named after the LINE group's real display name via `getGroupSummary`, cached in `groupFolderCache`).

### Chat log buffering

Every incoming message (any type) is pushed into an in-memory `chatLogBuffer` array by `logChatMessage()`. A `setInterval` flushes it to the `ChatLog` sheet every 30s as a single batched `append` call (and skips entirely if the buffer is empty) — this exists specifically to avoid burning through the Sheets API's per-minute write quota on a fast-moving group chat. `/สรุป` and the daily maintenance route also flush the buffer first before reading, so nothing in flight is missed.

**Do not call Gemini from this flush path.** An earlier version ran appointment detection here on every 30s flush and blew through the Gemini free tier's **20 requests/day** (per-project, not per-minute — easy to miss) inside a single 10-minute conversation. All Gemini calls now happen only behind an explicit user command (`/สรุป` via `summarizeGroupSinceLastRun`, `/ถาม` via `answerQuestion`) — see below.

### Summarization uses a watermark, not deletion (important: don't reintroduce clearing)

`ChatLog` used to be cleared after every summary run, which meant `/ถาม` (see below) had nothing to answer from once a summary had happened, and — worse — a failed Gemini call could still wipe the day's chat with no summary ever having been sent. It's now append-only (modulo the 30-day prune). `summarizeGroupSinceLastRun(groupId)` (used by `/สรุป`, the only summarization path left) reads `SummaryState` for that group's `lastSummarizedAt`, filters `ChatLog` rows to `timestamp > sinceMs`, summarizes just those, then advances the watermark — it never deletes rows. Deletion only happens in `pruneOldChatLog()` (rows older than 30 days), which is independent of the watermark, so a group neglected for over a month will lose its unsummarized backlog. That's an accepted trade-off, not a bug to fix.

`sinceMs` is `Math.max(lastSummarizedAt, getStartOfTodayBangkokMs())`, not just `lastSummarizedAt` — a summary never reaches back past the start of the current Bangkok calendar day, no matter how stale the watermark is. This was a deliberate product decision (a group neglected for days should get "today's chat," not a multi-day wall of text dumped into one summary) uncovered after a 567-message, 4-day backlog kept tripping Gemini's retry budget. The skipped backlog isn't lost — it's still sitting in `ChatLog` until the 30-day prune — it's just never included in a summary once a new day has started.

It calls `summarizeAndDetectAppointments(transcript)`, a single Gemini call (JSON response mode) that returns `{summary, appointments}` together — summary and appointment detection used to be two separate Gemini calls (one per flush, see below) until that turned out to burn through the daily quota; folding them into the one call the summarize path already has to make was the fix. It explicitly tells Gemini today's date (Bangkok time) so it can resolve relative references like "พรุ่งนี้" into an actual calendar date. It goes through the shared `callGemini(requestBody)` helper (20s-per-attempt timeout via `AbortSignal.timeout`, retry on 503/429/network errors) — add new Gemini call sites through this helper rather than duplicating the retry loop, and think hard before adding any Gemini call that isn't gated behind an explicit user action, given the 20/day ceiling.

### Render sleep, the keep-alive ping and the maintenance route

Render's free tier suspends the whole Node process after ~15 idle minutes, which kills in-process `setInterval` timers — including `checkReminders`. Without an **external** cron (cron-job.org) hitting `GET /` every 10 minutes, reminders simply don't go out; this was the cause of a "no notifications at all" report, not a missed deploy.

`GET /cron/daily-maintenance?secret=<CRON_SECRET>` (the old path `/cron/daily-summary` is kept as an alias so an existing cron job keeps working) only flushes the buffer and calls `pruneOldChatLog()`. It used to push a daily summary into every group; that was removed on purpose because a push costs one LINE quota message per group member, every day. Don't reintroduce an automatic summary push.

### Reminders and the LINE quota

LINE counts a **push** against the monthly quota once per group member; a **reply** (using a webhook event's one-shot `replyToken`, valid ~1 minute) is free. Reminder delivery is built around that:

- Levels marked `deferrable` in `REMINDER_LEVELS` (`7d`, `3d`, `1d`) are not pushed when they fall due. `checkReminders()` (every 60s) instead records the group in the in-memory `groupsAwaitingReminderReply` set. The next non-command message in that group goes through `replyDueReminders()`, which re-reads `ชีต1` and sends everything due for the group as one reply. Only if the group stays silent for `REMINDER_REPLY_GRACE_MS` (3h) past the due time does `checkReminders()` push it.
- `1h` is not deferrable and is pushed on time.
- The set is only a hint that saves a Sheets read per chat message — it is rebuilt from the sheet on every `checkReminders()` run, so losing it on restart is harmless. Messages starting with `/` are skipped because commands spend the reply token on their own answer.
- All levels due for a row are collapsed into **one** message whose text states the actual time remaining (`formatTimeRemaining`), rather than one message per level.
- `initialRemindersSent()` pre-marks levels whose moment has already passed when a row is created (`/นัด`, `/ยืนยันนัด`) or moved (`/เลื่อนนัด`), so an appointment made two days ahead doesn't immediately fire the 7d/3d reminders.
- Each row's push is wrapped in its own try/catch so one failing group doesn't block the rows after it.

### `/ถาม` (Q&A over chat history)

`answerQuestion(groupId, question)` reads that group's full `ChatLog` (up to 30 days) plus its rows from `ชีต1`, stuffs both as context into a single Gemini prompt, and asks it to answer only from that context (told explicitly to say so if the answer isn't in there — don't let it fall back on general knowledge). This is plain context-stuffing, not RAG/embeddings — deliberately, since the data volume here is small; revisit if the chat history retention window or scale grows enough that stuffing the whole thing into one prompt stops being viable.

### Appointment auto-detection

`appointments` is the second field `summarizeAndDetectAppointments()` returns alongside the summary — same Gemini call, no extra request. It only ever sees whatever a `/สรุป` call summarized, so it reacts on the same cadence as summarization, not per-message. `announcePendingAppointments(groupId, appointments)` is what actually surfaces a detection: a match is **never saved automatically** — it's stashed in the in-memory `pendingAppointments` map (`groupId -> {label, eventTimeMs}`, lost on restart, one pending suggestion per group at a time) and announced in the group; a human must type `/ยืนยันนัด` to actually write it into `ชีต1` (same shape as a manual `/นัด`). This confirm-first behavior was a deliberate choice over auto-saving, to keep false positives from silently creating reminders.

### Timezone handling

There's no timezone library. Bangkok is treated as a fixed UTC+7 offset (`BANGKOK_UTC_OFFSET_HOURS`, correct since Thailand has no DST) in both `parseAppointment()` (converts the `/นัด` command's local time into a UTC epoch) and `formatBangkokDateTime()` (the inverse, for display).

### Chat commands (text messages only)

- `/setup` — replies with a personalized link (`buildSetupUrl`) to start the multi-user Drive OAuth flow for that group/user.
- `/นัด DDMMYYYY HH.MM <label>` — strict regex format (`APPOINTMENT_COMMAND`); an unrecognized `/นัด...` prefix now replies with a usage hint rather than failing silently.
- `/สรุป` — summarizes the calling group's new messages (`summarizeGroupSinceLastRun`).
- `/ถาม <question>` — answers from that group's chat history + appointments (`answerQuestion`).

Both `/สรุป` and `/ถาม` send their result through `replyOrPush()`: LINE reply messages are free while pushes count against the monthly quota once per group member, so the reply token is tried first and a push is only the fallback for when the Gemini call outlived the token (~1 minute). Don't spend the reply token on a "please wait" placeholder — that forces the real answer onto the paid push path. Appointment-detection announcements and the non-deferred reminders have no reply token to use and are pushes.
- `/ยืนยันนัด` — confirms whatever's currently in `pendingAppointments` for that group (see "Appointment auto-detection") and writes it to `ชีต1`.
- `/นัดทั้งหมด`, `/ยกเลิกนัด <n>`, `/เลื่อนนัด <n> DDMMYYYY HH.MM` — manage existing appointments via `getGroupAppointments(groupId)`, which reads `ชีต1`, keeps only that group's future rows, and sorts by `eventTimeMs`. That sort order **is** the numbering `<n>` refers to — there's no session state, so the same query always produces the same numbering as long as nothing changed in between. Cancel deletes the row outright (`spreadsheets.batchUpdate` `deleteDimension`, via `getAppointmentSheetId()` which caches `ชีต1`'s numeric sheetId); reschedule overwrites `eventTimeIso` in place and resets `remindersSent` via `initialRemindersSent()` so every level still ahead of the new time fires again.

Everything else falls through `handleEvent()` untouched (still logged to `ChatLog`, but no reply).

## Deployment

Deployed on Render (free tier) from this GitHub repo via auto-deploy on push to `main`. `BASE_URL` must exactly match the live Render URL — it's used to build the `/oauth2callback` redirect URI and the `/setup` links sent into chat. Environment variables must be kept in sync manually between local `.env` and Render's dashboard; `.env.example` lists every key that's needed. See `README.md` for the full first-time setup walkthrough (LINE channel, Google Cloud project/OAuth consent screen, Render, cron-job.org).
