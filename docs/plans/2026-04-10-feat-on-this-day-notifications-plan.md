---
title: "feat: Automatic On This Day Telegram Notifications"
type: feat
status: completed
date: 2026-04-10
origin: docs/brainstorms/2026-04-10-on-this-day-notifications-brainstorm.md
---

# feat: Automatic On This Day Telegram Notifications

## Overview

Automatic daily Telegram notification that surfaces journal entries from the same calendar date in prior years, synthesized by Claude into a meaningful reflection. Follows the established background timer pattern (Oura/Obsidian sync) — `setInterval` + advisory lock + error notification.

(see brainstorm: `docs/brainstorms/2026-04-10-on-this-day-notifications-brainstorm.md`)

## Problem Statement / Motivation

Day One has a "See what happened on this day in years past" notification. The user wants this in Telegram with LLM-generated narrative synthesis — not just raw entries, but themes, evolution, and connections across years. Currently, the `on_this_day` MCP tool exists but is pull-only (user must ask). This makes it push-based and automatic.

## Proposed Solution

### New file: `src/notifications/on-this-day.ts`

A background timer that:
1. Checks hourly whether it's the target hour (8am in user's timezone)
2. Queries all entries from today's MM-DD across all years
3. If entries exist, sends them to Claude for synthesis
4. Delivers the reflection as a single Telegram message
5. Records the send to prevent double-delivery

### Architecture

```
src/notifications/on-this-day.ts
├── startOnThisDayTimer(pool)          — immediate + setInterval(1h)
├── runOnThisDay(pool)                 — advisory lock + hour check + dedup
├── synthesizeReflection(entries)      — Claude API call with system prompt
└── formatEntriesForPrompt(entries)    — entries → prompt text with truncation
```

Wired into `src/transports/http.ts` alongside existing timers:
```typescript
startOnThisDayTimer(pool);  // line ~76, after existing timer starts
```

## Technical Considerations

### Dedup: Persistent State via `app_settings` Table

The codebase has `src/db/queries/settings.ts` and an `app_settings` table pattern. Store a `on_this_day_last_sent` key with today's date as value. Check before sending, update after successful send. This survives Railway deploys (unlike in-memory state).

```sql
-- Check: has today been sent?
SELECT value FROM app_settings WHERE key = 'on_this_day_last_sent';
-- Update after send
INSERT INTO app_settings (key, value) VALUES ('on_this_day_last_sent', $1)
  ON CONFLICT (key) DO UPDATE SET value = $1;
```

### Timezone Bug Fix in `getEntriesOnThisDay`

The existing query uses `EXTRACT(MONTH FROM created_at)` on raw UTC timestamps. For a user in `Europe/Madrid`, entries near midnight are misattributed. Fix:

```sql
-- Before (buggy)
WHERE EXTRACT(MONTH FROM e.created_at) = $1
  AND EXTRACT(DAY FROM e.created_at) = $2

-- After (timezone-aware)
WHERE EXTRACT(MONTH FROM e.created_at AT TIME ZONE $3) = $1
  AND EXTRACT(DAY FROM e.created_at AT TIME ZONE $3) = $2
```

This also fixes the existing `on_this_day` MCP tool. Pass `config.timezone` as the third parameter.

### Token Budget and Entry Truncation

To control costs and latency:
- Cap at **20 entries** (sorted by year, most recent first)
- Truncate each entry to **1500 words** (~2000 tokens)
- Worst case: ~40K input tokens ≈ $0.12/notification at Sonnet rates
- Typical case (3-5 entries, moderate length): ~5K tokens ≈ $0.015/notification

### Claude System Prompt

```
You are writing a morning "On This Day" reflection for a personal journal.
You'll receive journal entries from this calendar date across multiple years.

Write a 2-3 paragraph reflection in English that:
- Opens with the most striking memory or theme
- Weaves connections across years — recurring places, evolving perspectives, seasonal patterns
- Notes personal growth or change where visible
- Keeps a warm, contemplative tone — like a thoughtful friend, not a therapist
- Uses "X years ago" framing naturally (e.g., "Three years ago in Barcelona...")

Format for Telegram HTML: use <b>bold</b> for emphasis, plain line breaks.
Keep it under 300 words. Do not list entries — synthesize them.
```

### Send Window and Failure Handling

- **Window**: `currentHourInTimezone(config.timezone) === 8` (i.e., 8:00–8:59am)
- **Late starts**: If server starts after 9am and today hasn't been sent, skip. Morning ritual value is lost.
- **Claude API failure**: Do NOT mark as sent on failure. Retry on next hourly tick. If hour 8 has passed without success, skip today. Send error via `notifyError`.
- **Telegram failure**: `sendTelegramMessage` already has retry with backoff. If it ultimately fails, `notifyError` captures it.

### Advisory Lock

Lock key `9152203` (next in sequence: Oura=9152201, Obsidian=9152202). Prevents concurrent sends during blue-green deploys.

### Config

Add to `src/config.ts`:
```typescript
onThisDay: {
  enabled: !!process.env.TELEGRAM_BOT_TOKEN,
  targetHour: parseIntegerEnv("ON_THIS_DAY_HOUR", 8, 0),
},
```

No separate feature toggle — runs whenever the Telegram bot is active. Disable by setting `ON_THIS_DAY_HOUR` to `-1` (will never match `currentHourInTimezone`).

### Cost Tracking

Log API usage via existing `logApiUsage` pattern from `src/telegram/agent/costs.ts`. Track input/output tokens and model used.

### Media Handling

Entries with photos/videos: include media counts in prompt context ("Entry has 3 photos") but do not include URLs or attempt to reference visual content. Text-only reflection.

### Edge Cases

- **Feb 29**: Only shown in leap years. Entries from Feb 29 in leap years are invisible in non-leap years. Acceptable — matches Day One behavior.
- **Single entry**: Claude still synthesizes. A single entry from 5 years ago still merits "Five years ago today..." framing.
- **Empty days**: Skip silently (brainstorm decision). No noise.

## Acceptance Criteria

- [x] Background timer starts with HTTP server and checks hourly
- [x] Sends reflection at 8am (configurable via `ON_THIS_DAY_HOUR`) in user's timezone
- [x] Skips silently when no prior-year entries exist for today's date
- [x] Claude synthesizes entries into a 2-3 paragraph reflection
- [x] Never double-sends on the same date (persisted dedup via `api_usage`)
- [x] Advisory lock prevents concurrent sends across instances
- [x] Entries truncated to 1500 words each, capped at 20 entries
- [x] API usage logged for cost tracking
- [x] Errors handled gracefully: retry next tick, `notifyError` on persistent failure
- [x] `getEntriesOnThisDay` query fixed to be timezone-aware
- [x] `pnpm check` passes (types, lint, tests with coverage thresholds)

## Implementation Phases

### Phase 1: Query Fix + Config (small, standalone)

1. Fix `getEntriesOnThisDay` in `src/db/queries/entries.ts` to use `AT TIME ZONE`
2. Update `on_this_day` tool in `src/tools/on-this-day.ts` to pass timezone
3. Add `onThisDay` config section to `src/config.ts`
4. Update tests for the timezone-aware query

**Files:**
- `src/db/queries/entries.ts` — fix query
- `src/tools/on-this-day.ts` — pass timezone param
- `src/config.ts` — add `onThisDay` config
- `tests/tools/on-this-day.test.ts` — update tests

### Phase 2: Core Notification Module

1. Create `src/notifications/on-this-day.ts` with:
   - `startOnThisDayTimer(pool): NodeJS.Timeout | null`
   - `runOnThisDay(pool): Promise<void>` (advisory lock + hour check + dedup + query + synthesize + send)
   - `synthesizeReflection(entries: EntryRow[]): Promise<string>` (Claude API call)
   - `formatEntriesForPrompt(entries: EntryRow[]): string` (truncation + formatting)
2. Wire into `src/transports/http.ts`
3. Use `app_settings` for dedup state

**Files:**
- `src/notifications/on-this-day.ts` — new module
- `src/transports/http.ts` — wire timer
- `src/db/queries/settings.ts` — ensure get/set helpers exist

### Phase 3: Tests

1. Unit tests for `formatEntriesForPrompt` (truncation, ordering)
2. Unit tests for `synthesizeReflection` (mock Anthropic client)
3. Integration test for `runOnThisDay` (hour check, dedup, empty days)
4. Ensure coverage thresholds pass

**Files:**
- `tests/notifications/on-this-day.test.ts` — new test file

## Dependencies & Risks

- **Anthropic API availability**: Daily dependency on Claude API. Mitigation: retry on next tick, skip on persistent failure.
- **Cost**: ~$0.01-0.12/day depending on entry volume. Negligible for single-user.
- **Railway deploy timing**: Deploys during send window could cause brief gap. Mitigated by dedup + retry.

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-04-10-on-this-day-notifications-brainstorm.md](docs/brainstorms/2026-04-10-on-this-day-notifications-brainstorm.md) — Key decisions: LLM synthesis over raw entries, morning 8-9am delivery, skip empty days, background timer pattern.
- Timer pattern: `src/oura/sync.ts:101-111` (startOuraSyncTimer)
- On This Day query: `src/db/queries/entries.ts:290-311` (getEntriesOnThisDay)
- Telegram client: `src/telegram/client.ts:77-89` (sendTelegramMessage)
- Claude API pattern: `src/telegram/agent/constants.ts` (getAnthropic, getLlmModel)
- Date utilities: `src/utils/dates.ts` (todayInTimezone, currentHourInTimezone)
- Config: `src/config.ts:81` (config object)
- Cost tracking: `src/telegram/agent/costs.ts` (logApiUsage)
