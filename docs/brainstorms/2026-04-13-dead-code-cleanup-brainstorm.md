# Dead Code Cleanup: Patterns, Todos, API Cost Tracking

**Date:** 2026-04-13
**Status:** Ready for planning

## What We're Building

A single-sweep removal of three unused systems from the espejo codebase:

1. **Pattern/memory system** — 6 DB tables, 4 MCP tools (remember/recall/reflect/save_chat), `src/memory/` module, Telegram agent pattern retrieval on every message
2. **Todos system** — 1 DB table, 5 MCP tools, REST routes, web pages, Telegram context injection, Eisenhower matrix component
3. **API cost tracking** — 2 DB tables (api_usage, cost_notifications), logApiUsage calls across 7+ files, cost notification Telegram logic

## Why This Approach

- None of these systems are actively used
- Pattern memory adds latency (embedding + hybrid search) to every Telegram message without providing value
- The todo system duplicates functionality available elsewhere
- API cost tracking adds noise without actionable insight
- Removing dead code reduces maintenance burden, test surface, and cognitive overhead

## Key Decisions

1. **Single PR, not staged** — All removals are independent deletions with no new logic. One sweep keeps git history clean.
2. **Migration script for DB** — Create a migration SQL file with DROP TABLE statements for all 9 tables. Run against prod before deploying.
3. **No replacement for agent memory** — The pattern memory wasn't useful. The Telegram agent will work without long-term memory.
4. **Relocate nothing** — API cost functions in `patterns.ts` are deleted, not relocated. The entire file goes away.
5. **Remove cost tracking completely** — Per-call LLM cost logging and threshold notifications are removed. Activity log cost_usd (in observability) is a separate system and stays.

## Scope of Removal

### Database Tables to Drop (9 total)
- `patterns` — core memory table with embeddings
- `pattern_observations` — provenance trail
- `pattern_relations` — relationships between patterns
- `pattern_aliases` — alternate phrasings
- `pattern_entries` — links patterns to journal entries
- `memory_retrieval_logs` — observability for pattern retrieval
- `todos` — task management
- `api_usage` — per-call LLM cost logging
- `cost_notifications` — cost threshold notifications

### Files to Delete (~20 files)
- `src/db/queries/patterns.ts` — all pattern + cost queries
- `src/db/queries/todos.ts` — all todo queries
- `src/memory/extraction.ts` — pattern extraction from chat
- `src/memory/consolidation.ts` — pattern dedup/merge
- `src/tools/remember.ts`, `recall.ts`, `reflect.ts`, `save-chat.ts` — 4 MCP tools
- `src/tools/list-todos.ts`, `create-todo.ts`, `update-todo.ts`, `complete-todo.ts`, `set-todo-focus.ts` — 5 MCP tools
- `src/todos/context.ts` — todo context for Telegram
- `src/telegram/agent/costs.ts` — cost notification logic
- `src/transports/routes/todos.ts` — REST endpoints
- `web/src/pages/TodoList.tsx`, `TodoCreate.tsx`, `TodoEdit.tsx` — web pages
- `web/src/components/EisenhowerMatrix.tsx` — todo component
- `tests/tools/memory-tools.*.ts` — memory tool tests
- `tests/tools/*-todo*.ts` — todo tool tests
- `specs/todos.md` — todo spec

### Files to Edit (~25 files)
- `specs/schema.sql` — remove table definitions
- `specs/tools.spec.ts` — remove 9 tool specs
- `src/server.ts` — remove 9 tool registrations
- `src/db/queries/index.ts` — remove 2 re-exports
- `src/telegram/agent.ts` — remove pattern retrieval + cost + todo context
- `src/telegram/agent/language.ts` — remove pattern retrieval functions
- `src/telegram/agent/context.ts` — remove pattern injection from system prompt
- `src/telegram/agent/constants.ts` — remove pattern budget constants
- `src/telegram/agent/compaction.ts` — remove logApiUsage calls
- `src/telegram/agent/tools.ts` — remove logApiUsage calls
- `src/telegram/voice.ts` — remove logApiUsage calls
- `src/telegram/media.ts` — remove logApiUsage calls
- `src/notifications/on-this-day.ts` — remove logApiUsage calls
- `src/transports/http.ts` — remove todo route registration
- `src/db/queries/observability.ts` — remove patterns/todos from observable tables
- `web/src/api.ts` — remove todo API functions and types
- `web/src/main.tsx` — remove todo routes
- `web/src/pages/DbObservability.tsx` — remove todos from observable tables
- `tests/setup/per-test-setup.ts` — remove tables from TRUNCATE
- `tests/tools/export-parity.test.ts` — update expected exports count
- `tests/tools/http.test.ts` — remove todo mocks/tests
- `tests/tools/telegram-agent.test.ts` — remove pattern/cost mocks
- `tests/tools/telegram-voice.test.ts` — remove logApiUsage mock
- `tests/tools/telegram-media.test.ts` — remove logApiUsage mock
- `tests/tools/on-this-day-notification.test.ts` — remove logApiUsage mock
- `tests/tools/queries-fallbacks.test.ts` — remove cost function tests
- `tests/integration/queries.test.ts` — remove cost integration tests

### Migration Script
Create `scripts/migrations/NNN-drop-unused-tables.sql`:
```sql
DROP TABLE IF EXISTS pattern_observations CASCADE;
DROP TABLE IF EXISTS pattern_relations CASCADE;
DROP TABLE IF EXISTS pattern_aliases CASCADE;
DROP TABLE IF EXISTS pattern_entries CASCADE;
DROP TABLE IF EXISTS memory_retrieval_logs CASCADE;
DROP TABLE IF EXISTS patterns CASCADE;
DROP TABLE IF EXISTS todos CASCADE;
DROP TABLE IF EXISTS api_usage CASCADE;
DROP TABLE IF EXISTS cost_notifications CASCADE;
```

## Open Questions

None — all decisions resolved during brainstorming.

## Validation

After all changes, `pnpm check` must pass:
- TypeScript compilation (no dangling imports)
- ESLint (no unused imports/variables)
- Tests with coverage thresholds
