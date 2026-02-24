# Oura Ring Integration into Espejo

## Context

The Telegram bot can't access Oura data today — only Claude Desktop can, because it has both MCPs connected. This integration brings Oura data directly into Espejo's PostgreSQL database with hourly sync, giving the Telegram agent access to biometrics during evening reviews, morning flows, and general conversation. All data lives in your own DB rather than being fetched on-demand from Oura's API.

## Approach

Port the thin Oura API client (~200 lines) from `oura-mcp/src/client.ts` into Espejo. Store the 6 most useful data domains in dedicated `oura_*` tables with typed columns + JSONB `raw_json` for full API payloads. Hourly sync via in-process `setInterval` (simplest for Railway — no cron infra needed), with a PG advisory lock to prevent overlapping runs. Expose 3 new MCP tools for the Telegram bot. Auto-inject today's biometrics into evening/morning review context.

Port the analysis module (1065 lines of pure functions from `oura-mcp/src/utils/analysis.ts`) in Phase 5 to power advanced tools — anomaly detection, sleep quality analysis, correlations, period comparisons, HRV trends, temperature patterns, and condition comparisons. The 6 data domains we store are sufficient to support all 9 analysis capabilities.

## Phased Implementation

### Phase 1: Storage + Sync Foundation (MVP)

**Database schema** — migration `015-oura-tables` in [scripts/migrate.ts](scripts/migrate.ts), canonical schema in [specs/schema.sql](specs/schema.sql).

8 tables: 6 data + 1 sync state + 1 sync audit log.

| Table | Key | Source Endpoint | Notes |
|-------|-----|-----------------|-------|
| `oura_sync_state` | `endpoint TEXT UNIQUE` | — | Last sync date per endpoint |
| `oura_sync_runs` | `id SERIAL` | — | Audit trail: start/end time, records synced, errors |
| `oura_daily_sleep` | `day DATE UNIQUE` | `/daily_sleep` | Scores + contributors JSONB |
| `oura_sleep_sessions` | `oura_id TEXT UNIQUE` | `/sleep` | Per-session: stages, HR, HRV, efficiency |
| `oura_daily_readiness` | `day DATE UNIQUE` | `/daily_readiness` | Recovery score, temp deviation |
| `oura_daily_activity` | `day DATE UNIQUE` | `/daily_activity` | Steps, calories, intensity breakdown |
| `oura_daily_stress` | `day DATE UNIQUE` | `/daily_stress` | Stress/recovery seconds, day summary |
| `oura_workouts` | `oura_id TEXT UNIQUE` | `/workout` | Multiple per day, activity type, HR |

**Deliberately excluded** (add later if needed): heart rate time-series (thousands of readings/day — per-session averages cover chatbot needs), SpO2, VO2max, resilience, cardiovascular age, tags, sessions, sleep_time, ring_config.

**New files:**

| File | Purpose |
|------|---------|
| `src/oura/client.ts` | Oura API v2 client (ported from [oura-mcp/src/client.ts](/Users/mitch/Projects/oura-mcp/src/client.ts)) |
| `src/oura/types.ts` | TypeScript interfaces for stored Oura data |
| `src/oura/sync.ts` | Sync logic: fetch API → upsert DB, advisory lock, `startOuraSyncTimer()` |
| `scripts/sync-oura.ts` | CLI for manual/backfill sync (`pnpm sync:oura [--days 90]`) |

**Modified files:**

| File | Changes |
|------|---------|
| [specs/schema.sql](specs/schema.sql) | Add 8 Oura tables + indexes |
| [scripts/migrate.ts](scripts/migrate.ts) | Add migration `015-oura-tables` |
| [src/config.ts](src/config.ts) | Add `oura` config group |
| [src/db/queries.ts](src/db/queries.ts) | Add ~12 Oura upsert + read functions |
| `package.json` | Add `sync:oura` script |

**Sync mechanism:**
- In-process `setInterval` in the HTTP server, starts when `OURA_ACCESS_TOKEN` is set
- **PG advisory lock** (`pg_try_advisory_lock`) to prevent overlapping runs (safe even without cron — guards against timer drift or manual CLI overlap)
- Initial run: 30-day backfill
- Hourly runs: 3-day rolling lookback (catches overnight sleep attribution + late-arriving data)
- All upserts `ON CONFLICT DO UPDATE` — fully idempotent
- 6 endpoints fetched in parallel via `Promise.allSettled` (graceful per-endpoint failure)
- Each run logged to `oura_sync_runs` (records synced, duration, errors)

**Config** (all opt-in, no fail-fast):
```
OURA_ACCESS_TOKEN     — Personal access token from cloud.ouraring.com
OURA_SYNC_INTERVAL_MINUTES  — default 60
OURA_SYNC_LOOKBACK_DAYS     — default 3
```

### Phase 2: Expose to Telegram Agent

**3 new tools** (tight tool set for agent reliability):

**`get_oura_summary`** — Single-day health snapshot: sleep score/duration/stages, readiness, activity/steps, stress, HRV, workouts. Optional `date` param (defaults to today). Primary tool for evening reviews.

**`get_oura_weekly`** — 7-day overview: daily scores for sleep/readiness/activity, averages, best/worst days, total steps and workouts. Good for "how was my week?" without needing the full analysis module.

**`get_oura_trends`** — N-day trend analysis: rolling averages (7/14/30-day), trend direction (improving/stable/declining), day-of-week patterns. Uses simple SQL aggregations for MVP (no analysis module dependency). Optional `metric` filter (sleep_score, hrv, readiness, activity, steps, sleep_duration).

**Context injection** — `buildOuraContextPrompt()` in `src/oura/context.ts`, called alongside `buildSpanishContextPrompt()` in [src/telegram/agent.ts:1969](src/telegram/agent.ts#L1969):

```
Oura Ring biometrics:
Today: Sleep 82 | Readiness 75 | Activity 68 | HRV 42ms | 8,234 steps | Stress: normal
Sleep: 7h 12m (efficiency 91%) | Deep 1h 23m | REM 1h 48m
Bed: 11:15 PM → 6:45 AM
```

**New files:**

| File | Purpose |
|------|---------|
| `src/oura/context.ts` | `buildOuraContextPrompt()` for agent system prompt |
| `src/oura/formatters.ts` | Format Oura data for tool responses |
| `src/tools/get-oura-summary.ts` | Daily snapshot tool handler |
| `src/tools/get-oura-weekly.ts` | Weekly overview tool handler |
| `src/tools/get-oura-trends.ts` | Trend analysis tool handler |

**Modified files:**

| File | Changes |
|------|---------|
| [specs/tools.spec.ts](specs/tools.spec.ts) | Add 3 tool specs |
| [src/server.ts](src/server.ts) | Register 3 new tool handlers |
| [src/telegram/agent.ts](src/telegram/agent.ts) | Inject Oura context, update tool count 11→14, add guidance for biometric-related queries |
| [src/telegram/evening-review.ts](src/telegram/evening-review.ts) | Reference Oura data in evening session kickoff (7-day biometric context alongside 7-day journal context) |
| [src/transports/http.ts](src/transports/http.ts) | Start Oura sync timer when token is set |
| [src/db/queries.ts](src/db/queries.ts) | Add summary join query + weekly aggregation + trends queries |

### Phase 3: Testing + Hardening

- Unit tests for sync mapping/parsing, tool handlers, context builder, formatters
- Integration tests for upsert idempotency, range queries, summary join
- Update test truncation list in [tests/setup/per-test-setup.ts](tests/setup/per-test-setup.ts) for new tables
- Add Oura fixtures to [specs/fixtures/seed.ts](specs/fixtures/seed.ts) for deterministic tests
- `pnpm check` after every change (100% coverage enforced)

### Phase 4: Documentation

- Update [CLAUDE.md](CLAUDE.md): tools, tables, env vars, sync mechanism, directory map
- Add sync instructions to "Common Tasks" section

### Phase 5: Analysis Tools

Port `analysis.ts` (1065 lines of pure functions) from [oura-mcp/src/utils/analysis.ts](/Users/mitch/Projects/oura-mcp/src/utils/analysis.ts) into `src/oura/analysis.ts`. Then expose the 9 analysis capabilities via 3 additional tools (keeping total Oura tool count at 6 — manageable for the agent):

**`get_oura_analysis`** — Multi-purpose analysis tool with `type` parameter:
- `sleep_quality` — Comprehensive sleep analysis: trends, debt, regularity, stage ratios, best/worst days, day-of-week patterns (maps to oura-mcp's `analyze_sleep_quality`)
- `anomalies` — Flag unusual readings via IQR + Z-score across sleep/HRV/HR/readiness/activity (maps to `detect_anomalies`)
- `hrv_trend` — HRV trajectory: rolling averages, trend direction, recovery patterns (maps to `analyze_hrv_trend`)
- `temperature` — Body temp deviations from readiness data, illness/cycle detection (maps to `analyze_temperature`)
- `best_sleep` — What predicts good vs poor sleep: activity levels, workouts, day-of-week (maps to `best_sleep_conditions`)

**`oura_compare_periods`** — Side-by-side metrics comparison between two date ranges. "This week vs last week", "this month vs last month". Returns % changes across sleep/readiness/activity/HRV/steps. (Maps to oura-mcp's `compare_periods` + `compare_conditions`)

**`oura_correlate`** — Find correlations between any two metrics (Pearson r, p-value, strength). E.g., "does my HRV correlate with sleep duration?" or "does activity affect readiness?" (Maps to `correlate_metrics`)

**New/modified files:**

| File | Purpose |
|------|---------|
| `src/oura/analysis.ts` | Ported analysis module (pure functions, no deps) |
| `src/tools/get-oura-analysis.ts` | Multi-analysis tool handler |
| `src/tools/oura-compare-periods.ts` | Period comparison tool handler |
| `src/tools/oura-correlate.ts` | Metric correlation tool handler |
| [specs/tools.spec.ts](specs/tools.spec.ts) | Add 3 more tool specs |
| [src/server.ts](src/server.ts) | Register 3 more handlers (total Oura: 6) |
| [src/telegram/agent.ts](src/telegram/agent.ts) | Update tool count 14→17 |
| Tests for analysis module + 3 new tools |

**Note on `analyze_adherence`**: This oura-mcp tool analyzes ring wear consistency using non-wear time data. Our stored data doesn't include non-wear gaps directly, but we can approximate it — days with missing data in `oura_daily_sleep` imply the ring wasn't worn. Fold this into the `anomalies` analysis type if useful.

Also add a SQL view for cross-domain queries:
```sql
CREATE VIEW daily_health_snapshot AS
SELECT d.day, d.score AS sleep_score, r.score AS readiness_score,
       a.score AS activity_score, a.steps, st.day_summary AS stress,
       ss.average_hrv, ss.average_heart_rate, m.weight_kg
FROM oura_daily_sleep d
LEFT JOIN oura_daily_readiness r ON r.day = d.day
LEFT JOIN oura_daily_activity a ON a.day = d.day
LEFT JOIN oura_daily_stress st ON st.day = d.day
LEFT JOIN oura_sleep_sessions ss ON ss.day = d.day AND ss.period = 0
LEFT JOIN daily_metrics m ON m.date = d.day;
```

## Verification

1. `pnpm migrate` — apply schema locally
2. `pnpm sync:oura --days 30` — backfill from Oura API, confirm records in DB
3. `psql` spot check: `SELECT day, score FROM oura_daily_sleep ORDER BY day DESC LIMIT 5`
4. Start server with `OURA_ACCESS_TOKEN` set — verify sync timer log
5. Telegram: "how did I sleep last night?" → bot calls `get_oura_summary`
6. Telegram: `/evening` → system prompt includes biometric context
7. Telegram: "how's my sleep been this week?" → bot calls `get_oura_weekly`
8. `pnpm check` — typecheck + lint + tests with 100% coverage
