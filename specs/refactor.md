# Codebase Refactor Spec

> **Status: Planned** — Audit, simplify, and restructure the codebase so a human developer can onboard in an afternoon instead of a week.

The codebase works well but grew organically through AI-assisted development. The result: monolithic files, duplicated patterns, and scattered conventions that make it hard for a new contributor to build a mental model. This spec defines a phased refactoring plan — no new features, no behavior changes, just structural improvements that make the code obvious.

---

## Problem statement

A new developer opening this project today would face:

- **`src/db/queries.ts`**: 6,695 lines, 154 functions, 229 exports. Every SQL query for every domain in one file.
- **`src/transports/http.ts`**: 1,648 lines, 48 routes. Auth check copy-pasted in early routes, then partially centralized via `requireBearerAuth`, with many route-local try/catch blocks.
- **`src/telegram/agent.ts`**: 1,619 lines, 50 functions. LLM init, tool dispatch, pattern retrieval, Spanish coaching, cost tracking — all interleaved.
- **`src/oura/analysis.ts`**: 1,126 lines. Generic statistics mixed with Oura-specific analysis.
- **CLAUDE.md**: 795 lines. Essential but overwhelming — architecture, operations, deployment, and feature docs in one scroll.

The individual tool files (29 small handlers) and formatters are clean. The problem is the shared infrastructure files that everything depends on.

---

## Guiding principles

1. **No behavior changes.** Every refactoring step must pass `pnpm check` before and after. Tests are the safety net.
2. **Split by domain, not by layer.** Group code by what it does (entries, artifacts, oura, todos) not by what kind of code it is.
3. **Extract duplication into middleware/helpers, not abstractions.** A shared auth helper is good. A generic framework (`GenericCRUDFactory<T>`, dynamic file scanners) is not.
4. **Each file should fit in your head.** Prefer files under ~400-700 lines with coherent responsibilities; treat this as a heuristic, not a hard cap that forces artificial fragmentation.
5. **Preserve stable import facades during this refactor.** Keep `src/db/queries.ts` and `src/transports/http.ts` as compatibility entrypoints while internals are split.
6. **Preserve route-specific auth and error semantics.** `/mcp` auth (MCP secret + OAuth), `/api/activity/:id` token query support, and JSON-RPC error shape must remain unchanged.
7. **Preserve route registration order when splitting routers.** Static routes must stay ahead of param routes (e.g., `/api/artifacts/tags` before `/api/artifacts/:id`, `/api/todos/focus` before `/api/todos/:id`).
8. **Keep docs and coverage config in lockstep with moves.** `AGENTS.md` (and symlinked `CLAUDE.md`), `vitest.config.ts`, and tests must be updated as files split.

---

## Phase 0 — Guardrails before code moves

Before extracting any code:

1. Add export-parity tests for public refactor targets:
   - `src/db/queries.ts` runtime export keys
   - `src/telegram/agent.ts` public exports (`runAgent`, `compactIfNeeded`, `forceCompact`, `truncateToolResult`)
   - `src/oura/analysis.ts` public exports
2. Reuse and tighten the existing `src/server.ts` handler-map coverage in `tests/tools/server.test.ts` instead of adding duplicate parity tests.
3. Update coverage thresholds in `vitest.config.ts` so split modules keep strict coverage without pinning only old monolith paths.
4. Document the compatibility contract in `AGENTS.md` (during migration, consumers still import `../db/queries.js`).
5. Capture route behavior baselines for:
   - `/mcp` unauthorized response shape (`jsonrpc` error object)
   - `/mcp` auth acceptance with MCP secret and with OAuth token
   - `/api/activity/:id?token=...` access path
   - `/api` behavior when `MCP_SECRET` is unset
   - static-vs-param route precedence (`/api/artifacts/tags` vs `/api/artifacts/:id`, `/api/todos/focus` vs `/api/todos/:id`)

---

## Phase 1 — Split `queries.ts` into domain modules

The highest-impact change. Every tool, route, and script imports from this file.

### Target structure

Start with coarse domain modules, then split only if a domain still remains unwieldy after extraction.

```
src/db/
  queries/
    index.ts              — Internal re-exports for domain modules
    entries.ts            — Entry CRUD, search, date-range, on-this-day, find-similar
    artifacts.ts          — Artifact CRUD, search, graph, links
    todos.ts              — Todo CRUD, focus, completion
    oura.ts               — Oura upserts, snapshots, sync state
    patterns.ts           — Memory patterns, observations, relations, aliases
    spanish.ts            — Vocabulary, reviews, progress, profiles, verbs, assessments
    chat.ts               — Chat messages, compaction, retrieval logs
    soul.ts               — Soul state, quality signals, pulse checks
    insights.ts           — Insight CRUD, dedup
    weights.ts            — Weight CRUD, patterns
    content-search.ts     — Unified cross-type search (entries + artifacts)
    templates.ts          — Entry template CRUD
    media.ts              — Media/attachment queries
    observability.ts      — Activity logs + DB observability feed queries
    settings.ts           — User settings (timezone)
    checkins.ts           — Check-in windows + summaries
    helpers.ts            — Shared pure helpers (tag normalization + typed filter builders)
  queries.ts              — Public compatibility facade (`export * from "./queries/..."`)
  client.ts               — PG Pool (unchanged)
  embeddings.ts           — OpenAI embedding helper (unchanged)
```

### Migration strategy

1. Create `src/db/queries/` and extract one low-coupling domain first (`weights.ts`, `templates.ts`).
2. Keep `src/db/queries.ts` as the only required import path for existing consumers during this phase.
3. After each extraction, run export-parity tests to ensure no named export disappears from `src/db/queries.ts`.
4. Use `git mv` where possible to preserve history for blame.
5. Preserve transaction boundaries while extracting (`createEntry`/`updateEntry` and tag/media write paths should keep their private helpers colocated with transaction logic).
6. Direct imports from domain modules are optional follow-up cleanup; not required in this refactor. The facade stays long-term as a convenience — no mandate to migrate consumers to direct imports.

### Shared helpers to extract into `helpers.ts`

```typescript
// Keep focused helpers, avoid raw SQL string parameters in helper signatures.
export function normalizeTags(tags: string[]): string[];

export function buildCreatedAtDateRangeFilter(
  dateFrom?: string,
  dateTo?: string,
  startIdx?: number
): { clauses: string[]; params: unknown[]; nextIdx: number };

export function buildTagAnyFilter(
  opts: { entityAlias: "e" | "ka"; relation: "entry_tags" | "artifact_tags" },
  tags: string[] | undefined,
  startIdx: number
): { clause?: string; params: unknown[]; nextIdx: number };
```

### Data model changes

- No table/column/constraint changes in this refactor.
- Track as a separate schema-performance follow-up (separate PR):
  - Add FK-side indexes: `media(entry_id)`, `entry_tags(tag_id)`, `artifact_tags(tag_id)`. Verify with `EXPLAIN ANALYZE` on common queries before adding.
  - Consolidate artifact tag source of truth: current query paths rely on `artifact_tags`, so drop the denormalized `knowledge_artifacts.tags` JSONB column and its GIN index in favor of `artifact_tags` as the single source.

### Verification

- `pnpm check` passes after each extraction.
- Export-parity test confirms `src/db/queries.ts` keeps all expected symbols.
- `pnpm test:integration` passes (query behavior unchanged).
- Query plans for hot paths are re-checked in the schema follow-up using `EXPLAIN (ANALYZE, BUFFERS)` before adding indexes.
- Coverage thresholds are updated as modules split so `pnpm check` remains authoritative.

---

## Phase 2 — Split `http.ts` into route modules with shared middleware

### Target structure

```
src/transports/
  http.ts               — App bootstrap, global middleware, /mcp route, static serving, listen
  middleware/
    auth.ts             — API bearer auth, MCP auth, activity-link auth helper
    errors.ts           — Shared unexpected-error logger/respond helper (no semantic rewrites)
    params.ts           — Query parsing helpers (pagination, booleans, enums)
  routes/
    metrics.ts          — Legacy /api/metrics compatibility route
    artifacts.ts        — /api/artifacts/*
    entries.ts          — /api/entries/* + /api/media/*
    content.ts          — /api/content/search
    todos.ts            — /api/todos/*
    templates.ts        — /api/templates/*
    weights.ts          — /api/weights/*
    activity.ts         — /api/activity/*
    spanish.ts          — /api/spanish/*
    observability.ts    — /api/db/*
    settings.ts         — /api/settings/*
    health.ts           — /health
  oauth.ts              — OAuth token validation (unchanged)
```

### Auth middleware

Replace ad-hoc checks with explicit middlewares for each auth mode:

```typescript
// src/transports/middleware/auth.ts
export function requireApiBearerAuth(req: Request, res: Response, next: NextFunction): void;
// - Uses MCP_SECRET
// - If MCP_SECRET is unset, allow request (current behavior)

export function requireMcpAuth(req: Request, res: Response, next: NextFunction): void;
// - Accepts MCP_SECRET OR OAuth token
// - Returns JSON-RPC formatted 401 errors (current behavior)

export function isActivityLinkTokenValid(req: Request): boolean;
// - Preserves /api/activity/:id?token=<MCP_SECRET> support for Telegram links
```

### Error handling

Do **not** introduce custom `ValidationError`/`NotFoundError` classes in this refactor.

- Keep explicit route-level 400/404 branches where responses are custom today.
- Centralize only shared unexpected-error behavior for logging and branch reduction; preserve existing per-route 500 payloads in this refactor.
- Use Express 5 native async error propagation; an `asyncHandler` wrapper is optional and not required.

### Route-order and middleware-order invariants

- Preserve static-before-param order inside each router:
  - `/api/artifacts/tags|titles|graph` before `/api/artifacts/:id`
  - `/api/todos/focus` before `/api/todos/:id`
- Preserve auth-before-upload ordering for `/api/entries/:uuid/media` so unauthorized requests fail before multer parsing.
- Keep `registerOAuthRoutes(app)` before `/mcp` auth middleware and keep SPA fallback registration last.

### Pagination helper

Extract the repeated parsing/clamping logic into `middleware/params.ts` and reuse it across routes:

```typescript
export function parsePagination(
  query: Record<string, unknown>,
  defaults: { limit: number; maxLimit: number }
): { limit: number; offset: number };
```

Keep per-route defaults (`20/100`, `50/200`, `100/500`) unchanged.

### Verification

- `pnpm check` passes after each route group extraction.
- Add route-compat tests for:
  - `/mcp` auth with MCP secret and OAuth token (including JSON-RPC 401 body shape)
  - `/api/activity/:id` bearer and `?token=` paths
  - API behavior when `MCP_SECRET` is unset
  - Route precedence for `/api/artifacts/tags` and `/api/todos/focus`
  - `/api/entries/:uuid/media` auth-before-multer behavior and multer error mapping
  - Legacy `/api/metrics` route behavior remains unchanged
  - Telegram webhook still conditionally registered when bot token exists
  - Static SPA fallback does not intercept `/api/*` or `/mcp`
- Existing web e2e tests in `web/e2e/` pass unchanged.

---

## Phase 3 — Split `agent.ts` into focused modules

### Target structure

```
src/telegram/
  agent.ts              — Main loop orchestration only
  agent/
    context.ts          — System prompt assembly (soul, oura, todos, spanish, patterns)
    tools.ts            — Tool loop + dispatch wrappers (Anthropic/OpenAI)
    costs.ts            — Token counting, cost calculation, API usage logging
    compaction.ts       — Message compaction logic (summarize + trim + lock handling)
    constants.ts        — Model names, token limits, retry config
    language.ts         — Spanish signals, adaptive guidance, rewrite heuristics
  webhook.ts            — (unchanged)
  client.ts             — (unchanged)
  updates.ts            — (unchanged)
  notify.ts             — (unchanged)
  voice.ts              — (unchanged)
  media.ts              — (unchanged)
  evening-review.ts     — (unchanged)
  soul.ts               — (unchanged)
  pulse.ts              — (unchanged)
```

### Extraction priority

1. **`constants.ts`** — low-risk move.
2. **`costs.ts`** — pure utility functions + API usage logging helpers.
3. **`compaction.ts`** — compaction + advisory lock flow.
4. **`language.ts`** — language preference detection/rewrite and Spanish guidance assembly.
5. **`context.ts`** — prompt assembly and memory snippets.
6. **`tools.ts`** — Anthropic/OpenAI tool loops.
7. **`agent.ts`** remains orchestrator.

Extract pure pieces first, protect high-risk provider/tool-loop behavior until late in the phase.

### Verification

- `pnpm check` after each extraction.
- Existing tests (`tests/tools/telegram-agent.test.ts`, webhook/media/voice/pulse suites) pass without behavior changes.
- Add focused regression tests for:
  - Anthropic and OpenAI provider parity on tool-loop stop conditions
  - exported API parity for `runAgent`, `compactIfNeeded`, `forceCompact`, `truncateToolResult`
  - max tool-call loop cutoffs
  - duplicate tool-call suppression
  - compaction lock behavior
  - activity log link generation using `?token=`

---

## Phase 4 — Split `oura/analysis.ts` into focused modules

### Target structure

```
src/oura/
  analysis/
    index.ts            — Re-exports for `src/oura/analysis.ts` facade
    statistics.ts       — mean, stddev, quantile, percentile, linearRegression
    trends.ts           — rolling averages, trend detection, direction classification
    outliers.ts         — IQR + Z-score outlier detection
    sleep.ts            — sleep debt, regularity, stage ratios, best sleep conditions
    hrv.ts              — HRV recovery patterns, baseline comparison
    temperature.ts      — temperature deviation analysis
    correlations.ts     — Pearson correlation, day-of-week patterns
  analysis.ts           — Public compatibility facade (re-export from `analysis/*`)
  client.ts             — (unchanged)
  sync.ts               — (unchanged)
  context.ts            — (unchanged)
  formatters.ts         — (unchanged)
  types.ts              — (unchanged)
```

### Why this matters

`statistics.ts` functions (mean, stddev, quantile) are generic — they could serve any numeric analysis. Mixing them with Oura-specific sleep-debt calculations makes it unclear what's reusable vs. domain-specific.

### Verification

- `pnpm check` passes.
- `tests/oura/analysis.test.ts` passes unchanged.
- Public export parity from `src/oura/analysis.ts` is preserved during the split.
- Coverage thresholds in `vitest.config.ts` are updated to new module paths while keeping strictness.

---

## Phase 5 — Reorganize AGENTS/CLAUDE docs

### Target structure

```
AGENTS.md               — Canonical operational guide (concise top section + links)
CLAUDE.md               — Symlink to AGENTS.md (existing convention, preserved)
docs/
  architecture.md       — Data flow, search pipeline, embedding lifecycle, config system
  development.md        — Environment setup, common tasks, DB access, sync workflow
  deployment.md         — Railway, Telegram setup, CI/CD, migration protocol
  testing.md            — Test tiers, isolation, fixtures, coverage policy, assertions
  telegram.md           — Bot features, commands, soul system, Spanish learning, insight engine
```

### What stays in AGENTS.md top section

- Development loop (`pnpm check`)
- Main-branch release protocol and migration-before-push checklist
- Directory map (abbreviated)
- Key patterns (SQL access contract, RRF search, config fail-fast, formatter purity)
- Adding a new tool checklist
- Links to deep docs

Optimize for scanability and task-critical safety info — no hard line-count cap, but aggressively trim detail that belongs in deep docs.

### What moves out

- Telegram deep feature details → `docs/telegram.md`
- Environment separation and DB access workflow → `docs/development.md`
- CI/CD and release protocol → `docs/deployment.md`
- Test strategy and coverage policy → `docs/testing.md`
- Extended architecture explanations and endpoint maps → `docs/architecture.md`

### Verification

- Read AGENTS.md top section cold and confirm a new developer can start within 5-10 minutes.
- All cross-references resolve (no broken links).
- `CLAUDE.md` remains a valid symlink to `AGENTS.md`.
- Verify no duplicated or conflicting guidance between moved docs and AGENTS.md (single source of truth retained).

---

## Phase 6 — Cleanup pass

Smaller fixes that compound into a cleaner experience.

### 6a. Search tool duplication: keep pragmatic

`search.ts`, `search-artifacts.ts`, and `search-content.ts` are already small (~30 lines each). Do **not** introduce a generic `executeHybridSearch<T>` abstraction unless duplication grows materially.

If needed, extract only micro-helpers (e.g., shared embedding call + empty-result response constants) with explicit names per domain.

### 6b. Type deduplication with boundaries

- Keep `specs/tools.spec.ts` as source of truth for tool schemas/contracts.
- Share DTOs in `packages/shared` only for shapes used by both MCP server and web frontend.
- Keep DB row types close to query modules (`src/db/queries/*`) to avoid leaking storage concerns into shared contracts.

### 6c. Test naming policy

Adopt a naming convention for **new or touched tests only**; avoid mass-rename churn with no behavior benefit.

Recommended: keep existing workspace-aligned placement (`tests/tools`, `tests/formatters`, `tests/oura`, `tests/integration`) and prefer descriptive `<feature>-<behavior>.test.ts` names for new files.

### 6d. Clean up `server.ts` tool registration safely

Keep explicit imports and use a typed registry map; do not use filesystem auto-discovery.

```typescript
export const toolHandlers = {
  // explicit mappings
} satisfies Record<keyof typeof toolSpecs, ToolHandler>;
```

Add a compile-time or test-time guard that every `toolSpecs` key has a handler.

### 6e. Update existing `.env.example` (do not add a new file)

- Ensure all required/optional vars are documented.
- Align dev DB example with actual compose port (`5434`).
- Include currently used server/runtime vars missing from `.env.example` (`MCP_SECRET`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `APP_URL`, check-in/insight/Oura sync controls, Telegram soul/pulse toggles).
- Keep comments synchronized with `src/config.ts` and deploy docs.

### Verification

- `pnpm check` passes.
- No dead exports introduced in touched modules (validated by typecheck + usage review in PR).

---

## Implementation order

| Phase | What | Risk | Effort | Depends on |
|-------|------|------|--------|------------|
| 0 | Guardrails (coverage, parity tests, behavior baselines) | Low | Half day | — |
| 1 | Split `queries.ts` internals | Medium | 3-4 days | 0 |
| 2 | Split `http.ts` routes + middleware | Medium-High | 3-4 days | 0 |
| 3 | Split `agent.ts` | Medium-High | 2-3 days | 0 |
| 4 | Split `oura/analysis.ts` | Low | 1 day | 0 |
| 5 | Reorganize AGENTS/CLAUDE docs | Low | Half day | 1-4 |
| 6 | Pragmatic cleanup | Low | 1 day | 1-4 |

Phases 1-4 are largely independent once guardrails are in place. Phase 5 should come after structure stabilizes. Phase 6 can be interleaved selectively.

**Total estimate: 4-6 focused sessions.**

---

## What this does NOT change

- No new user-facing features, tools, or endpoints.
- No MCP protocol/tool contract changes.
- No web frontend behavior changes.
- No dependency additions required for this refactor.
- No schema migrations — index follow-up tracked separately.

---

## Success criteria

After all phases:

1. **Primary infrastructure files are materially smaller and cohesive** (rough target: most under ~700 lines, with explicit justification for outliers).
2. **`AGENTS.md`/`CLAUDE.md` is scannable** with deep docs moved to `docs/` and no instruction drift between symlinked files.
3. **Auth and error handling are centralized with explicit exceptions documented** (`/mcp` OAuth, `/api/activity/:id?token=`).
4. **`pnpm check` passes at every intermediate commit.**
5. **Route-order and auth edge-case compatibility tests pass** (including `/api/artifacts/tags`, `/api/todos/focus`, `/api/activity/:id?token=`, and `/mcp` JSON-RPC errors).
6. **A developer unfamiliar with the project can start a safe code change within 30 minutes** after reading top-level docs.
