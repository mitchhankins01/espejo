---
title: "feat: Migrate journaling from Day One to Obsidian"
type: feat
status: active
date: 2026-03-28
updated: 2026-04-10
origin: docs/brainstorms/2026-03-28-obsidian-migration-brainstorm.md
---

# Migrate Journaling from Day One to Obsidian

## Overview

Unify journal entries and knowledge artifacts in a single Obsidian vault so they can interlink via `[[wiki links]]`, and eliminate the laptop dependency for the sync/embed pipeline. Entries will flow through the same server-side Obsidian sync that artifacts already use: Obsidian → Obsidian Sync → R2 → server timer → PG + embeddings.

PG + pgvector remains the search backend. Obsidian becomes the authoring surface.

## Problem Statement / Motivation

1. **Laptop dependency**: The current pipeline requires a Mac with DayOne.sqlite to run `pnpm sync && pnpm embed`. The evening review can't access today's entries without this manual step.
2. **Data ownership**: Day One stores data in a proprietary SQLite format. Markdown files are portable and future-proof.
3. **Interlinking**: Entries and artifacts live in separate systems today. Unifying them in Obsidian enables `[[wiki links]]` between journal entries and knowledge artifacts — the primary payoff.

(see brainstorm: `docs/brainstorms/2026-03-28-obsidian-migration-brainstorm.md`)

## Decisions (Resolved)

- **D1: Obsidian-only authoring.** Obsidian is the sole authoring surface for journal entries. The web UI is being deprecated. Telegram does not create entries. No write-back needed.
- **D2: No conflict resolution needed.** With no web UI or Telegram entry creation, Obsidian is the only writer. No conflicts possible.
- **D3: All entries use soft-delete.** Consistent behavior across all sources. The query changes are mechanical.

## Proposed Solution

### Architecture

```
┌─────────────────┐     Obsidian Sync     ┌─────────────┐
│  Obsidian Vault  │ ──────────────────▶  │     R2      │
│  (iOS/Desktop)   │                      │  artifacts  │
│                  │ ◀──────────────────  │   bucket    │
│  Journal/        │     Obsidian Sync     │             │
│  Insights/       │                      │  Journal/   │
│  References/     │                      │  Insights/  │
│  Attachments/    │                      │  Attach…/   │
└─────────────────┘                      └──────┬──────┘
                                                │
                                     Server timer (30min)
                                                │
                                         ┌──────▼──────┐
                                         │  PostgreSQL  │
                                         │             │
                                         │  entries    │ ← Journal/ files
                                         │  artifacts  │ ← everything else
                                         │  media      │ ← parsed from ![[embeds]]
                                         │  embeddings │ ← auto-embed timer
                                         └─────────────┘
```

### Vault Structure

```
Journal/
  2025-11-15.md           ← one entry per day (or -2, -3 for multiples)
  2025-11-15-2.md
  2025-11-16.md
Attachments/
  abc123def456.jpeg       ← MD5-based filenames (unique, no collisions)
  789xyz012345.mp4
Insights/
  some-insight.md         ← existing artifact structure unchanged
References/
  some-reference.md
...
```

Media uses MD5-based filenames in a shared `Attachments/` folder (Obsidian's default attachment handling). This avoids filename collisions and matches the existing `{md5}.{ext}` pattern from DayOne sync.

### Entry Markdown Format

```markdown
---
uuid: ABE997F429E748D096E2A259B6C382D4
created_at: 2025-11-15T08:30:00+01:00
updated_at: 2025-12-15T08:34:00+01:00
---

Woke up feeling depleted...

![[abc123def456.jpeg]]

The nicotine yesterday definitely crashed my dopamine baseline.

See also [[The Attachment Wound Hypothesis]].
```

- `uuid`: Present on backfilled entries (from Day One). Absent on new Obsidian entries (generated on first sync).
- `created_at`: ISO 8601 with timezone. Required. Falls back to filename date if missing, then R2 `LastModified`.
- Body: Standard markdown. `![[filename]]` for media embeds. `[[Title]]` for wiki links.

## Implementation Phases

### Phase 1: Schema Migration

Add new columns to `entries` table and update constraints.

**Migration SQL** (`specs/schema.sql` + new migration file):

```sql
-- Add Obsidian sync columns to entries
ALTER TABLE entries ADD COLUMN source_path TEXT;
ALTER TABLE entries ADD COLUMN content_hash TEXT;
ALTER TABLE entries ADD COLUMN deleted_at TIMESTAMPTZ;

-- Partial unique index (same pattern as knowledge_artifacts)
CREATE UNIQUE INDEX idx_entries_source_path
  ON entries (source_path) WHERE source_path IS NOT NULL;

-- Add 'obsidian' to source CHECK constraint
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_source_check;
ALTER TABLE entries ADD CONSTRAINT entries_source_check
  CHECK (source IN ('dayone', 'web', 'telegram', 'mcp', 'obsidian'));
```

**Files changed:**
- `specs/schema.sql` — Add columns and constraint
- `scripts/migrate.ts` — New migration file
- `packages/shared/src/types.ts` — Add `source_path`, `content_hash`, `deleted_at` to entry types

**Success criteria:**
- [ ] Migration applies cleanly to dev and prod
- [ ] Existing entries unaffected (new columns nullable, constraint is superset)
- [ ] `pnpm check` passes

---

### Phase 2: Soft-Delete Entry Queries

Add `WHERE deleted_at IS NULL` filtering to all entry queries.

**Files changed:**
- `src/db/queries/entries.ts` — Every query that returns entries:
  - `searchEntries` (both semantic and BM25 branches)
  - `getEntriesByDateRange`
  - `getEntriesOnThisDay`
  - `findSimilarEntries`
  - `getEntryStats`
  - `listEntries`
  - `getEntryByUuid` (should still return soft-deleted entries with a flag, for direct access)
- `src/db/queries/content-search.ts` — Cross-type search entry branch
- `tests/` — Update test assertions for soft-delete filtering

**Pattern** (follow existing artifact soft-delete queries in `src/db/queries/artifacts.ts`):
```typescript
// Before
WHERE entries.text @@ query
// After
WHERE entries.text @@ query AND entries.deleted_at IS NULL
```

**Success criteria:**
- [ ] Soft-deleted entries excluded from search, date range, on-this-day, similar, stats, list
- [ ] `getEntryByUuid` still returns soft-deleted entries (for direct access/recovery)
- [ ] All tests pass with `pnpm check`

---

### Phase 3: Backfill Script — PG Entries → R2

One-time script: `scripts/export-entries-to-obsidian.ts`

**Steps:**
1. Query all entries from PG (with media joins)
2. For each entry, generate markdown with frontmatter (`uuid`, `created_at`)
3. Assign filenames: group by date, sort by `created_at ASC`, first gets `YYYY-MM-DD.md`, rest get `-2`, `-3` suffixes
4. Resolve `knowledge_artifact_sources` relationships → inject `[[Artifact Title]]` wiki links at the end of the body
5. For media: copy binary files from DayOne.sqlite `ZATTACHMENT` to R2 `artifacts` bucket under `Attachments/{md5}.{ext}`. Insert `![[{md5}.{ext}]]` in the markdown body where Day One had `dayone-moment://` references
6. Upload markdown to R2 `artifacts` bucket under `Journal/{filename}`
7. **Critical**: Update PG entries with `source_path`, `content_hash` (R2 etag), and `source = 'obsidian'` so the next Obsidian sync recognizes them as already-synced

**Idempotency:**
- Check R2 `HEAD` before uploading (skip if etag matches)
- Check `source_path IS NOT NULL` before updating PG rows (skip if already migrated)

**Media from DayOne.sqlite:**
- The script needs `DAYONE_SQLITE_PATH` env var (same as `sync-dayone.ts`)
- For entries synced with `--skip-media`, media rows may exist in PG but files don't exist in R2. The script reads from DayOne.sqlite's `ZATTACHMENT` table and copies the actual files
- `ZHASDATA=0` attachments (iCloud-only) are skipped with a warning

**Files created:**
- `scripts/export-entries-to-obsidian.ts`

**Success criteria:**
- [ ] All entries exported as markdown to R2 `Journal/` prefix
- [ ] Media files copied to R2 `Attachments/` prefix from DayOne.sqlite
- [ ] `![[media]]` embeds in markdown bodies resolve to correct files
- [ ] `[[wiki links]]` generated from `knowledge_artifact_sources`
- [ ] PG entries updated with `source = 'obsidian'`, `source_path`, `content_hash`
- [ ] Script is idempotent (safe to re-run)
- [ ] Obsidian vault shows entries with images after Obsidian Sync pulls from R2

---

### Phase 4: Extend Obsidian Sync for Journal Entries

Modify the existing sync pipeline to route `Journal/` files to the `entries` table.

**Changes to `src/obsidian/sync.ts`:**

The main `runObsidianSync` function currently:
1. Lists all `.md` files in R2
2. Filters by skip prefixes
3. Downloads changed files
4. Parses and upserts into `knowledge_artifacts`

**New behavior:**
1. Lists all `.md` files in R2 (unchanged)
2. Filters by skip prefixes (unchanged)
3. **Partition** files: `Journal/` prefix → entry pipeline, everything else → artifact pipeline (existing)
4. Downloads changed files (unchanged, but checks against `entries.content_hash` for journal files)
5. For journal files: parse with `parseJournalEntry()`, upsert into `entries` table
6. For artifact files: existing `parseObsidianNote()` + `upsertObsidianArtifact()` (unchanged)
7. Soft-delete: entries with `source = 'obsidian'` whose `source_path` no longer appears in R2 → set `deleted_at = NOW()`
8. Wiki link resolution: extended to include entry→artifact and artifact→entry links

**New parser function** (`src/obsidian/parser.ts`):

```typescript
interface ParsedJournalEntry {
  uuid: string | null;       // from frontmatter, null for new entries
  createdAt: Date;           // from frontmatter, fallback to filename date
  body: string;              // markdown body (frontmatter stripped)
  mediaRefs: string[];       // extracted ![[filename]] references
  wikiLinks: string[];       // extracted [[Title]] references
}

function parseJournalEntry(content: string, key: string): ParsedJournalEntry
```

Frontmatter Zod schema:
```typescript
const JournalFrontmatter = z.object({
  uuid: z.string().optional(),
  created_at: z.coerce.date().optional(),
}).passthrough();
```

`created_at` fallback chain: frontmatter → filename date parse (`YYYY-MM-DD`) → R2 `LastModified`.

**New query functions** (`src/db/queries/entries.ts`):

```typescript
// Upsert an Obsidian-sourced entry by source_path
function upsertObsidianEntry(pool, entry: {
  sourcePath: string;
  contentHash: string;
  uuid: string;       // generated if not in frontmatter
  text: string;
  createdAt: Date;
}): Promise<{ id: number; uuid: string }>

// Get all Obsidian-sourced entries for change detection
function getObsidianEntries(pool): Promise<Array<{ source_path: string; content_hash: string }>>

// Soft-delete entries whose source_path is no longer in R2
function softDeleteMissingObsidianEntries(pool, activeSourcePaths: string[]): Promise<number>
```

**Media parsing:**
- Extract `![[filename.ext]]` references from body
- Match against R2 file listing to get storage keys
- Upsert into `media` table with `entry_id`, `type` (inferred from extension), `storage_key` (R2 path)
- No separate URL needed — media is served from the vault

**Files changed:**
- `src/obsidian/sync.ts` — Partition logic, entry upsert calls, entry soft-delete
- `src/obsidian/parser.ts` — Add `parseJournalEntry()` function
- `src/db/queries/entries.ts` — Add `upsertObsidianEntry`, `getObsidianEntries`, `softDeleteMissingObsidianEntries`
- `src/db/queries/artifacts.ts` — May need minor updates for cross-type wiki link resolution

**Success criteria:**
- [ ] New journal entries in Obsidian appear in PG within 30 minutes
- [ ] Edited journal entries update in PG (embedding cleared, re-embedded automatically)
- [ ] Deleted journal entries soft-deleted in PG
- [ ] Media references parsed and stored in `media` table
- [ ] Wiki links between entries and artifacts resolved bidirectionally
- [ ] Existing artifact sync unaffected
- [ ] `pnpm check` passes

---

### Phase 5: Cleanup & Retirement

Guard and eventually remove the DayOne sync pipeline. Remove entry creation routes (Obsidian is sole authoring surface).

**Immediate (with Phase 4 deploy):**
- Add a guard to `scripts/sync-dayone.ts`: skip entries where PG row has `source = 'obsidian'` (prevents overwriting Obsidian edits with stale DayOne data)
- The existing `ON CONFLICT (uuid) DO UPDATE ... WHERE entries.source = 'dayone'` guard already handles this — verify it works
- Remove entry creation/editing REST API routes from `src/transports/routes/entries.ts` (keep read-only routes)
- Remove entry creation MCP tools if any exist

**After validation period (~2 weeks):**
- Remove `scripts/sync-dayone.ts` (or archive it)
- Remove `better-sqlite3` dependency
- Remove DayOne-specific text normalization from codebase (or keep in entry formatter if still needed)
- Remove web UI entry pages (`EntryCreate.tsx`, `EntryEdit.tsx`) — web UI is being deprecated
- Update CLAUDE.md to remove DayOne references

**Files changed:**
- `scripts/sync-dayone.ts` — Add source guard, then delete
- `src/transports/routes/entries.ts` — Remove POST/PUT/PATCH/DELETE routes
- `package.json` — Remove `better-sqlite3` dependency
- `CLAUDE.md` — Update sync documentation

**Success criteria:**
- [ ] DayOne sync does not overwrite Obsidian-sourced entries
- [ ] Entry creation/editing routes removed
- [ ] After validation: script removed, dependency removed

---

### Phase 6: iOS Capture Setup (Manual)

Not code changes — Obsidian mobile configuration.

1. **Daily Notes plugin**: Enable, set folder to `Journal/`, format `YYYY-MM-DD`
2. **Templater plugin**: Create template at `Templates/Journal.md`:
   ```markdown
   ---
   created_at: <% tp.date.now("YYYY-MM-DDTHH:mm:ssZ") %>
   ---


   ```
3. **Daily Notes template**: Point to `Templates/Journal.md`
4. **iOS Shortcut**: Create automation — time-based trigger (morning) → open Obsidian URI `obsidian://daily`
5. **Obsidian Sync**: Confirm vault syncs to all devices and R2

**Success criteria:**
- [ ] Morning notification opens Obsidian to today's daily note with template
- [ ] Entry syncs to R2 within minutes via Obsidian Sync
- [ ] Server picks up new entry on next 30-minute sync cycle

## System-Wide Impact

### Interaction Graph

Entry creation: Obsidian → Obsidian Sync → R2 → `runObsidianSync` timer → `upsertObsidianEntry` → `entries` table → embedding cleared → `runEmbedPending` callback → embedding generated → available for search/evening review.

Entry deletion: File removed from vault → Obsidian Sync removes from R2 → `runObsidianSync` detects missing → `softDeleteMissingObsidianEntries` → `deleted_at = NOW()` → excluded from queries.

### Error Propagation

- R2 listing failure → sync skips cycle (advisory lock released), retries next interval
- Parse failure on single file → logged, other files still sync (existing pattern)
- Embedding failure → item stays in `embedding IS NULL` queue, retried next cycle

### State Lifecycle Risks

- **Backfill without PG update**: If the backfill uploads files to R2 but crashes before updating PG entries with `source_path`, the next sync will create duplicate entries. Mitigation: the backfill updates PG in the same transaction/batch as the R2 upload.
- **Partial soft-delete**: If the R2 listing is incomplete (pagination bug), entries could be incorrectly soft-deleted. Mitigation: the existing `listAllObjects` handles pagination correctly (battle-tested for artifacts).

### API Surface Parity

- MCP tools: `search`, `get-entry`, `get-entries-by-date`, `on-this-day`, `find-similar`, `entry-stats` — all need `deleted_at IS NULL` filtering (Phase 2)
- Entry REST API (`src/transports/routes/entries.ts`): entry creation/editing routes can be removed (Obsidian is sole authoring surface). Read-only routes remain for any consumers.

## Acceptance Criteria

### Functional
- [ ] All existing Day One entries exported to Obsidian vault as markdown files
- [ ] Media files (photos, videos, audio) exported from DayOne.sqlite to vault
- [ ] `[[wiki links]]` generated from existing entry→artifact relationships
- [ ] New entries created in Obsidian sync to PG within 30 minutes
- [ ] Edited entries update in PG with re-embedding
- [ ] Deleted entries soft-deleted in PG
- [ ] Morning notification → Obsidian → template → write → synced to PG

### Non-Functional
- [ ] Backfill script idempotent and resumable
- [ ] No duplicate entries after backfill + sync cycle
- [ ] Search results exclude soft-deleted entries
- [ ] `pnpm check` passes at every phase
- [ ] No regression in existing artifact sync

## Dependencies & Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Backfill creates duplicate entries | Medium | High | Update PG `source_path` in same batch as R2 upload |
| DayOne sync overwrites Obsidian edits | Low | High | Existing `WHERE source = 'dayone'` guard; retire script |
| Obsidian Sync delay > 30min | Low | Medium | Acceptable — evening review runs at fixed time |
| Media filename collisions | Very Low | Low | MD5-based filenames are unique by design |
| R2 listing pagination bug | Very Low | High | Existing code handles this; add integration test |

## Open Questions (from brainstorm)

- **Vault subfolder structure**: Flat `Journal/` or `Journal/2025/11/`? Flat is simpler and what Daily Notes produces by default. Recommend flat.
- **Templater `created_at` vs filename date**: Recommend frontmatter `created_at` as source of truth (more precise — includes time). Filename is for human readability.
- **R2 media bucket cleanup**: The `espejo-media` bucket has existing media. After backfill copies to `Attachments/` in the vault bucket, the media bucket is redundant. Clean up later — not blocking.
- ~~**Telegram entry creation post-migration**~~: Resolved — Telegram does not create entries. Obsidian is the sole authoring surface.

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-28-obsidian-migration-brainstorm.md](docs/brainstorms/2026-03-28-obsidian-migration-brainstorm.md) — Key decisions carried forward: PG stays as search backend, `source_path` is primary dedup key, only `created_at` + media in Obsidian files, media in vault (no separate R2 upload), `-2`/`-3` suffixes for multiple entries per day.

### Internal References

- Obsidian sync pipeline: `src/obsidian/sync.ts` (exemplar for entry sync)
- Obsidian parser: `src/obsidian/parser.ts` (extend for journal frontmatter)
- DayOne sync: `scripts/sync-dayone.ts` (media handling reference)
- Entry queries: `src/db/queries/entries.ts` (soft-delete scope)
- Artifact schema: `specs/schema.sql` (source_path pattern)
- Prior R2 sync plan: `docs/plans/2026-03-19-feat-obsidian-r2-vault-sync-plan.md` (etag change detection, advisory lock, soft-delete patterns)
- Migration script reference: `scripts/migrate-entries-to-artifacts.ts` (backfill script pattern)
