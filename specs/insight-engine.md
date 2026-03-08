# Insight Engine — Background Dot-Connecting Worker

## Status: Implemented

## What

Background worker that scans data (entries, Oura biometrics, todos) and surfaces non-obvious connections via Telegram notifications. Runs on a daily timer with advisory lock, dedup, and daily cap.

## Architecture

```
src/insights/
    engine.ts       — Timer (setInterval), advisory lock, run loop, dedup, throttle, notify
    analyzers.ts    — Pure analysis functions (one per insight type)
    formatters.ts   — InsightCandidate → Telegram HTML
```

Follows `src/oura/sync.ts` pattern: `setInterval` + `pg_try_advisory_lock` + `notifyError` on failure.

## Insight Types (MVP)

### 1. Temporal Echoes
Find semantically similar entries from the same calendar date (MM-DD) in previous years. CTE cross-joins current-year entries with past-year entries, filters by cosine similarity threshold (default 0.75).

### 2. Biometric-Journal Correlations
When Oura data shows anomalies (sleep score < 65, readiness < 65, sleep < 6h, HRV < 20), surfaces journal entries from the same day for context.

### 3. Stale Todo Detection
Active todos not updated in 7+ days, ordered by importance then staleness. Week-bracket dedup hash allows weekly resurfacing.

## Dedup & Throttling

- **Content hash**: SHA-256 of canonical string (`type:key_identifiers`), checked against configurable window (default 30 days)
- **Daily cap**: Max 3 notifications per day (configurable)
- **Advisory lock**: `pg_try_advisory_lock(9152202)` prevents concurrent runs

## DB Table

```sql
CREATE TABLE insights (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('temporal_echo', 'biometric_correlation', 'stale_todo')),
    content_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    relevance DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    metadata JSONB NOT NULL DEFAULT '{}',
    notified_at TIMESTAMPTZ,
    dismissed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Config

```
INSIGHT_ENGINE_INTERVAL_HOURS    — default 24
INSIGHT_ENGINE_MAX_PER_DAY       — default 3
INSIGHT_ENGINE_DEDUP_WINDOW_DAYS — default 30
```

No enable flag — runs automatically when Telegram bot is configured.

## Reused Components

| Component | Location | What's reused |
|-----------|----------|---------------|
| Sync scheduling | `oura/sync.ts` | `setInterval` + PG advisory lock pattern |
| Biometric data | `db/queries.ts` | `getOuraSummaryByDay` for outlier detection |
| Entry search | `db/queries.ts` | `getEntriesByDateRange` for journal context |
| Telegram delivery | `telegram/client.ts` | `sendTelegramMessage` with retry/chunking |
| Error notification | `telegram/notify.ts` | `notifyError` for background failures |
| Date utilities | `utils/dates.ts` | `todayInTimezone` for timezone-aware date |

## Future Extensions

- Additional insight types: pattern convergence, artifact gaps, learning momentum
- User feedback mechanism (dismiss, "more like this")
- Context injection into Telegram agent (token-budgeted)
- Historical window-based outlier detection (IQR/Z-score from `oura/analysis.ts`)
