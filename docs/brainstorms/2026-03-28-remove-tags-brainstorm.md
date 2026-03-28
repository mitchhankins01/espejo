# Brainstorm: Remove Tags from Espejo

**Date:** 2026-03-28
**Status:** Decision made

## What We're Building

Remove the entire tag system from Espejo — database schema, query logic, MCP tools, REST API, web UI components, sync logic, and tests. Tags are unused manual metadata that add complexity without value, since semantic search (embeddings + BM25) already handles retrieval.

## Why This Approach

- Tags are manual-only — no automated pipeline produces them, and the user doesn't curate them
- Auto-generating tags would be redundant with what embeddings already capture
- Tags add complexity across every layer: schema (3 tables), queries (JOIN logic, filtering), tools (list_tags, filter params), API routes, web UI (TagInput component), sync, and tests
- YAGNI — removing dead abstractions simplifies maintenance and reduces cognitive overhead

## Key Decisions

- **Full removal over soft deprecation** — no point keeping dead tables in the schema
- **Remove from all entity types** — entries, artifacts, todos, and templates
- **Remove the `list_tags` MCP tool entirely**
- **Remove tag filter params** from search_entries, search_artifacts, search_content, list_artifacts
- **Remove TagInput component** from web frontend
- **Migration needed** to drop `tags`, `entry_tags`, and `artifact_tags` tables, and drop `tags` columns from `todos` and `knowledge_artifacts`, and `default_tags` from `entry_templates`

## Scope

Affected areas:
- **Schema:** `tags`, `entry_tags`, `artifact_tags` tables; `tags TEXT[]` on todos/artifacts; `default_tags TEXT[]` on templates
- **Queries:** entries.ts, artifacts.ts, content-search.ts, templates.ts, todos.ts (tag-related functions and filter logic)
- **Tools:** list-tags.ts (delete), search.ts, search-artifacts.ts, search-content.ts, list-artifacts.ts (remove tag params)
- **Formatters:** mappers.ts (toTagCount), artifact.ts (tag display)
- **API routes:** entries.ts, artifacts.ts (tag endpoints and params)
- **Web UI:** TagInput.tsx (delete), all pages that use it, api.ts client functions
- **Specs:** tools.spec.ts (remove tag-related tool and params)
- **Tests:** list-tags, normalize-tags, tag filtering in integration tests
- **Sync:** sync-dayone.ts (tag import), obsidian sync (tag extraction)
- **Server:** server.ts (list_tags registration)

## Open Questions

None — decision is clear.
