# Web Weight Tracking Spec (MCP -> Web)

> **Status: Implemented**

Move weight logging out of MCP tools and into the web app as a first-class experience with:
- fast daily logging
- editable history view
- trend/pattern insights

This keeps MCP focused on retrieval/analysis tools and moves frequent health data entry to UI flows that are easier to scan and correct.

---

## Goals

1. Remove `log_weight` from the MCP tool surface.
2. Add a dedicated web weight area with quick logging and full history.
3. Provide useful pattern detection (trend, pace, volatility, streaks, plateau detection).
4. Keep existing `daily_metrics` compatibility so journal/oura features that read `weight_kg` continue to work.

## Non-goals

- Multi-measurement-per-day support (still one canonical value per date).
- Native mobile app.
- Coaching/goal recommendation LLM features in v1.

---

## Current state

- MCP includes `log_weight` in `specs/tools.spec.ts`, `src/server.ts`, and `src/tools/log-weight.ts`.
- Telegram agent is instructed to call `log_weight` when users mention weight.
- HTTP has ingestion endpoint `POST /api/metrics` that upserts `daily_metrics(date, weight_kg)`.
- Web app has no dedicated weight pages, APIs, or charts.

---

## Target user experience (web)

### Navigation and routes

- Add a top-level nav item: `Weight`.
- Add route: `/weight`.
- Route order must keep static route before `/:id` catch-all in `web/src/main.tsx`.

### Weight page sections

1. **Quick Log Card**
   - Date picker defaulting to today.
   - Weight input (kg, decimal allowed).
   - Save button with optimistic success feedback.
   - If a record already exists for date, action is explicit upsert.

2. **History View**
   - Table of measurements with columns:
     - date
     - weight (kg)
     - delta vs previous logged day
   - Sort newest first.
   - Inline edit + delete actions.
   - Date range filter presets: `30d`, `90d`, `365d`, `All`.

3. **Trend Chart**
   - Daily points (raw values) with gaps for missing days.
   - Overlay lines:
     - 7-day moving average
     - 30-day moving average
   - Hover tooltip for exact date/value/delta.

4. **Pattern Cards**
   - 7d change (kg)
   - 30d change (kg)
   - average weekly pace (kg/week) over selected range
   - logging consistency (logged days / range days)
   - current logging streak (consecutive days with entries)
   - volatility (stddev over last 14 logged days)
   - plateau flag (boolean with explanation)

---

## Pattern definitions (v1 deterministic rules)

Given ordered daily weights `w(d)`:

- `delta_7d = latest - value_at_or_before(latest_date - 7d)`
- `delta_30d = latest - value_at_or_before(latest_date - 30d)`
- `weekly_pace = delta_30d / (days_between(anchor_30d, latest) / 7)`
- `consistency = logged_days_in_range / calendar_days_in_range`
- `streak_days = consecutive daily records ending at latest_date`
- `volatility_14d = stddev(last_14_logged_values)`
- `plateau = abs(delta_30d) < 0.2 AND volatility_14d < 0.25`

All calculations are pure query/service logic; no LLM calls.

---

## Backend/API changes

### Query layer (`src/db/queries.ts`)

Add weight-specific query functions:

- `upsertWeight(pool, { date, weight_kg, source })`
- `deleteWeight(pool, date)`
- `listWeights(pool, { from?, to?, limit?, offset? })`
- `getWeightPatterns(pool, { from?, to? })`

`upsertDailyMetric()` can remain as a compatibility wrapper or be renamed and reused internally.

### HTTP endpoints (`src/transports/http.ts`)

Add weight-focused endpoints (bearer auth same as existing web APIs):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/weights` | List history with optional date window + pagination |
| `PUT` | `/api/weights/:date` | Upsert weight for a specific date |
| `DELETE` | `/api/weights/:date` | Delete weight for date |
| `GET` | `/api/weights/patterns` | Aggregate metrics/pattern summary for range |

`POST /api/metrics` stays temporarily for compatibility but is marked deprecated in comments/docs.

### Schema

Keep `daily_metrics` table for v1.

Optional migration (recommended for auditability):
- add `updated_at TIMESTAMPTZ DEFAULT NOW()`
- add `source TEXT NOT NULL DEFAULT 'web'` with check:
  - `web | api | legacy_mcp`
- add update trigger to bump `updated_at`

---

## Web app changes

### New files

- `web/src/pages/Weight.tsx`
- `web/src/components/WeightQuickLog.tsx`
- `web/src/components/WeightHistoryTable.tsx`
- `web/src/components/WeightTrendChart.tsx`
- `web/src/components/WeightPatternCards.tsx`

### API client additions (`web/src/api.ts`)

Add types/functions:
- `WeightEntry`
- `WeightPatterns`
- `listWeights()`
- `upsertWeight()`
- `deleteWeight()`
- `getWeightPatterns()`

### Design constraints

- Reuse current token/auth model in `apiFetch`.
- Keep layout parity with artifact/todo pages (manual save, clear error states).
- Mobile-first responsiveness for chart + table (table collapses to cards on small screens).

---

## MCP + Telegram deprecation plan

### Remove from MCP server

1. Delete `log_weight` spec entry from `specs/tools.spec.ts`.
2. Remove handler import/registration from `src/server.ts`.
3. Delete `src/tools/log-weight.ts`.
4. Remove/adjust tests that expect `log_weight`.

### Telegram behavior change

- Remove instruction to call `log_weight`.
- If user reports weight in chat, assistant replies with a short redirect:
  - "Log that in the web Weight page so it appears in trends/history."
- Do not silently store via MCP tool.

---

## Rollout phases

1. **Phase 1: API + query support**
   - Add `/api/weights*` endpoints, query functions, tests.
2. **Phase 2: Web UI**
   - Add `/weight` route, quick log, history table, chart, pattern cards.
3. **Phase 3: MCP removal**
   - Remove `log_weight` tool and Telegram tool usage instructions.
4. **Phase 4: Cleanup**
   - Mark `/api/metrics` as deprecated in docs (or remove after 1 release cycle if unused).

---

## Test plan

### Backend

- Unit tests for pattern math edge cases:
  - sparse data
  - <7 days
  - <30 days
  - missing anchor date fallback
- HTTP tests for new `/api/weights*` routes (auth, validation, pagination, errors).
- Integration tests for upsert/list/delete and pattern outputs.

### Web

- Page-level tests for `/weight`:
  - create log
  - edit existing day
  - delete day
  - range filter updates chart/table/cards consistently
- Playwright flow:
  - open `/weight`
  - add today weight
  - verify history row + chart point + pattern summary update

### Global

- `pnpm check` must pass.

---

## Open questions

1. Keep kg-only in v1, or support display-unit toggle (kg/lb)?
2. Should deleting a value hard-delete row or set `weight_kg = NULL`?
3. Should Oura pages consume `GET /api/weights/patterns` directly for shared trend cards?
4. How long should `/api/metrics` remain supported after web migration?
