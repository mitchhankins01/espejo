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
- iOS Shortcut deep-links to `prefs:root=SCREEN_TIME&path=SCREEN_TIME_SUMMARY#DAY`, semi-auto loop of 4 screenshots, share-sheet to Telegram with caption `screen_time YYYY-MM-DD`.
- Shortcut already built and tested; sample screenshots showed all 4 sections cleanly.

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

### Phase 1 — Screen Time → Telegram extractor
Validates the pipe; smallest blast radius.

- **Migration 048**: `daily_screen_time`.
- **Photo-group fix** in `src/telegram/updates.ts`: `MediaGroupBuffer` currently retains captions only and drops `photo[].file_id`. Extend to keep `photos: {fileId, caption}[]` (largest per message), and pass `photos` array on flush. Single-photo path unchanged (single photo will arrive in `photos` of length 1 via the same handler — DRY).
- **New `src/telegram/screen-time.ts`**: detects `screen_time YYYY-MM-DD` caption, runs vision over the 1–4 photos, prompts model for strict JSON matching `daily_screen_time` columns, validates with zod, upserts via `src/db/queries/daily-screen-time.ts` (`ON CONFLICT (date) DO UPDATE`). Replies with one-line confirmation to the chat.
- **Webhook routing** in `src/telegram/webhook.ts`: before existing `msg.photo` OCR branch, if caption matches the screen-time prefix, dispatch to `screen-time.ts` and return — short-circuits the agent so it doesn't see raw OCR text.
- **Idempotency**: caption date is canonical. Re-pushing same date overwrites the row.
- **Logging**: `logUsage({ source: 'telegram', surface: 'screen-time', action: 'ingest', ok, meta: { date, photo_count } })`.

### Phase 2 — ActivityWatch ingestor
Highest ongoing signal. Mirror `agent_sessions` pattern.

- **Migration 049**: `device_events`.
- **`src/ingest/activitywatch.ts`**: read `~/Library/Application Support/activitywatch/aw-server/peewee-sqlite.v2.db` (or rocksdb fallback) read-only via `better-sqlite3`; iterate per bucket (`aw-watcher-window`, `aw-watcher-web-*`, `aw-watcher-afk`); produce normalized rows.
- **`src/db/queries/device-events.ts`**: `upsertDeviceEvent`, `latestStartedAt(source, bucket)`.
- **`scripts/ingest-activity.ts`**: entrypoint that runs all activity ingestors. Args mirror `ingest-sessions.ts` (`--dry-run`, `--force`, `--since`, `--source <aw|atuin|screenpipe>`, `--skip-if-fresh 24h`). Writes one `usage_logs` summary row per run.
- **`package.json`**: `"ingest:activity": "NODE_ENV=production tsx scripts/ingest-activity.ts"`.
- **Watermark**: `MAX(started_at) WHERE source='activitywatch'`. Idempotent on `(source, source_event_id)`.
- **Backfill**: default last 7 days; `--force` for full history. AW retains months locally — keep in mind volume.
- **Privacy/redaction** (applied pre-insert):
  - Drop `title` if `app` ∈ {`1Password`, `Bitwarden`, `Keychain Access`}; keep app + duration.
  - Strip URL paths/queries for hostnames in a `SENSITIVE_HOSTS` list (banks, health portals); keep hostname only.
  - Drop events where the AW browser extension flag indicates incognito/private.

### Phase 3 — Atuin ingestor
Lowest risk; reuses `usage_logs`.

- No new table.
- **`src/ingest/atuin.ts`**: read `~/.local/share/atuin/history.db` read-only; rows → `logUsage` calls with:
  - `source: 'shell'`, `surface: hostname`, `actor: cwd`,
  - `action: command.split(/\s+/)[0]` (verb), `args: { cmd, cwd, host, exit, duration_ms, atuin_id }`,
  - `ts: atuin.timestamp` (override default), `ok: exit === 0`, `error: exit !== 0 ? String(exit) : null`,
  - `durationMs: atuin.duration / 1_000_000` (atuin stores nanoseconds).
- **Watermark**: `MAX(ts) WHERE source='shell'`. Idempotent: re-running with same `--since` re-imports duplicates only on `--force` (cheap; rows are small).
- **Backfill**: default last 30 days.
- **Privacy/redaction**: drop commands matching any of: `(?i)(api[_-]?key|token|password|secret|bearer)\s*[=:]`; truncate `cmd` at 4 KB (caps `args` payload).
- Helper: `logUsage` already exists and accepts arbitrary `meta`; we extend `LogUsageInput` to optionally accept `ts` to backdate inserted rows. Single-line addition; the existing fire-and-forget contract stays.

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
