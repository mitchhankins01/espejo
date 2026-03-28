---
title: Remove Tag System
type: refactor
status: completed
date: 2026-03-28
origin: docs/brainstorms/2026-03-28-remove-tags-brainstorm.md
---

# Remove Tag System

## Overview

Strip the entire tag system from Espejo — database tables, columns, query logic, MCP tools, REST API endpoints, web UI, sync scripts, formatters, tests, and specs. Tags are unused manual metadata that add complexity without value; semantic search (embeddings + BM25) already handles retrieval.

## Problem Statement / Motivation

Tags add complexity across every layer of the stack (~80 files) but provide zero value:
- Tags are manual-only — no automated pipeline produces them
- The user never curates tags
- Auto-generating tags would be redundant with embeddings
- YAGNI: removing dead abstractions simplifies maintenance

(see brainstorm: docs/brainstorms/2026-03-28-remove-tags-brainstorm.md)

## Proposed Solution

Full removal in a single coordinated effort, working bottom-up: schema → specs → shared types → queries → tools → formatters → routes → web UI → sync scripts → tests → docs.

## Technical Considerations

### Deploy Ordering

Per the Main Branch Release Protocol, `pnpm migrate` runs before `git push`. This means there's a brief window where old code queries dropped tables. For a single-user project, accept brief errors during the ~60s deploy window rather than adding a two-phase migration.

### Obsidian Parser Resilience

Existing Obsidian vault `.md` files will still have `tags: [...]` in YAML frontmatter. The zod schema in `src/obsidian/parser.ts` must use default strip behavior (not `.strict()`) so unknown keys are silently ignored after removing `tags` from the schema. Verify before removing.

### Graph View

The artifact graph computes `"tag"` edges by comparing tag arrays between artifacts. These edges disappear. Since tags are unused, these were noise edges — removal improves graph signal quality.

### Migration Safety

Postgres DDL is transactional. Drop junction tables before the `tags` table (FK ordering). Use `IF EXISTS` / `IF EXISTS` for idempotency.

## Acceptance Criteria

- [ ] Migration drops `tags`, `entry_tags`, `artifact_tags` tables and `tags` columns from `knowledge_artifacts`, `todos`, `entry_templates`
- [ ] `specs/schema.sql` updated to remove all tag-related DDL
- [ ] `specs/tools.spec.ts` removes `list_tags` tool and all tag params from other tools
- [ ] `packages/shared/src/types.ts` removes `tags` from all interfaces
- [ ] `list_tags` MCP tool deleted and unregistered
- [ ] Tag filter params removed from `search_entries`, `search_artifacts`, `search_content`, `list_artifacts`
- [ ] Tag fields removed from `create_todo`, `update_todo`
- [ ] All tag-related query functions deleted (`listTags`, `upsertEntryTags`, `upsertArtifactTags`, `getArtifactTagsMap`, `listArtifactTags`, `normalizeTags`)
- [ ] Tag subqueries removed from all entry/artifact SELECT statements
- [ ] REST endpoints `GET /api/entries/tags` and `GET /api/artifacts/tags` removed
- [ ] `TagInput.tsx` component deleted
- [ ] All web pages updated to remove tag state, rendering, and API calls
- [ ] DayOne sync stripped of tag import logic
- [ ] Obsidian parser/sync stripped of tag extraction (resilient to existing frontmatter)
- [ ] All tag-related tests removed or updated
- [ ] `pnpm check` passes (types, lint, tests with coverage thresholds)
- [ ] CLAUDE.md updated

## Implementation Phases

### Phase 1: Schema & Specs (foundation)

Update the source-of-truth files that everything else derives from.

1. **Write migration SQL** (`scripts/migrations/XXX-drop-tags.sql`):
   ```sql
   DROP TABLE IF EXISTS entry_tags;
   DROP TABLE IF EXISTS artifact_tags;
   DROP TABLE IF EXISTS tags;
   DROP INDEX IF EXISTS idx_knowledge_artifacts_tags;
   ALTER TABLE knowledge_artifacts DROP COLUMN IF EXISTS tags;
   ALTER TABLE todos DROP COLUMN IF EXISTS tags;
   ALTER TABLE entry_templates DROP COLUMN IF EXISTS default_tags;
   ```

2. **Update `specs/schema.sql`** — remove `tags`, `entry_tags`, `artifact_tags` table definitions, `idx_tags_name` index, `tags TEXT[]` from `knowledge_artifacts`/`todos`, `default_tags TEXT[]` from `entry_templates`, `idx_knowledge_artifacts_tags` index, `artifact_tags` table definition.

3. **Update `specs/tools.spec.ts`** — delete `list_tags` tool spec, remove `tags`/`tags_mode` params from `search_entries`, `list_artifacts`, `search_artifacts`, `search_content`, `create_todo`, `update_todo`. Remove `tags` from `EntryResult`, `ArtifactResult`, `ArtifactSearchResult`. Delete `TagCount` interface.

4. **Update `packages/shared/src/types.ts`** — remove `tags: string[]` from all interfaces.

5. **Delete `specs/web-tag-filtering.md`**.

### Phase 2: Query Layer

Remove all tag SQL and functions.

1. **`src/db/queries/artifacts.ts`** — delete `normalizeTags`, `upsertArtifactTags`, `getArtifactTagsMap`, `listArtifactTags`. Remove `tags`/`tags_mode` from filters. Remove `tagsMap` usage from all functions. Remove `tags` from row interfaces.

2. **`src/db/queries/entries.ts`** — delete `listTags`, `upsertEntryTags`. Remove tag subqueries from all SELECTs (the `COALESCE(array_agg(...))` pattern). Remove tag filter from `searchEntries` and `listEntries`. Remove `tags` from interfaces. Remove `normalizeTags` import.

3. **`src/db/queries/content-search.ts`** — remove `entry_tags`/`artifact_tags` filter params and clauses. Remove `normalizeTags` import.

4. **`src/db/queries/todos.ts`** — remove `tags` from `TodoRow`, `TODO_COLUMNS`, `toTodoRow`, `createTodo`, `updateTodo`. Remove `normalizeTags` import.

5. **`src/db/queries/templates.ts`** — remove `default_tags` from `TemplateRow`, `TEMPLATE_COLUMNS`, `toTemplateRow`, `createTemplate`, `updateTemplate`.

6. **`src/db/queries/observability.ts`** — remove `tags` from schema metadata catalogs.

### Phase 3: Tools & Server

1. **Delete `src/tools/list-tags.ts`**.
2. **`src/server.ts`** — remove `handleListTags` import and `list_tags` handler registration.
3. **Modify tools** — remove tag params from: `search.ts`, `search-artifacts.ts`, `search-content.ts`, `list-artifacts.ts`, `create-todo.ts`, `update-todo.ts`.

### Phase 4: Formatters

1. **`src/formatters/mappers.ts`** — delete `toTagCount`, remove `tags` from `toEntryResult`.
2. **`src/formatters/entry.ts`** — remove tag rendering block.
3. **`src/formatters/search-results.ts`** — remove tag rendering.
4. **`src/formatters/artifact.ts`** — remove `tags` from output.

### Phase 5: REST API Routes

1. **`src/transports/routes/entries.ts`** — delete `GET /api/entries/tags` endpoint, remove `tag` filter from list, remove `tags` from create/update schemas.
2. **`src/transports/routes/artifacts.ts`** — delete `GET /api/artifacts/tags` endpoint, remove `tags`/`tags_mode` params from list/search, remove tag graph edges (`hasSharedTag` loop), remove `tags` from create/update schemas.
3. **`src/transports/routes/todos.ts`** — remove `tags` from create/update schemas.
4. **`src/transports/routes/templates.ts`** — remove `default_tags` from create/update schemas.

### Phase 6: Web Frontend

1. **Delete `web/src/components/TagInput.tsx`**.
2. **`web/src/api.ts`** — remove `tags` from all interfaces and data types, delete `fetchArtifactTags`/`fetchEntryTags`, remove tag params from list/search functions, update `GraphEdge` type to remove `"tag"`.
3. **Update pages** (remove TagInput imports, tag state, tag rendering):
   - `ArtifactList.tsx` — remove tag filter UI, `allTags` state, `fetchArtifactTags` calls
   - `ArtifactCreate.tsx`, `ArtifactEdit.tsx` — remove tag input field
   - `EntryCreate.tsx`, `EntryEdit.tsx` — remove tag input field and suggestions
   - `EntryList.tsx` — remove tag badges
   - `TodoCreate.tsx`, `TodoEdit.tsx` — remove tag input field
   - `TodoList.tsx` — remove tag badges
   - `TemplateCreate.tsx`, `TemplateEdit.tsx` — remove default_tags field
   - `TemplateList.tsx` — remove tag badges
4. **`web/src/components/GraphView.tsx`** — remove `"tag"` edge type handling.

### Phase 7: Sync Scripts

1. **`scripts/sync-dayone.ts`** — remove tag schema resolution, `tagsByEntry` map building, all tag upsert logic (DELETE FROM entry_tags, INSERT INTO tags, INSERT INTO entry_tags).
2. **`src/obsidian/parser.ts`** — remove `tags` from zod frontmatter schema, remove `normalizeTags` import, remove `tags` from parsed result. Verify zod uses default strip mode.
3. **`src/obsidian/sync.ts`** — remove tag sync block (DELETE FROM artifact_tags + upsertArtifactTags).
4. **`src/obsidian/extraction.ts`** — remove `tags` from zod schema, interface, LLM prompt, example output, and markdown formatting.
5. **`scripts/migrate-entries-to-artifacts.ts`** — remove `tags` from INSERT statement.
6. **`scripts/reprocess-pending.ts`** — remove tags from zod schema, interface, LLM prompt, and markdown formatting.

### Phase 8: Tests & Fixtures

1. **Delete** `tests/tools/list-tags.test.ts`, `tests/tools/normalize-tags.test.ts`.
2. **`specs/fixtures/seed.ts`** — remove `tags` from fixture interfaces and all tag-seeding SQL.
3. **`tests/setup/per-test-setup.ts`** — remove `entry_tags`, `tags`, `artifact_tags` from TRUNCATE.
4. **Update ~15 test files** — remove `tags: []` from fixtures, remove tag-related assertions, remove tag filter tests. Key files: `queries.test.ts`, `handlers.test.ts`, `server.test.ts`, `search.test.ts`, `search-artifacts.test.ts`, `artifact-handlers.test.ts`, `create-todo.test.ts`, `update-todo.test.ts`, `entry.test.ts`, `search-results.test.ts`, `parser.test.ts`.

### Phase 9: Documentation

1. **`CLAUDE.md`** — remove `list-tags.ts` from directory map, remove "Tags Are Normalized" section, update tool descriptions to remove tag mentions.
2. **`docs/architecture.md`** — remove tag endpoint docs.
3. **Spec files** — remove tag references from `knowledge-artifacts.md`, `todos.md`, `web-app.spec.md`, `web-journaling.md`, `web-graph-view.md`, etc.

## Success Metrics

- `pnpm check` passes with all coverage thresholds met
- No references to `tags`, `entry_tags`, `artifact_tags`, `TagInput`, `listTags`, `normalizeTags` remain in src/ or web/src/ (verified by grep)
- Schema.sql has zero tag-related DDL

## Dependencies & Risks

- **Deploy window**: ~60s where old code hits new schema. Acceptable for single-user app.
- **Obsidian frontmatter**: Must verify parser uses strip mode, not strict mode.
- **Coverage thresholds**: Removing tag tests may affect coverage ratios. May need to adjust if removing tests drops below 95/95/90/95.
- **No data loss risk**: Tags contain no user-curated data.

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-28-remove-tags-brainstorm.md](docs/brainstorms/2026-03-28-remove-tags-brainstorm.md) — decision: full removal over soft deprecation, YAGNI rationale, scope inventory
