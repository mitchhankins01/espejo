# Web App: DB Observability Panel

> **Status: Planned**

Read-only database visibility inside the web frontend so you can inspect what is in Postgres while interacting with MCP/Telegram, and see recent changes in near real time.

---

## Goals

1. Provide a safe, read-only UI to inspect selected database tables from the existing web app.
2. Make it easy to understand "what changed" as MCP tools run (rows created/updated, tool activity context).
3. Reduce context switching to psql/TablePlus for day-to-day debugging and product iteration.
4. Keep implementation aligned with current architecture:
   - auth via existing bearer token flow
   - all SQL in `src/db/queries.ts`
   - Express REST endpoints in `src/transports/http.ts`
   - React + Vite UI in `web/`

## Non-goals (v1)

- Full SQL console in browser (no arbitrary SQL execution).
- Write operations from web UI (strictly read-only).
- Perfect CDC-level event history for every table operation on day 1.
- Replacing psql for schema migrations or production incident response.

---

## User experience

### Navigation + route

- Add top-level nav item: `DB`.
- Add route: `/db`.
- Route is behind existing `AuthGate` bearer token auth.

### DB page layout

Two tabs:

1. `Explorer`
2. `Recent Changes`

### Explorer tab

- Left panel: allowlisted table list with:
  - table name
  - approximate row count
  - latest observed change timestamp (if available)
- Main panel:
  - column headers
  - paginated rows
  - simple filters (search text, date range when table has date/timestamp column)
  - sort controls (default newest-first using `updated_at` or `created_at`)
- Row detail drawer:
  - full JSON for selected row
  - copy JSON button
  - links to related pages when applicable (example: artifact id -> `/:id`, todo id -> `/todos/:id`)

### Recent Changes tab

- Combined cross-table timeline (newest first) that merges events from **all allowlisted tables** in one feed by default.
- Filters:
  - table
  - operation type (`insert`, `update`, `delete`, `tool_call`)
  - time window (`15m`, `1h`, `6h`, `24h`)
- Feed item fields:
  - `changed_at`
  - `table`
  - `operation`
  - `row_id` (or compound key string)
  - changed fields summary (e.g. `status: active -> done`, `updated_at`, `tags +1`)
  - before/after JSON payload (expand/collapse)
  - optional `tool_name` + `chat_id` (when traceable from activity logs)
- Auto-refresh every 5s with pause toggle.
- Default mode is **All Tables** (no table pre-filter). Table filter is optional narrowing.

---

## Data scope and safety

### Table allowlist (v1)

Only expose high-value operational tables for observability:

- `knowledge_artifacts`
- `artifact_links`
- `todos`
- `activity_logs`
- `chat_messages`
- `patterns`
- `spanish_vocabulary`
- `spanish_reviews`
- `daily_metrics`
- `insights`
- `checkins`

Explicitly exclude sensitive/internal-only data by default:

- secrets/tokens/config-like values
- large embedding vectors (`embedding` columns hidden in table view; available only in row JSON when explicitly requested)
- provider usage internals not needed for product debugging

### Access control

- Reuse existing bearer token auth (`MCP_SECRET`) in HTTP layer.
- `/api/db/*` is always available behind bearer auth.

---

## Backend contract

All SQL must live in `src/db/queries.ts`.

### New REST endpoints (`src/transports/http.ts`)

1. `GET /api/db/tables`
   - returns allowlisted table metadata:
   ```ts
   type DbTableMeta = {
     name: string;
     row_count: number;
     last_changed_at: string | null;
     default_sort_column: string | null;
   };
   ```

2. `GET /api/db/tables/:table/rows`
   - query params:
     - `limit` (default 50, max 200)
     - `offset` (default 0)
     - `sort` (allowlisted per table)
     - `order` (`asc|desc`)
     - `q` (text filter across configured searchable columns)
     - `from`, `to` (date/timestamp filter when supported)
   - response:
   ```ts
   {
     items: Record<string, unknown>[];
     total: number;
     columns: { name: string; type: string; hidden: boolean }[];
   }
   ```

3. `GET /api/db/changes`
   - query params:
     - `limit` (default 100, max 500)
     - `since` (ISO timestamp)
     - `table` (optional)
     - `operation` (optional)
   - response:
   ```ts
   type DbChangeEvent = {
     changed_at: string;
     table: string;
     operation: "insert" | "update" | "delete" | "tool_call";
     row_id: string | null;
     summary: string;
     changed_fields?: Array<{
       field: string;
       before: unknown;
       after: unknown;
     }>;
     before?: Record<string, unknown> | null;
     after?: Record<string, unknown> | null;
     tool_name?: string;
     chat_id?: string;
   };
   ```

4. `GET /api/db/changes/stream` (optional v1.1)
   - SSE endpoint for live feed updates.
   - fallback remains poll-based refresh.

### Query layer additions (`src/db/queries.ts`)

- `listObservableTables(pool): Promise<DbTableMeta[]>`
- `listTableRows(pool, params): Promise<{ items; total; columns }>`
- `listRecentChanges(pool, params): Promise<DbChangeEvent[]>`

Implementation constraints:

- Never interpolate table or column names directly from user input.
- Use allowlist maps for table metadata and sortable/filterable columns.
- Parameterize all user values (`$1`, `$2`, ...).

---

## Recent changes design

### Phase A (v1): combined inferred feed from all tables

Build `listRecentChanges` from two sources:

1. `activity_logs` (tool invocation context from Telegram/MCP runs)
2. Union of selected mutable tables using timestamps:
   - `updated_at` when present
   - otherwise `created_at`

Combined-view behavior:

- `/api/db/changes` returns one merged stream across all allowlisted tables by default.
- Merge key order: `changed_at DESC`, then stable tie-breaker (`table`, `row_id`).
- Optional `table` param narrows results; it never changes feed shape.

Event inference rules (v1):

- `insert`: `updated_at` absent OR `updated_at ~= created_at`
- `update`: `updated_at > created_at`
- `tool_call`: direct from `activity_logs`
- `delete`: not reliably captured in phase A (unless represented in tool logs)

Change detail behavior (v1):

- For `tool_call`, include call name + args/result summary.
- For row events without audit history, include:
  - best-effort `summary`
  - optional `after` snapshot (current row fetch when possible)
  - `changed_fields` may be empty when true before-state is unavailable.

This gives immediate visibility for "what changed recently across the whole DB" with minimal migration risk.

### Phase B (v2): full audit trail (recommended)

Add audit infrastructure for robust change history, including deletes:

1. New table `db_change_events`:
   - `id BIGSERIAL`
   - `table_name TEXT`
   - `operation TEXT CHECK (operation IN ('insert','update','delete'))`
   - `row_id TEXT`
   - `changed_at TIMESTAMPTZ DEFAULT NOW()`
   - `before JSONB`
   - `after JSONB`

2. Trigger function `log_row_change()` and per-table triggers on allowlisted mutable tables.

3. `/api/db/changes` uses `db_change_events` as primary source and enriches with nearby `activity_logs` context.
4. Compute deterministic per-field diffs from `before`/`after`:
   - added field
   - removed field
   - updated scalar/object value

v2 result: complete combined feed with reliable delete visibility and explicit field-level changes for each event.

---

## Frontend changes

### New files

- `web/src/pages/DbObservability.tsx`
- `web/src/components/db/TableList.tsx`
- `web/src/components/db/TableExplorer.tsx`
- `web/src/components/db/RowDetailDrawer.tsx`
- `web/src/components/db/RecentChangesFeed.tsx`

### API client additions (`web/src/api.ts`)

- `listDbTables()`
- `listDbTableRows(table, params)`
- `listDbChanges(params)`
- optional `streamDbChanges()` for SSE mode

### UX details

- Persist selected table and tab in URL query params:
  - `/db?tab=explorer&table=todos`
  - `/db?tab=changes&table=knowledge_artifacts`
- Show loading and error states matching existing page patterns.
- Keep visual style consistent with current app (no separate design system).

---

## Rollout plan

1. **Phase 1: Read-only explorer**
   - Add `/api/db/tables`
   - Add `/api/db/tables/:table/rows`
   - Add `/db` Explorer UI

2. **Phase 2: Recent changes (inferred)**
   - Add `/api/db/changes` using timestamp + activity log inference
   - Merge all-table events into a single timeline by default
   - Add expandable before/after JSON with best-effort changed-fields summary

3. **Phase 3: Full audit trail (optional but recommended)**
   - Add `db_change_events` + triggers
   - Upgrade feed to include reliable deletes + exact field-level diffs

---

## Test plan

### Backend

- Unit tests for allowlist validation:
  - reject unknown table names
  - reject unknown sort columns
- Integration tests:
  - row pagination/filter/sort by table
  - combined changes feed ordering across multiple tables
  - changes feed filtering by table/operation/window
  - detail payload shape (`changed_fields`, `before`, `after`) for audited rows

### Frontend

- Component tests:
  - table selection loads rows
  - row click opens JSON drawer
  - changes feed filter chips update results
- Playwright:
  - login -> navigate `/db`
  - inspect `todos` rows
  - create/update todo + artifact in another tab/session
  - confirm both appear in one combined Recent Changes feed after refresh
  - expand event row and verify changed-fields + before/after payload rendering

### Global

- Run full validation:
  - `pnpm check`

---

## Open questions

1. Which additional tables (if any) should be included in the combined feed allowlist by default?
2. For large JSON columns, do you want full before/after by default or truncated with "view full"?
3. Should sync-originated updates (Day One/Oura) be visually tagged separately from MCP/tool-driven updates?
