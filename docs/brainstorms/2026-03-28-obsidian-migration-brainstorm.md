---
date: 2026-03-28
topic: obsidian-migration
---

# Migrate Journaling from Day One to Obsidian

## What We're Building

Unify entries and artifacts in Obsidian so the entire knowledge base lives in one system with `[[wiki links]]` between them. Eliminate the dependency on a local Mac to run `pnpm sync && pnpm embed` — entries flow through the same server-side Obsidian sync pipeline that artifacts already use.

## Why This Approach

- **Data ownership:** Plain markdown files instead of Day One's proprietary SQLite format
- **Interlinking:** Entries and artifacts in the same vault enables `[[wiki links]]` between them
- **No laptop dependency:** The current pipeline requires a Mac with DayOne.sqlite to sync. Obsidian Sync + R2 means the server can pick up new entries automatically on a timer
- **Already proven:** Artifacts already flow through Obsidian → Obsidian Sync → R2 → server-side sync → PG

## Key Decisions

- **PG stays as the search backend** — entries are materialized to Obsidian for interlinking and authoring, but PG + pgvector remains the source of truth for hybrid search and embeddings
- **Only `created_at` + media matter in Obsidian files** — weather, location, moon phase, etc. stay in PG rows but don't need to appear in frontmatter or round-trip
- **No separate R2 media upload** — media files live in the Obsidian vault and reach R2 as part of the vault sync (Obsidian Sync → vault → R2). No replication of what `sync-dayone.ts --skip-media` used to do
- **`source_path` is the primary dedup key** for all Obsidian-sourced entries, same as artifacts. Backfilled entries also get a `uuid` in frontmatter for historical reference, but new entries created in Obsidian use `source_path` and get a generated UUID on first sync
- **Multiple entries per day** use `-1`, `-2` suffixes: `Journal/2025-11-15.md`, `Journal/2025-11-15-2.md`
- **Day One sync script retired** once migration is complete

## Workstreams

### 1. Backfill: PG entries → Obsidian vault (one-time script)

Export all existing entries as markdown files into the vault:

```markdown
---
uuid: ABC123-DEF456
created_at: 2025-11-15T08:30:00+01:00
---

Woke up feeling depleted...

![[Journal/attachments/abc123.jpeg]]

The nicotine yesterday definitely crashed my dopamine baseline.
```

- Filename: `Journal/YYYY-MM-DD.md` (with `-2`, `-3` suffixes for multiple entries per day)
- Frontmatter: `uuid` (from Day One), `created_at`
- Media: pull from DayOne.sqlite directly (not R2) since many entries were synced with `--skip-media`. Embed as `![[Journal/attachments/filename]]`
- Auto-generate `[[wiki links]]` from existing `knowledge_artifact_sources` relationships in PG
- Upload resulting files + media to R2 artifacts bucket

### 2. Extend Obsidian sync to handle entries

The existing sync (`src/obsidian/sync.ts`) handles artifacts from R2. Extend it to also parse entry files from `Journal/`:

- **Discovery:** List `.md` files under `Journal/` prefix in R2
- **Parsing:** Extract frontmatter (`uuid`, `created_at`), body text, embedded media references (`![[...]]`)
- **Dedup:** Match on `source_path` (e.g. `Journal/2025-11-15.md`). If entry exists → UPDATE. If new → INSERT with generated UUID
- **Media:** Parse `![[Journal/attachments/...]]` references, store vault-relative paths in `media` table (no separate R2 upload — files are already in R2 as part of the vault)
- **Embeddings:** Clear embedding on content change (same as artifacts), auto-embed timer picks them up
- **Runs on existing server-side timer** — no laptop needed

### 3. iOS capture (Obsidian mobile)

- Daily Notes core plugin pointed at `Journal/` with `YYYY-MM-DD` format
- Template with frontmatter skeleton (`created_at` with Templater date insertion)
- iOS Shortcut: morning notification at configured time → opens Obsidian to today's daily note
- Obsidian Sync handles mobile ↔ desktop ↔ R2

## Entry markdown format

```markdown
---
uuid: ABC123-DEF456        # only on backfilled entries
created_at: 2025-11-15T08:30:00+01:00
---

Entry body text here.

![[Journal/attachments/abc123.jpeg]]

More text. See also [[Some Artifact Title]].
```

## Open Questions

- **Templater vs Daily Notes for `created_at`:** Daily Notes sets the date from the filename. Templater can inject an ISO timestamp into frontmatter on creation. Which is the source of truth for `created_at` — filename or frontmatter?
- **Vault structure:** `Journal/` for entries, existing folders for artifacts. Any subfolder structure within Journal (by year, by month)?
- **Retiring Day One:** Hard cutover date, or run both in parallel for a transition period?
- **R2 media bucket cleanup:** Once media lives in the vault portion of R2, the separate `media` bucket becomes redundant for new entries. Migrate old media into the vault or leave it?

## Next Steps

1. `/ce:plan` for implementation details on the three workstreams
2. Set up Obsidian Daily Notes + Templater + iOS Shortcut as a manual step
3. Write the backfill script
4. Extend the Obsidian sync parser
