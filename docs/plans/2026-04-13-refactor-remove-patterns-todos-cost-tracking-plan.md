---
title: "refactor: Remove patterns, todos, and API cost tracking"
type: refactor
status: completed
date: 2026-04-13
origin: docs/brainstorms/2026-04-13-dead-code-cleanup-brainstorm.md
---

# refactor: Remove patterns, todos, and API cost tracking

## Overview

Remove three unused systems from the espejo codebase in a single sweep: the pattern/memory system (6 tables, 4 MCP tools), the todos system (1 table, 5 MCP tools, REST routes, web pages), and API cost tracking (2 tables, per-call logging across 6+ files). This is a pure deletion — no new functionality.

## Problem Statement

These systems were built but never became useful:
- Pattern memory adds latency (embedding + hybrid search) to every Telegram message without providing value
- The todo system duplicates functionality available elsewhere
- API cost tracking adds noise without actionable insight

Dead code increases maintenance burden, test surface, cognitive overhead, and makes `pnpm check` slower.

## Proposed Solution

Single branch, single PR. Systematic bottom-up removal following the precedent set by the tags removal (see `docs/plans/2026-03-28-refactor-remove-tags-plan.md`). Work order: migration → schema → specs → queries → tools → agent → routes → web → tests → docs.

(See brainstorm: `docs/brainstorms/2026-04-13-dead-code-cleanup-brainstorm.md` for decision rationale on single-sweep vs. staged approach.)

## Implementation Phases

### Phase 1: Migration Script

Add migration `038-drop-patterns-todos-cost` to the `migrations` array in `scripts/migrate.ts` (after `037-artifact-duplicate-of`):

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

FK cascade order: dependent tables before primary. All use `IF EXISTS` for idempotency. `CASCADE` handles self-referencing FK on `todos.parent_id`.

**Also** remove the corresponding `CREATE TABLE`, index, trigger, and function definitions from `specs/schema.sql`. The tables being removed span multiple sections — search for each table name.

### Phase 2: Remove Tool Specs + Shared Schema Helpers

**`specs/tools.spec.ts`:**
- Remove `memoryKindParam` (shared zod schema, ~line 78-80)
- Remove 9 tool spec entries: `remember`, `save_chat`, `recall`, `reflect`, `list_todos`, `create_todo`, `update_todo`, `complete_todo`, `set_todo_focus`
- Check if `WRITE_ADDITIVE` annotation preset becomes unused after removing `save_chat` and `create_todo`. If so, remove it.

### Phase 3: Remove Query Modules

**Delete entirely:**
- `src/db/queries/patterns.ts` — all pattern queries, logMemoryRetrieval, logApiUsage, cost notification functions
- `src/db/queries/todos.ts` — all todo queries

**Edit `src/db/queries/index.ts`:**
- Remove `export * from "./patterns.js";`
- Remove `export * from "./todos.js";`

### Phase 4: Remove Tool Implementations

**Delete 9 files:**
- `src/tools/remember.ts`
- `src/tools/save-chat.ts`
- `src/tools/recall.ts`
- `src/tools/reflect.ts`
- `src/tools/list-todos.ts`
- `src/tools/create-todo.ts`
- `src/tools/update-todo.ts`
- `src/tools/complete-todo.ts`
- `src/tools/set-todo-focus.ts`

**Edit `src/server.ts`:**
- Remove 9 import statements for the deleted tool handlers
- Remove 9 entries from the `toolHandlers` map

### Phase 5: Remove Memory Module

**Delete entire directory `src/memory/`:**
- `src/memory/extraction.ts` — `rememberPattern`, `extractPatternsFromChat`
- `src/memory/consolidation.ts` — `runMemoryConsolidation`

### Phase 6: Refactor Telegram Agent

This is the riskiest phase — pattern retrieval is in the hot path of every message.

**`src/telegram/agent.ts`:**
- Remove imports: `logMemoryRetrieval`, `PatternSearchRow`, `buildTodoContextPrompt`, `shouldRetrievePatterns`, `retrievePatterns`, `budgetCapPatterns`, `PATTERN_TOKEN_BUDGET`, `maybeBuildCostActivityNote`, `computeCost`
- Remove the entire pattern retrieval block (~lines 59-76): `shouldRetrievePatterns` → `retrievePatterns` → `budgetCapPatterns` → `logMemoryRetrieval`
- Remove `buildTodoContextPrompt(pool)` call from context building
- Remove `maybeBuildCostActivityNote` call
- Remove `computeCost` calls that feed `logApiUsage`
- Remove all `logApiUsage` calls
- Simplify activity logging: remove `memories` field, remove `patternCount`/`patternKinds` from activity summary, remove `"memory degraded"` activity string
- Remove `patternCount` from `AgentResult` interface
- Update callers of `runAgent()` that read `patternCount` from the result

**`src/telegram/agent/context.ts`:**
- Remove `PatternSearchRow` import
- Change `buildSystemPrompt` signature: remove `patterns` and `memoryDegraded` parameters
- Remove the pattern injection block that appends "Relevant patterns from past conversations"
- Remove memory degraded notice
- **Update system prompt prose**: remove references to "long-term memory", "remember patterns", "Memory tools are available: use remember to store...", "memory operations", "todo management". The agent will hallucinate about tools it doesn't have if these remain.

**Delete `src/telegram/agent/language.ts`** (or gut it):
- Contains `shouldRetrievePatterns`, `retrievePatterns`, `budgetCapPatterns`, `mmrRerank` — all pattern-only functions
- Also contains `logApiUsage` calls for embedding costs
- If Spanish coaching functions exist in this file, extract them first; otherwise delete entirely

**Delete `src/telegram/agent/costs.ts`:**
- `computeCost`, `formatUsd`, `maybeBuildCostActivityNote` — all dead after removing cost tracking

**`src/telegram/agent/constants.ts`:**
- Remove: `PATTERN_TOKEN_BUDGET`, `MIN_RETRIEVAL_CHARS`, `RETRIEVAL_BASE_MIN_SIMILARITY`, `RETRIEVAL_SHORT_QUERY_MIN_SIMILARITY`, `RETRIEVAL_SCORE_FLOOR_DEFAULT`, `RETRIEVAL_SCORE_FLOOR_SHORT_QUERY`

**`src/telegram/agent/compaction.ts`:**
- Remove `logApiUsage` import and calls

**`src/telegram/agent/tools.ts`:**
- Remove `logApiUsage` import and calls
- Remove `computeCost` import and calls

**`src/telegram/voice.ts`:**
- Remove `logApiUsage` import and calls

**`src/telegram/media.ts`:**
- Remove `logApiUsage` import and calls

**`src/notifications/on-this-day.ts`:**
- Remove `logApiUsage` import and calls

### Phase 7: Remove Todo Context + Routes

**Delete:**
- `src/todos/context.ts` — `buildTodoContextPrompt`
- `src/transports/routes/todos.ts` — all REST endpoints

**Edit `src/transports/http.ts`:**
- Remove `import { registerTodoRoutes }` and `registerTodoRoutes(app, deps)` call
- Remove `import { runMemoryConsolidation }` and the `runMemoryMaintenance` function + its integration with `runAfterSync`

### Phase 8: Remove from Observability

**`src/db/queries/observability.ts`:**
- Remove `"patterns"` and `"todos"` from `OBSERVABLE_DB_TABLES` array
- Remove their entries from `OBSERVABLE_DB_TABLE_CONFIG` (column definitions, sort columns, searchable columns)
- The `activity_logs.memories` column: leave it. Historical rows contain pattern data in JSONB. The column is harmless — just always `[]` going forward. Remove the `ActivityLogMemory` interface if it exists as a standalone type.

### Phase 9: Remove from Web Frontend

**Delete 4 files:**
- `web/src/pages/TodoList.tsx`
- `web/src/pages/TodoCreate.tsx`
- `web/src/pages/TodoEdit.tsx`
- `web/src/components/EisenhowerMatrix.tsx`

**`web/src/main.tsx`:**
- Remove imports for `TodoList`, `TodoCreate`, `TodoEdit`
- Remove 3 `<Route>` definitions for `/todos`, `/todos/new`, `/todos/:id`

**`web/src/components/AuthGate.tsx`:**
- Remove "Todos" nav link
- Remove `onTodos` location check
- Update `onKnowledge` computation to remove `!onTodos`

**`web/src/api.ts`:**
- Remove `TodoStatus` type, `Todo` interface
- Remove `"todos"` and `"patterns"` from `ObservableDbTableName` union type
- Remove all todo API functions: `listTodos`, `getTodo`, `createTodo`, `updateTodo`, `deleteTodo`, `completeTodo`, `setFocus`, `clearFocus`, `getFocus`

**`web/src/pages/DbObservability.tsx`:**
- Remove `"todos"` and `"patterns"` from `OBSERVABLE_TABLE_NAMES` array
- Remove todo/pattern row detail link handling

**Check `web/src/components/StatusSelect.tsx`:** If only used by todo pages, delete it.

### Phase 10: Update Tests

**Delete test files:**
- `tests/tools/memory-tools.handlers.test.ts`
- `tests/tools/memory-tools.spec.test.ts`
- `tests/tools/list-todos.test.ts`
- `tests/tools/create-todo.test.ts`
- `tests/tools/update-todo.test.ts`
- `tests/tools/complete-todo.test.ts`
- `tests/tools/set-todo-focus.test.ts`

**`tests/setup/per-test-setup.ts`:**
- Remove from TRUNCATE: `pattern_observations`, `pattern_relations`, `pattern_aliases`, `pattern_entries`, `patterns`, `api_usage`, `memory_retrieval_logs`, `cost_notifications`, `todos`

**`tests/tools/export-parity.test.ts`:**
- Remove ~31 function names from the expected exports list (20 pattern functions + 5 cost functions + logMemoryRetrieval + 8 todo functions — verify exact count)
- Update `expected_count()` return value from `107` to the new total

**`tests/tools/telegram-agent.test.ts`:**
- Remove mock declarations for `logApiUsage`, `getLastCostNotificationTime`, `getTotalApiCostSince`, `insertCostNotification`, `searchPatternsHybrid`, `logMemoryRetrieval`
- Remove test cases that validate pattern retrieval, memory degraded states, cost notifications
- Update assertions on `AgentResult` to not expect `patternCount`

**`tests/tools/telegram-voice.test.ts`:**
- Remove `logApiUsage` mock

**`tests/tools/telegram-media.test.ts`:**
- Remove `logApiUsage` mock

**`tests/tools/on-this-day-notification.test.ts`:**
- Remove `logApiUsage` mock and assertions

**`tests/tools/queries-fallbacks.test.ts`:**
- Remove cost function imports and test cases

**`tests/integration/queries.test.ts`:**
- Remove pattern and cost query test blocks
- Remove todo query test blocks

**`tests/tools/http.test.ts`:**
- Remove todo mock declarations and function definitions
- Remove todo test cases
- Remove todos from mocked queries object and mock reset calls
- Remove "todos" from observable table checks

### Phase 11: Update Documentation

**`CLAUDE.md`:**
- Remove from Directory Map: `patterns.ts`, `todos.ts`, `remember.ts`, `save-chat.ts`, `recall.ts`, `reflect.ts`, `list-todos.ts`, `create-todo.ts`, `update-todo.ts`, `complete-todo.ts`, `set-todo-focus.ts`, `todos/context.ts`, `agent/costs.ts`, `memory/extraction.ts`, `memory/consolidation.ts`, `routes/todos.ts`
- Update `agent/language.ts` description (if file survives with only Spanish functions)
- Remove `agent/costs.ts` from directory map
- Remove references to pattern memory from architecture overview
- Remove todo-related items from tool list

**Delete `specs/todos.md`** — the spec for the removed todo system.

## Acceptance Criteria

- [x] `pnpm check` passes (types + lint + tests + coverage)
- [x] Migration `038-drop-patterns-todos-cost` drops all 9 tables
- [x] No TypeScript references to deleted modules (clean compile)
- [x] No dangling imports or unused variables (ESLint clean)
- [x] Telegram agent processes messages without pattern retrieval
- [x] System prompt does not mention memory tools or todo management
- [x] Web app loads without todo routes or nav links
- [x] DB observability page does not list dropped tables
- [x] Export parity test passes with updated count
- [x] Test TRUNCATE does not reference dropped tables

## Dependencies & Risks

**Risk: Brief deploy window errors.** Per Main Branch Release Protocol, `pnpm migrate` runs before `git push`. During the ~60s deploy, old code may query dropped tables. Acceptable for a single-user project (see precedent: tags removal plan).

**Risk: Telegram agent behavior change.** The agent loses long-term memory and cost awareness. This is intentional — confirmed during brainstorming.

**Risk: Missing a reference.** TypeScript strict mode + ESLint + export-parity test form a safety net. If any import references a deleted module, `tsc --noEmit` catches it. Run `pnpm check` after each phase.

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-04-13-dead-code-cleanup-brainstorm.md](docs/brainstorms/2026-04-13-dead-code-cleanup-brainstorm.md) — single-sweep approach, migration script, no agent memory replacement, remove all cost tracking
- **Precedent:** [docs/plans/2026-03-28-refactor-remove-tags-plan.md](docs/plans/2026-03-28-refactor-remove-tags-plan.md) — established bottom-up removal order, FK cascade ordering, deploy window error tolerance
- **Migration system:** `scripts/migrate.ts` — inline migrations array, `_migrations` tracking table, next number is `038`
