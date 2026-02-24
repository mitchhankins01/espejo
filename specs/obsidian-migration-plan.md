# Replace Day One with Obsidian + R2

## Context

Day One is being replaced with Obsidian as the journal source. The only file coupled to Day One is `scripts/sync-dayone.ts` (654 lines) + the `better-sqlite3` dependency. The entire rest of the system (17 MCP tools, Telegram agent, formatters, schema, tests) is fully generic and requires zero changes.

Two things need to happen:
1. **Export**: One-time script to dump all existing PG entries into Obsidian markdown files with YAML frontmatter and R2 media URLs
2. **New sync**: Replace `sync-dayone.ts` with `sync-obsidian.ts` that reads from an Obsidian vault directory

## Decisions

- **Existing media (export)**: R2 URLs in markdown body. Images render in Obsidian when online.
- **New media (going forward)**: Sync script detects local attachments in the vault, uploads them to R2, and writes the R2 URL + metadata back into frontmatter. Local files stay in the vault for offline rendering.
- **Location/weather**: Keep frontmatter fields in the template for future automation, but not required for new entries.

---

## Step 1: Add `gray-matter` dependency, remove `better-sqlite3`

**File**: `package.json`

- Remove `better-sqlite3` from dependencies
- Remove `@types/better-sqlite3` from devDependencies
- Add `gray-matter` to dependencies (YAML frontmatter parsing/serialization)
- Update scripts:
  - `"sync"` → point to `scripts/sync-obsidian.ts`
  - `"sync:prod"` → point to `scripts/sync-obsidian.ts`
  - Add `"export:obsidian"` → `tsx scripts/export-to-obsidian.ts`

## Step 2: Write `scripts/export-to-obsidian.ts` (~180 lines)

One-time export: PG → Obsidian vault.

**Vault structure**:
```
journal/
  2024/
    2024-01-15-a1b2c3d4.md
    2024-01-15-e5f6g7h8.md
  2025/
    2025-06-01-m3n4o5p6.md
```

**Frontmatter schema**:
```yaml
---
uuid: "A1B2C3D4..."
created: 2024-01-15T09:30:00+01:00
modified: 2024-01-15T10:15:00+01:00
timezone: Europe/Madrid
tags:
  - morning-review
location:
  city: Barcelona
  country: Spain
  place_name: Eixample
  admin_area: Catalonia
  latitude: 41.3874
  longitude: 2.1686
weather:
  conditions: Partly Cloudy
  temperature: 18
  humidity: 65
  moon_phase: 0.45
  sunrise: 2024-01-15T08:15:00+01:00
  sunset: 2024-01-15T17:45:00+01:00
---
```

**Logic**:
1. Connect to PG, query all entries with tags (array_agg) and media (json_agg)
2. For each entry: build frontmatter object, write `YYYY/YYYY-MM-DD-<uuid[:8]>.md`
3. Append media as markdown image/link syntax after entry text so they render in Obsidian
4. CLI: `pnpm export:obsidian -- --vault-path /path/to/vault/journal`
5. Idempotent (overwrites existing files)

**Key files to reference**:
- `src/db/queries.ts` — EntryRow type, query patterns
- `scripts/sync-dayone.ts` — batch patterns, normalizeText (reuse generic parts)
- `specs/schema.sql` — entries/tags/media column names

## Step 3: Write `scripts/sync-obsidian.ts` (~280 lines)

Ongoing sync: Obsidian vault → PG. Replaces `sync-dayone.ts`.

**Pipeline**:
1. Discover all `.md` files via `fs.readdir` recursive (no extra dependency needed)
2. Parse each with `gray-matter` → `{ data: frontmatter, content: body }`
3. Validate required fields (`uuid`, `created`)
4. Light `normalizeText()` — keep null byte stripping, unicode normalization, newline collapsing; drop Day One-specific escapes
5. **Detect local media** — scan markdown body for Obsidian embeds (`![[file.jpg]]` and `![](path)`)
6. **Upload new media to R2** — for each local file not already in frontmatter `media` array:
   - Compute MD5 hash of file content (for dedup + storage key, matching existing R2 convention)
   - Check if already in R2 via `mediaExists()` (same as Day One sync did)
   - Upload via `uploadMedia()` from `src/storage/r2.ts`
   - Append to frontmatter `media` array: `{ type, url, md5, storage_key }`
   - **Write updated frontmatter back to the .md file** (gray-matter stringify)
   - Local file stays in vault — Obsidian still renders it offline
7. Build column arrays (same structure as sync-dayone batch)
8. Batch upsert entries (reuse same `unnest()` SQL pattern from sync-dayone)
9. Batch upsert tags (same delete-old + upsert pattern)
10. Batch upsert media from frontmatter `media` array

**Media resolution**: Obsidian stores attachments based on vault settings (same folder, subfolder, or global attachments folder). The sync script resolves paths relative to the `.md` file first, then falls back to `attachments/` at vault root. This covers the common Obsidian configurations.

**CLI flags** (same as sync-dayone):
- `--vault-path` (or `OBSIDIAN_VAULT_PATH` env var)
- `--new-only` — skip files whose UUID already exists in PG
- `--skip-media` — skip media detection/upload/upsert

**Change detection**: Full scan by default (upsert is idempotent). `--new-only` checks PG for existing UUIDs.

**Key reuse from sync-dayone.ts**:
- `syncBatch()` SQL for entry upsert (the `unnest()` + `ON CONFLICT` pattern)
- Tag cleanup + upsert SQL
- Media cleanup + insert SQL
- Progress logging pattern
- Transaction wrapping (BEGIN/COMMIT/ROLLBACK)

**Key reuse from r2.ts** (already exists, no changes needed):
- `uploadMedia()` — upload file to R2, get public URL
- `mediaExists()` — check if file already in R2 (dedup)
- `getPublicUrl()` — generate public URL from storage key

## Step 4: Delete `scripts/sync-dayone.ts`

Remove the 654-line Day One sync script.

## Step 5: Update documentation

**Files**: `CLAUDE.md`, `README.md`, `.env.example`

- Replace `DAYONE_SQLITE_PATH` references with `OBSIDIAN_VAULT_PATH`
- Update Quick Start section (replace `pnpm sync` description)
- Update Directory Map (sync-dayone.ts → sync-obsidian.ts, add export-to-obsidian.ts)
- Update dependency table (remove better-sqlite3, add gray-matter)
- Update "Sync Is Idempotent" section for Obsidian
- Add brief section on Obsidian vault structure / frontmatter schema

## Step 6: Update `.env` / `.env.example`

- Remove `DAYONE_SQLITE_PATH`
- Add `OBSIDIAN_VAULT_PATH=/path/to/vault/journal`

---

## What does NOT change

- **No schema changes** — entries/tags/media tables are untouched
- **No query changes** — `src/db/queries.ts` untouched
- **No tool changes** — all 17 MCP tools untouched
- **No formatter changes** — `src/formatters/` untouched
- **No test changes** — all tests pass without modification
- **No Telegram/Oura/Spanish changes** — completely independent
- **No R2 changes** — media stays in R2, URLs preserved
- **No deployment changes** — Dockerfile/Railway untouched
- **No embedding changes** — `scripts/embed-entries.ts` untouched

## Verification

1. Run `pnpm export:obsidian -- --vault-path /tmp/test-vault` against dev DB
2. Open vault in Obsidian — confirm entries render, tags show in sidebar, media images load from R2
3. Reset dev DB: `docker compose down -v && docker compose up -d && pnpm migrate`
4. Run `pnpm sync -- --vault-path /tmp/test-vault` against empty dev DB
5. Compare row counts (entries, tags, entry_tags, media) with production — should match
6. Spot-check a few entries: `SELECT * FROM entries WHERE uuid = '...'`
7. Run `pnpm embed` to re-generate embeddings
8. Run `pnpm check` — typecheck, lint, tests + 100% coverage must all pass
