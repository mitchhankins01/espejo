# Plan: Expanded Activity Capture for Espejo

Status: implementation plan. Capture-first; consumption (queries, agents, dashboards) is out of scope for v1.

## Goal
Richer ground truth on how Mitch spends attention — Mac, iPhone, shell — beyond Day One + Oura + Obsidian + `agent_sessions` + `usage_logs`.

## Sources

### Mac
1. **ActivityWatch + browser extension** — active app, window title, URL, page title, dwell, AFK. Local SQLite. Shape of attention.
2. **Atuin** — every shell command with cwd, exit code, duration, host. Local SQLite. Terminal work outside agent sessions.
3. **Screenpipe** — OCR'd screen content. Local SQLite. **2-week trial; kill if not queried.** Content layer ActivityWatch can't see.

### iPhone
Daily Screen Time push as part of morning ritual, for *previous* day:
- iOS Shortcut deep-links to `prefs:root=SCREEN_TIME&path=SCREEN_TIME_SUMMARY#DAY`, semi-auto loop of 4 screenshots, share-sheet to Telegram. **No caption required** — the bot detects iOS Screen Time UI from the screenshot itself and reads the date label off the screen.
- iOS share-sheet sends each screenshot as its own Telegram message (not a media group), so the four screenshots arrive as four sequential messages. The merge-on-conflict upsert (Phase 1 §Idempotency) is what makes this work — each upsert keeps the richest data per section.

Per-day fields (vision-extracted): total minutes, top categories with minutes, per-app minutes, pickup count + first-pickup time + top apps after pickup, notification count + top notifying apps. Hourly histograms ignored.

### Accepted limits
iOS sandboxes per-app real-time activity; Shortcuts can't auto-scroll Settings; granular in-app behavior on iOS unanswerable.

## Schema decisions

| Source | Lands in | Why |
|---|---|---|
| Atuin | **`usage_logs`** (reuse) | `source='shell'`, action=verb, args={cmd, cwd, host, exit, duration_ms}. Same point-in-time shape. No new table. |
| ActivityWatch | **new `device_events`** | Time-range events at hundreds/day; needs app/title/ts indexes. Built generic so future iPhone Shortcut-pushed events (focus, location, app opens) land here too. |
| Screenpipe | **new `screen_captures`** (phase 4 only) | High volume, full-text + vector retention; should not pollute lighter tables. Defer table creation until trial commits. |
| Screen Time daily | **new `daily_screen_time`** | Daily snapshot with structured arrays. `daily_metrics` is intentionally narrow `(date, weight)` — don't bloat it. |

```sql
CREATE TABLE device_events (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,                  -- 'activitywatch' | 'ios-shortcut' | future
  source_event_id TEXT NOT NULL,         -- AW event id, etc. (idempotency key)
  bucket TEXT NOT NULL,                  -- 'window' | 'web' | 'afk' | 'focus' | 'location'
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_ms INTEGER,
  app TEXT,
  title TEXT,
  url TEXT,
  hostname TEXT,
  data JSONB NOT NULL DEFAULT '{}',      -- source-specific extras
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_event_id)
);
CREATE INDEX device_events_started_idx ON device_events (started_at DESC);
CREATE INDEX device_events_app_idx     ON device_events (app, started_at DESC);
CREATE INDEX device_events_bucket_idx  ON device_events (bucket, started_at DESC);
CREATE INDEX device_events_host_idx    ON device_events (hostname) WHERE hostname IS NOT NULL;

CREATE TABLE daily_screen_time (
  date DATE PRIMARY KEY,
  total_minutes INTEGER NOT NULL,
  categories JSONB NOT NULL,             -- [{name, minutes}]
  apps JSONB NOT NULL,                   -- [{app, minutes}]
  pickups INTEGER,
  first_pickup TIME,
  pickup_apps JSONB,                     -- [{app, count}]
  notifications INTEGER,
  notification_apps JSONB,               -- [{app, count}]
  source_message_id BIGINT,              -- Telegram message id (audit)
  raw_text TEXT,                         -- vision OCR concat (for debugging)
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Phases

Build in dependency order; each phase ships independently and is exercisable in isolation.

### Phase 1 — Screen Time → Telegram extractor — **shipped 2026-05-03**
Validates the pipe; smallest blast radius.

- **Migration 048**: `daily_screen_time` (applied prod 2026-05-03).
- **Photo-group fix** in `src/telegram/updates.ts`: `MediaGroupBuffer` previously retained captions only and dropped `photo[].file_id`. Extended to keep `photos: {fileId, caption}[]` (largest per message), and pass `photos` array on flush. Single-photo path unchanged — single photo arrives in `photos` of length 1 via the same handler. (Note: iOS share-sheet ends up sending each screenshot as its own message anyway, so the media-group buffer mostly applies when other clients send a true multi-photo album.)
- **New `src/telegram/screen-time.ts`**: vision call (`gpt-4.1`, JSON mode) inspects the photos and returns `{ is_screen_time, date, total_minutes, categories, apps, pickups, first_pickup, pickup_apps, notifications, notification_apps }`. Today's date is woven into the prompt so the model can resolve relative date phrases ("Ayer, 2 de mayo" → `2026-05-02`). Schema validated with zod. On `is_screen_time: true && date != null`, upserts via `src/db/queries/daily-screen-time.ts`. Replies with one-line confirmation reflecting the **merged** post-upsert row.
- **Webhook routing** in `src/telegram/webhook.ts`: any photo message runs `processScreenTimePhotos` first. If `result.isScreenTime` → short-circuit (the agent never sees the screenshot). Otherwise → fall through to the existing OCR + agent path. **No caption required.**
- **Idempotency / merge**: `ON CONFLICT (date) DO UPDATE` merges per-section instead of overwriting. Each iOS Screen Time screenshot only covers one section (totals, app breakdown, pickups, notifications), so the four photos arrive as four upserts and each must accumulate without clobbering the prior. Rules:
  - `total_minutes = GREATEST(existing, incoming)`
  - `pickups`, `first_pickup`, `notifications` = `COALESCE(incoming, existing)`
  - `categories`, `apps`, `pickup_apps`, `notification_apps` = whichever array is longer (so a per-app screenshot replaces a section that arrived empty)
  - `source_message_id`, `raw_text`, `ingested_at` = always latest
- **Logging**: `logUsage({ source: 'telegram', surface: 'screen-time', action, ok, meta })` where `action ∈ { 'detect', 'ingest' }` — `detect` fires for every photo (including non-Screen-Time fall-throughs), `ingest` fires once we commit to writing the row.

### Phase 2 — ActivityWatch ingestor — **shipped 2026-05-03**
Highest ongoing signal. Mirror `agent_sessions` pattern.

- **Migration 049**: `device_events` (applied prod 2026-05-03).
- **`src/ingest/activitywatch.ts`**: read `~/Library/Application Support/activitywatch/aw-server/peewee-sqlite.v2.db` read-only via `better-sqlite3`; iterate per bucket (`aw-watcher-window`, `aw-watcher-web-*`, `aw-watcher-afk`); produce normalized rows.
- **`src/db/queries/device-events.ts`**: `upsertDeviceEvent`, `upsertDeviceEvents` (transactional batch), `latestStartedAt(source, bucket?)`, `latestDeviceEventIngestedAt`.
- **`scripts/ingest-activity.ts`**: entrypoint that runs all activity ingestors. Args mirror `ingest-sessions.ts` (`--dry-run`, `--force`, `--since`, `--source <aw|atuin|screenpipe>`, `--skip-if-fresh 24h`). Chunks upserts at 500. Writes one `usage_logs` summary row per run.
- **`package.json`**: `"ingest:activity": "NODE_ENV=production tsx scripts/ingest-activity.ts"`.
- **Watermark**: `MAX(started_at) WHERE source='activitywatch'`. Idempotent on `(source, source_event_id)`.
- **Backfill**: default last 7 days; `--force` for full history. AW retains months locally — keep in mind volume.
- **Privacy/redaction** (applied pre-insert):
  - Drop `title` if `app` ∈ {`1Password`, `Bitwarden`, `Keychain Access`}; keep app + duration.
  - Strip URL paths/queries for hostnames in a `SENSITIVE_HOSTS` list (banks, health portals); keep hostname only.
  - Drop events where the AW browser extension flag indicates incognito/private.
- **AW install**: `brew install --cask activitywatch` for the desktop app (bundles `aw-server`, `aw-watcher-window`, `aw-watcher-afk`). Web watcher is a separate browser extension that has to be installed per-browser:
  - Chrome: https://chrome.google.com/webstore/detail/activitywatch-web-watcher/nglaklhklhcoonedhgnpgddginnjdadi (installed 2026-05-03)
  - Firefox: https://addons.mozilla.org/firefox/addon/aw-watcher-web/
  - Safari: not supported (extension model blocks the polling pattern); window-watcher still records "Safari — <page title>" without per-tab URL.
- **Peewee schema gotchas** (locked in by tests in `tests/ingest/activitywatch.test.ts` after both bit me on the live DB):
  - `bucketmodel.key` is the INTEGER PK; `bucketmodel.id` is the string bucket name (e.g. `aw-watcher-window_<host>`). Aliasing in the SELECT is required.
  - peewee writes timestamps with a space separator (`2026-05-03 13:54:45.753000+00:00`), not a `T`. A naive `timestamp > ?` against an ISO-`T` string silently drops everything (space 0x20 < `T` 0x54). Use `datetime(timestamp) > datetime(?)`.
- **Auxiliary watchers — explicitly out of scope for v1** (capture-first, see top of spec):
  - `aw-watcher-input` (keyboard/mouse intensity beyond AFK) — possibly worth adding once we have any consumer at all; revisit after Phase 3/4.
  - `aw-watcher-vscode`, `aw-watcher-jetbrains` — skip; `agent_sessions` already covers IDE work in finer grain.
  - `aw-watcher-obsidian` (community) — skip; window-watcher titles + Obsidian sync already cover the same ground.

### Phase 3 — Atuin ingestor — **shipped 2026-05-03**
Lowest risk; reuses `usage_logs`.

- No new table.
- **`src/ingest/atuin.ts`**: read `~/.local/share/atuin/history.db` read-only via `better-sqlite3`. Returns `AtuinShellRow[]` for the entrypoint to insert.
- **`src/db/queries/usage.ts`**: `LogUsageInput` gained `ts?: Date`; `logUsage` keeps its fire-and-forget contract. Two new awaitable helpers for backfill — `bulkInsertUsageLogs` (multi-row INSERT with ts on each row) and `latestUsageLogTs(source)` (watermark). `UsageSource` gained `'shell'`.
- **`scripts/ingest-activity.ts`**: `ingestAtuin()` mirrors `ingestActivityWatch()`. Each row maps to:
  - `source: 'shell'`, `surface: hostname`, `actor: cwd`,
  - `action: command.split(/\s+/)[0]` (verb), `args: { cmd, cwd, host, exit, duration_ms, atuin_id, session }`,
  - `ts: atuin.timestamp / 1_000_000` (atuin stores ns since epoch),
  - `ok: exit <= 0`, `error: exit > 0 ? String(exit) : null`,
  - `durationMs: max(0, atuin.duration / 1_000_000)`.
- **Watermark**: `latestUsageLogTs(pool, 'shell')`. Idempotent on re-run; `--force` widens the window and may insert duplicates (cheap; rows are small).
- **Backfill**: default last 30 days.
- **`exit = -1` is atuin's "unknown" sentinel**, not "command failed". Imported zsh history (which has no recorded exits) all comes in as `-1`. Treating `-1` as a failure would dominate every `WHERE NOT ok` query for a month after the import — so the script maps `exit <= 0` to `ok=true` and only sets `error` for positive exits. Bucket counts split into `ok` / `unknown` / `fail` for visibility.
- **Privacy/redaction** (in `src/ingest/atuin.ts`): drop the row when `command` matches `(api[_-]?key|token|password|secret|bearer)\s*[=:]/i`; drop tombstoned rows (`deleted_at IS NOT NULL`); truncate `cmd` at 4 KB (caps `args` payload). The redaction is conservative-cheap, not exhaustive — e.g. `Authorization: Bearer <tok>` doesn't match the regex (no `=`/`:` after `bearer`); accepted.
- **`--skip-if-fresh` upgrade**: previously keyed off `latestDeviceEventIngestedAt` (AW's last event). Now keyed off the script's own most recent successful summary row in `usage_logs (source='script', surface='ingest-activity', ok=true)`, with the AW path as a legacy fallback. This way `--skip-if-fresh 24h` covers both sources, including the case where AW isn't installed.
- **Atuin install flow**:
  - `brew install atuin`.
  - `eval "$(atuin init zsh --disable-up-arrow)"` appended to `~/.zshrc`. `--disable-up-arrow` keeps Up doing zsh's classic history; Ctrl-R is atuin's TUI.
  - `atuin import zsh` to backfill `history.db` from `~/.zsh_history`. Imported rows all carry `exit=-1` (no exit captured); see sentinel handling above.
  - No sync server — local SQLite only.

### Phase 4 — Screenpipe ingestor (trial)
Deferred. Build only after phases 1–3 are stable. Trial clock starts on day Screenpipe is first ingested; if no SQL queries hit `screen_captures` in 14 days, drop the table and uninstall.

- **Migration 050** (only at start of trial): `screen_captures (id, started_at, ended_at, app, window, ocr_text, audio_text, embedding vector(1536), data jsonb)` + tsvector on `ocr_text` + ivfflat on embedding.
- **`src/ingest/screenpipe.ts`**: read Screenpipe SQLite; chunk OCR text per (app, window, ~30s); embed via `text-embedding-3-small`; upsert.
- **Retention**: 14 days raw OCR + audio; after that, keep only embeddings + 200-char excerpt. Implement as a daily prune query; trigger from `ingest-activity.ts` post-ingest.
- **Privacy**: same SENSITIVE_HOSTS / sensitive-app drop list as ActivityWatch; drop captures where active app ∈ password manager set.
- **Kill switch**: deleting the table + removing from `migrate.ts` + uninstalling Screenpipe is the rollback. No code in `src/` outside `ingest/` depends on it.

## Auto-trigger via AGENTS.md

Append to the existing "Session Init" block at the top of CLAUDE.md/AGENTS.md:

```bash
pnpm ingest:sessions --skip-if-fresh 24h
pnpm ingest:activity --skip-if-fresh 24h
```

Both no-op when fresh; first run after a day picks up any deltas.

## File layout

```
scripts/
  ingest-activity.ts                 — phase-2 entrypoint, dispatches per --source
src/ingest/
  activitywatch.ts                   — phase 2
  atuin.ts                           — phase 3
  screenpipe.ts                      — phase 4
src/db/queries/
  device-events.ts                   — phase 2 (upsert, latestStartedAt)
  daily-screen-time.ts               — phase 1 (upsert)
  usage.ts                           — phase 3 adds optional `ts` to LogUsageInput
src/telegram/
  screen-time.ts                     — phase 1
  updates.ts                         — phase 1 patches MediaGroupBuffer
  webhook.ts                         — phase 1 adds caption-prefix dispatch
specs/schema.sql                     — append phase-1 + phase-2 tables
scripts/migrate.ts                   — append migrations 048, 049, (later) 050
```

## Out of scope (v1)

- Queries, agent prompts, dashboards over the new tables. Capture-first.
- Cross-source joining (e.g. correlating ActivityWatch focus with `agent_sessions`). Decide after we see what data looks like in the wild.
- Embedding window titles or shell commands.
- iPhone push beyond Screen Time (Shortcuts events into `device_events` is allowed by schema but not built in v1).
- Auto-purge / tiered retention beyond Screenpipe's 14-day prune.

## Reference patterns

- Sessions ingestor (mirror this): `scripts/ingest-sessions.ts` + `specs/agent-sessions-ingestor.md`.
- Usage log envelope: `src/db/queries/usage.ts` + CLAUDE.md "Universal usage log".
- Vision OCR: `src/telegram/media.ts` (`extractTextFromImageBuffer`).
- Periodic-ingest pattern: `src/obsidian/sync.ts`.
