# Web-First Journaling — Replacing Day One

> **Status: Implemented**

## Context

Day One is currently the only write path for journal entries. Sync imports from DayOne.sqlite into PostgreSQL, and the web app is read-only for entries. This spec adds web-native journaling (entry CRUD + photo upload + templates) while keeping Day One sync for historical backfill.

The reviewed version below includes guardrails for:
- optimistic locking without accidental version bumps from background updates
- stale async embedding writes
- safe media upload constraints
- idempotent template seeding

---

## Goals

1. Make web journaling the primary write interface.
2. Preserve compatibility with existing MCP tools and Telegram flows.
3. Keep SQL centralized in `src/db/queries.ts` and API behavior aligned with existing web CRUD patterns.

## Non-goals (v1)

- Video/audio upload (photos only)
- Geolocation/weather auto-detection
- Telegram check-in auto-conversion to entries
- Template interpolation/variables

---

## Phase 1: Schema Changes

**File:** `specs/schema.sql` (source of truth), then add migration entry in `scripts/migrate.ts`.

### 1) `entries` additions

```sql
ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'dayone'
    CHECK (source IN ('dayone', 'web', 'telegram')),
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_entries_source_created
  ON entries (source, created_at DESC);
```

Important: do **not** add a global version-bump trigger on `entries`. `entries` is updated by sync and embed jobs; a blanket trigger would cause false version conflicts and noisy `modified_at` churn. Version bumps for optimistic locking happen only in the explicit web update query.

### 2) `entry_templates` table

```sql
CREATE TABLE IF NOT EXISTS entry_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 80),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description TEXT,
  body TEXT NOT NULL DEFAULT '',
  default_tags TEXT[] NOT NULL DEFAULT '{}',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entry_templates_sort
  ON entry_templates (sort_order ASC, created_at ASC);
```

Add `updated_at` trigger for templates:

```sql
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entry_templates_touch_updated_at ON entry_templates;
CREATE TRIGGER trg_entry_templates_touch_updated_at
  BEFORE UPDATE ON entry_templates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

### 3) Seed templates idempotently

Seed `morning`, `evening`, and `freeform` with `INSERT ... ON CONFLICT (slug) DO UPDATE`.

---

## Phase 2: Query Layer

**File:** `src/db/queries.ts`

Add:
- `createEntry(pool, data)` -> inserts entry (`source='web'`, `version=1`)
- `updateEntry(pool, uuid, expectedVersion, data)` -> optimistic lock update
- `deleteEntry(pool, uuid)` -> delete by UUID
- `listEntries(pool, filters)` + `countEntries(pool, filters)` -> shared filter builder
- `upsertEntryTags(pool, entryId, tagNames)` -> normalize/dedupe tags
- `insertMedia(pool, data)`, `getMediaForEntry(pool, entryId)`, `deleteMedia(pool, id)`
- `listTemplates`, `getTemplateById`, `createTemplate`, `updateTemplate`, `deleteTemplate`
- `updateEntryEmbeddingIfVersionMatches(pool, uuid, version, embedding)`

Update `EntryRow` to include:
- `source: 'dayone' | 'web' | 'telegram'`
- `version: number`

### Optimistic locking query shape

`updateEntry` must atomically bump version only on intended web edits:

```sql
UPDATE entries
SET
  text = COALESCE($text, text),
  timezone = COALESCE($timezone, timezone),
  created_at = COALESCE($created_at, created_at),
  modified_at = NOW(),
  version = version + 1
WHERE uuid = $uuid
  AND version = $expected_version
RETURNING *;
```

If `uuid` exists but version check fails, return `'version_conflict'`.

All entry write operations that touch entry + tags + media should be wrapped in a transaction.

---

## Phase 3: REST API Endpoints

**File:** `src/transports/http.ts`

Reuse existing `requireBearerAuth` pattern and zod validation style.

### Entry CRUD

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/entries` | Paginated list with filters: `limit`, `offset`, `from`, `to`, `tag`, `source`, `q` -> `{ items, total }` |
| GET | `/api/entries/:uuid` | Full entry with tags/media/version/source |
| POST | `/api/entries` | Create (`uuid = crypto.randomUUID()`, `source='web'`) |
| PUT | `/api/entries/:uuid` | Update with `expected_version`; 409 on conflict |
| DELETE | `/api/entries/:uuid` | Delete entry and dependent rows |

### Media upload

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/entries/:uuid/media` | `multipart/form-data` image upload -> R2 -> media row |
| DELETE | `/api/media/:id` | Delete media row and best-effort delete from R2 by `storage_key` |

Constraints:
- Use `multer` memory storage.
- Enforce MIME allowlist (`image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic`).
- Enforce file size cap (v1: 10 MB).
- Store as `type='photo'`.
- Key format: `entries/{uuid}/{randomUUID}.{ext}`.

### Template CRUD

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/templates` | List ordered by `sort_order`, then `created_at` |
| POST | `/api/templates` | Create template |
| PUT | `/api/templates/:id` | Update template |
| DELETE | `/api/templates/:id` | Delete template |

---

## Phase 4: Embeddings (Async, Stale-Safe)

On entry create/update, trigger async embedding without blocking HTTP response:

```ts
void generateEmbedding(text)
  .then((embedding) =>
    updateEntryEmbeddingIfVersionMatches(pool, uuid, version, embedding)
  )
  .catch((error) => {
    // log via existing server logging path
  });
```

Why version-guarded write:
- prevents an older async embedding result from overwriting newer text embedding.

`pnpm embed` remains fallback for NULL embeddings.

---

## Phase 5: Web UI

**File:** `web/src/main.tsx`

Add routes:

```
/journal              -> EntryList
/journal/new          -> EntryCreate (?template=<id>)
/journal/:uuid        -> EntryEdit
/templates            -> TemplateList
/templates/new        -> TemplateCreate
/templates/:id        -> TemplateEdit
```

### Pages

- `EntryList`: timeline grouped by day; filters for date/source/tag/text.
- `EntryCreate`: template picker + markdown editor + tags + media upload.
- `EntryEdit`: same editor with media gallery + optimistic conflict handling.
- `TemplateList`: list/manage templates.
- `TemplateCreate`/`TemplateEdit`: name/slug/description/body/default tags/sort order.

### Components

- `TemplatePicker`
- `MediaUpload`
- `MediaGallery`

### Navigation and quick switcher

- Add `Journal` link to top nav.
- Extend quick switcher with journal shortcuts:
  - `New entry` -> `/journal/new`
  - `Journal` -> `/journal`
  - `Templates` -> `/templates`

### API client

**File:** `web/src/api.ts`

Add:
- `Entry`, `EntryTemplate`, `EntryMedia` types
- entry CRUD API functions
- template CRUD functions
- `uploadEntryMedia` using `FormData` without forcing `Content-Type: application/json`

---

## Phase 6: Day One Sync Compatibility

**File:** `scripts/sync-dayone.ts`

- Upsert with explicit `source='dayone'`.
- Keep sync idempotent.
- Protect against accidental source overwrite on conflict:
  - conflict updates should target Day One-origin rows only.

---

## Tests

1. Query tests:
   - create/update/delete entry
   - optimistic lock conflict path
   - list/count filters parity
   - template CRUD
2. HTTP tests:
   - entry CRUD happy path + 409
   - media validation failures (type/size)
3. Embedding safety test:
   - stale async write does not replace newer version embedding
4. Web tests:
   - create/edit entry flow
   - create from template pre-fills body/tags

Run after every change:

```bash
pnpm check
```

---

## Verification Checklist

1. `pnpm check` passes.
2. Web-created entry appears in MCP search after async embedding completes.
3. Photo upload renders in entry edit view and URL resolves.
4. Stale client update returns 409 with no data loss.
5. Day One sync still imports correctly (`pnpm sync --skip-media`).
6. Existing entry tools (`search_entries`, `get_entry`, `on_this_day`, `find_similar`) include web entries.

---

## Critical Files

- `specs/schema.sql`
- `scripts/migrate.ts`
- `src/db/queries.ts`
- `src/transports/http.ts`
- `src/storage/r2.ts`
- `scripts/sync-dayone.ts`
- `web/src/main.tsx`
- `web/src/api.ts`
- `web/src/components/AuthGate.tsx`
- `web/src/components/QuickSwitcher.tsx`
