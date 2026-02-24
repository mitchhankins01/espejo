# Replace Day One with Obsidian + R2

## Context

Day One is being replaced with Obsidian as the journal source of truth.

The ingestion path currently coupled to Day One is `scripts/sync-dayone.ts` +
`better-sqlite3`. The rest of the runtime system (MCP tools, queries,
formatters, Telegram, Oura, Spanish, schema) remains generic.

This migration has two tracks:
1. **One-time export**: PostgreSQL -> Obsidian vault markdown
2. **Ongoing sync**: Obsidian vault markdown -> PostgreSQL (replacing Day One sync)

## Goals

- Keep database schema unchanged.
- Keep all tool behavior unchanged.
- Preserve media availability via R2 URLs.
- Preserve idempotent sync semantics.
- Avoid polluting search/embedding text with generated media URL blocks.

## Non-goals

- No MCP tool contract changes.
- No schema migrations.
- No formatter redesign.

---

## Data Contract (Obsidian Note)

Each synced note must contain YAML frontmatter + markdown body.

### Required frontmatter fields

- `uuid` (string)
- `created` (ISO timestamp)

### Optional frontmatter fields

- `modified` (ISO timestamp)
- `timezone` (IANA timezone)
- `tags` (string[])
- `location` object:
  - `city`, `country`, `place_name`, `admin_area`, `latitude`, `longitude`
- `weather` object:
  - `conditions`, `temperature`, `humidity`, `moon_phase`, `sunrise`, `sunset`
- `media` array (canonical metadata for DB media rows):
  - `type` (`photo` | `video` | `audio`)
  - `url`
  - `md5`
  - `storage_key`
  - `file_size`
  - `dimensions`
  - `duration`
  - `camera_info`
  - `location`

### Generated media render block (body)

Exported notes append a generated block for Obsidian rendering:

```md
<!-- espejo:media:start -->
![](https://...)
[Video](https://...)
<!-- espejo:media:end -->
```

This block is presentation-only. Sync strips this block from text before DB upsert,
so search/embeddings are based on journal prose, not URL noise.

---

## Implementation Plan

## Step 1: Dependency and script wiring

**File**: `package.json`

- Remove `better-sqlite3`
- Remove `@types/better-sqlite3`
- Add `gray-matter`
- Update scripts:
  - `sync` -> `tsx scripts/sync-obsidian.ts`
  - `sync:prod` -> `NODE_ENV=production tsx scripts/sync-obsidian.ts --skip-media`
  - add `export:obsidian` -> `tsx scripts/export-to-obsidian.ts`

## Step 2: Add `scripts/export-to-obsidian.ts`

One-time export from PostgreSQL to Obsidian vault.

### Behavior

1. Read all entries + tags + media from PostgreSQL.
2. Write one markdown file per entry to `YYYY/YYYY-MM-DD-<uuid8>.md`.
3. Serialize canonical metadata in frontmatter.
4. Append generated media render block in body.
5. Idempotent overwrite of note files.

### CLI

- `--vault-path` (required, or `OBSIDIAN_VAULT_PATH` env var)

## Step 3: Add `scripts/sync-obsidian.ts`

Ongoing idempotent sync from vault to PostgreSQL.

### Pipeline

1. Discover all `.md` files recursively under vault.
2. Parse with `gray-matter`.
3. Validate `uuid` and `created`; skip invalid notes with actionable warnings.
4. Normalize note text:
  - remove null bytes
  - unicode cleanup
  - collapse excessive newlines
  - remove generated `espejo:media` block
5. Build relational data structures:
  - entries columns
  - tags per uuid
  - media per uuid (from frontmatter `media`)
6. Optional local media detection (`--skip-media` disabled):
  - parse `![[file.jpg]]`, `![](path)`, and markdown links
  - resolve relative to note dir, then vault `attachments/`, or
    `--attachments-path` / `OBSIDIAN_ATTACHMENTS_PATH`
  - compute md5, infer media type, create storage key
  - upload to R2 if configured and not already present
  - append new media records to in-memory media set
7. Optional write-back (`--write-frontmatter`):
  - persist enriched `media` array into frontmatter
  - write atomically (temp file + rename)
8. Batch upsert entries/tags/media using existing `unnest + ON CONFLICT` pattern.

### CLI

- `--vault-path` (or `OBSIDIAN_VAULT_PATH`)
- `--attachments-path` (or `OBSIDIAN_ATTACHMENTS_PATH`)
- `--new-only`
- `--skip-media`
- `--write-frontmatter`
- `--dry-run` (no DB writes, no note writes)

## Step 4: Remove Day One sync script

- Delete `scripts/sync-dayone.ts`

## Step 5: Update docs and env examples

**Files**: `README.md`, `CLAUDE.md`, `.env.example`

- Replace `DAYONE_SQLITE_PATH` with `OBSIDIAN_VAULT_PATH`
- Update quick-start sync wording
- Update directory map script names
- Update dependency table (`gray-matter` in, `better-sqlite3` out)

---

## Acceptance Criteria

1. `pnpm export:obsidian -- --vault-path <vault>` creates notes with valid frontmatter.
2. Exported notes open cleanly in Obsidian and render media links.
3. `pnpm sync -- --vault-path <vault>` imports all entries into empty dev DB.
4. Re-running sync is idempotent (stable row counts and no duplicate tags/media).
5. DB media rows persist through export -> reset -> sync round-trip.
6. Synced `entries.text` does not contain generated media URL block.
7. `pnpm check` passes.

## Verification Checklist

1. Export from populated dev DB to a temp vault.
2. Reset dev DB and migrate.
3. Sync from the temp vault.
4. Compare counts for `entries`, `tags`, `entry_tags`, and `media` pre/post.
5. Spot-check sample entries and media URLs.
6. Run `pnpm embed` if needed for newly imported entries.
7. Run `pnpm check`.
