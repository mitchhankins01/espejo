# Obsidian Vault Sync via R2

**Date:** 2026-03-19
**Status:** Ready for planning

## What We're Building

A sync pipeline that pulls Obsidian markdown notes from a Cloudflare R2 bucket ("artifacts", written by Remotely Save) into the `knowledge_artifacts` table, maintaining embeddings, full-text search, wiki link relationships, and atomicity nudges via the Telegram agent.

### Core Flow

1. **In-process cron** polls R2 bucket every 30 minutes (like Oura sync / insight engine pattern)
2. `ListObjectsV2` enumerates all `.md` files, skipping `.canvas`, `.base`, and other non-markdown files
3. Compare each file's `ETag` against stored `content_hash` on the artifact — skip unchanged files
4. Download changed/new files via `GetObjectCommand`
5. Parse markdown: extract YAML frontmatter (kind, tags), title (first `# heading` or filename), body, and `[[wiki links]]`
6. Upsert into `knowledge_artifacts` with `ON CONFLICT (source_path) DO UPDATE`:
   - Set `embedding = NULL` on content change (re-embedded by `pnpm embed`)
   - `tsv` column auto-updates (it's `GENERATED ALWAYS` from title + body)
   - Store R2 `ETag` as `content_hash` for next sync's change detection
7. Parse `[[wiki links]]` and resolve to artifact IDs, store in `artifact_links` via `syncExplicitLinks()`
8. **Soft-delete** artifacts whose `source_path` no longer exists in R2 — null out `embedding`, set a `deleted_at` timestamp, exclude from search/list queries. If a previously deleted file reappears, the upsert clears `deleted_at` (un-delete)
9. Expose via MCP tools consistent with existing tool patterns

### Atomicity Nudges

Every note should be atomic — one idea, one note. We don't enforce this at the schema level. Instead:

- **Wiki links make splitting easy** — extracting an idea into its own note and linking back is the natural workflow
- **Search + graph reward atomic notes** — small focused notes rank better and form meaningful graph clusters
- **Telegram agent nudges** — when the sync picks up a new or changed note, send it to the LLM (haiku, for cost) to assess whether it's atomic. If non-atomic, the agent sends a Telegram message with suggested split points

## Why This Approach

- **ETag-based change detection** avoids downloading unchanged files — R2 ETags are MD5 hashes of content, free with `ListObjectsV2`
- **In-process timer with advisory lock** matches Oura sync and insight engine patterns — no extra infra, runs when server is up, prevents overlap
- **Embedding nullification on write** lets the existing `pnpm embed` pipeline handle re-embedding — no new embedding infra needed
- **`artifact_links` already exists** — wiki link relationships slot directly into the existing graph system

## Key Decisions

### Artifact Kinds (Simplified)

Drop `theory`, `model`, `log`. New set:

| Kind | Use Case |
|------|----------|
| `insight` | Self-reflection conclusions ("I cope with stress by...") |
| `reference` | Things consumed — books, articles, podcasts, conversations |
| `note` | Fleeting thoughts, observations, ideas |
| `project` | Discrete initiatives — taxes, hobby projects, trip planning |

Kind is set via YAML frontmatter (`kind: reference`), defaults to `note`.

### Schema Changes

- Add `source_path TEXT` column to `knowledge_artifacts` — stores R2 key (vault-relative path), used as natural key for upserts
- Add `content_hash TEXT` column to `knowledge_artifacts` — stores R2 ETag for change detection
- Add `source TEXT` column to `knowledge_artifacts` — `'obsidian'` vs `'web'` vs `'telegram'`, guards upserts like entries do
- Add `deleted_at TIMESTAMPTZ` column to `knowledge_artifacts` — soft-delete for notes removed from vault
- Update `kind` CHECK constraint: `('insight', 'reference', 'note', 'project')` — no migration needed, only `insight` artifacts exist today
- Add partial unique index on `source_path WHERE source_path IS NOT NULL` for conflict resolution (web/telegram artifacts won't have one)
- Vault bucket is hardcoded as `"artifacts"` — no new env var needed, distinct from the `"espejo-media"` bucket used for Day One media

### File Filtering

- Sync only `.md` files
- Skip `.canvas`, `.base`, and any non-markdown files
- Skip files in Obsidian system folders (`.obsidian/`, `.trash/`)

### Frontmatter Parsing

```yaml
---
kind: reference
tags: [books, psychology]
---
```

- `kind` → maps to artifact kind, default `note`
- `tags` → synced to `artifact_tags`
- Title extracted from first `# heading`, falls back to filename (without `.md`)

### Wiki Link Resolution

- Parse `[[Note Title]]` and `[[Note Title|Display Text]]` from body
- Resolve to artifact IDs by matching `title` or `source_path` (filename without extension)
- Store as `artifact_links` (source → target)
- Unresolvable links are logged but not stored — they'll resolve on next sync when the target note arrives
- Two-pass sync: first upsert all artifacts, then resolve all wiki links

### MCP Tools

Follow existing patterns (spec in `tools.spec.ts`, handler in `src/tools/`, SQL in `src/db/queries/`):

- **`sync_obsidian_vault`** — manually trigger a sync (in addition to cron)
- **`get_obsidian_sync_status`** — last sync time, file count, pending embeddings, errors

### Telegram Agent: Atomicity Nudges

After sync completes, for each new or updated note:

- Send note content to LLM (claude-haiku for cost) asking whether the note is atomic or covers multiple topics
- If non-atomic, agent sends a proactive Telegram message with the LLM's suggested split points
- Multiple non-atomic notes in one sync are batched into a single message

## Open Questions

None — all questions resolved through discussion.

## Scope Boundaries (YAGNI)

- No real-time webhook from R2 (polling via cron is sufficient)
- No conflict resolution for edits in both Obsidian and web UI (Obsidian is source of truth for `source = 'obsidian'` artifacts)
- No folder → kind mapping (frontmatter only)
- No auto-embedding during sync (existing `pnpm embed` handles it)
- No Obsidian plugin or write-back to R2
