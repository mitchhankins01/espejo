# Web-First Journaling — Replacing Day One

## Status: Planned

## Context

Day One is currently the only way to create journal entries. The sync script imports from DayOne.sqlite into PostgreSQL where entries are read-only. The web app has full CRUD for artifacts and todos but no entry editing. This spec adds entry CRUD, media upload, and templates to the web app so it becomes the primary journaling interface. Day One sync remains for historical imports.

---

## Phase 1: Schema Changes

**File: `specs/schema.sql`** (source of truth) + new migration

### Entries table additions

```sql
ALTER TABLE entries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'dayone'
  CHECK (source IN ('dayone', 'web', 'telegram'));
ALTER TABLE entries ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
```

Version bump trigger (mirrors `knowledge_artifact_version_bump`):

```sql
CREATE OR REPLACE FUNCTION entry_version_bump() RETURNS TRIGGER AS $$
BEGIN
  NEW.modified_at := NOW();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entry_version_bump BEFORE UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION entry_version_bump();
```

### Entry templates table

```sql
CREATE TABLE IF NOT EXISTS entry_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description TEXT,
  body TEXT NOT NULL DEFAULT '',
  default_tags TEXT[] NOT NULL DEFAULT '{}',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Seed with morning/evening/freeform templates matching existing Telegram check-in prompts.

---

## Phase 2: REST API Endpoints

**File: `src/transports/http.ts`**

### Entry CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/entries` | List entries (pagination, date range, tag, source, text search) → `{ items, total }` |
| GET | `/api/entries/:uuid` | Get entry with tags + media + version |
| POST | `/api/entries` | Create entry (`source = 'web'`, UUID via `crypto.randomUUID()`) |
| PUT | `/api/entries/:uuid` | Update with optimistic locking (`expected_version`, 409 on conflict) |
| DELETE | `/api/entries/:uuid` | Delete entry + cascade tags/media |

### Media upload

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/entries/:uuid/media` | Multipart upload → R2 → media row |
| DELETE | `/api/media/:id` | Delete media row |

Upload flow: multipart/form-data → generate key `entries/{uuid}/{randomUUID}.{ext}` → R2 PUT → insert media row → return `{ id, url, type }`.

**New dependency:** `multer` for multipart parsing.

**File: `src/storage/r2.ts`** — Add `uploadMediaBuffer(client, buffer, key, contentType)` variant (current `uploadMedia` reads from file path).

### Template CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/templates` | List all, ordered by sort_order |
| POST | `/api/templates` | Create template |
| PUT | `/api/templates/:id` | Update template |
| DELETE | `/api/templates/:id` | Delete template |

---

## Phase 3: Query Functions

**File: `src/db/queries.ts`**

- `createEntry(pool, data)` — INSERT with `source = 'web'`, return full row
- `updateEntry(pool, uuid, expectedVersion, data)` — UPDATE with version check, return row or `'version_conflict'`
- `deleteEntry(pool, uuid)` — DELETE, return boolean
- `listEntries(pool, filters)` — Paginated with date range, tag, source, text search
- `countEntries(pool, filters)` — Count for pagination
- `upsertEntryTags(pool, entryId, tagNames)` — Delete + insert pattern
- `insertMedia(pool, data)` / `deleteMedia(pool, id)` / `getMediaForEntry(pool, entryId)`
- `listTemplates` / `getTemplateById` / `createTemplate` / `updateTemplate` / `deleteTemplate`

Update `EntryRow` interface to include `source` and `version`.

---

## Phase 4: Embedding Generation

Fire-and-forget on create/update (non-blocking):

```typescript
generateEmbedding(text)
  .then(emb => updateEntryEmbedding(pool, uuid, emb))
  .catch(err => console.error('Embedding failed:', err));
```

Batch `pnpm embed` remains as fallback for entries missing embeddings.

---

## Phase 5: Web UI

**File: `web/src/main.tsx`** — New routes:

```
/journal              → EntryList (timeline)
/journal/new          → EntryCreate (?template=<id> to pre-fill)
/journal/:uuid        → EntryEdit
/templates            → TemplateList
/templates/new        → TemplateCreate
/templates/:id        → TemplateEdit
```

### Pages

**EntryList** — Timeline view with date headers grouping entries. Date/tag/source filters, photo thumbnails inline, "New Entry" button with template dropdown.

**EntryCreate** — Template picker at top, MarkdownEditor (reuse existing), TagInput (reuse), MediaUpload zone, auto-detected timezone from browser. Save → create entry → upload media → async embed.

**EntryEdit** — Same editor + media gallery for existing photos, delete capability, optimistic lock (409 → reload prompt). Read-only weather/location metadata display for Day One imports.

**TemplateList** — Simple list of templates with name, description, sort order. Create/edit/delete.

**TemplateCreate/TemplateEdit** — Name, description, body (MarkdownEditor), default tags (TagInput), sort order.

### New Components

- **TemplatePicker** — Horizontal cards or dropdown, fetches from `/api/templates`, calls `onSelect(template)`
- **MediaUpload** — Drag-and-drop + file input, image/* only, shows upload progress, thumbnail preview
- **MediaGallery** — Grid of existing photos with lightbox expand and delete

### Nav Updates

- Add "Journal" to nav alongside Knowledge Base, Todos, Weight
- Add entries to QuickSwitcher results

**File: `web/src/api.ts`** — Add `Entry`, `MediaItem`, `EntryTemplate` types and CRUD functions. `uploadEntryMedia` uses `FormData` (not JSON).

---

## Phase 6: Sync Script Update

**File: `scripts/sync-dayone.ts`** — Add `source = 'dayone'` to upsert. Non-breaking.

---

## Compatibility

- All existing MCP tools work unchanged (search_entries, get_entry, on_this_day, find_similar, etc.)
- Telegram bot discovers web entries via existing search tools
- Insight engine (temporal echoes, biometric correlations) picks up web entries automatically
- Day One sync continues for historical imports, no UUID collision risk (different formats)

---

## Design Decisions

- **Templates:** Full CRUD in web UI (not just DB seeds)
- **Entry list layout:** Timeline view with date headers grouping entries
- **Media:** Photos only in v1, video/audio deferred
- **Optimistic locking:** Version column + trigger, same pattern as artifacts

## Non-goals (v1)

- Video/audio upload (photos only)
- Geolocation/weather auto-detection
- Converting Telegram check-in summaries to entries (remain as artifacts)
- Template variables/interpolation (just pre-filled markdown)

---

## Implementation Order

1. Schema migration (source, version, templates table, trigger, seeds)
2. Query functions in queries.ts + update EntryRow interface
3. R2 buffer upload variant
4. REST endpoints (entry CRUD, media upload, template CRUD) + multer dep
5. Inline embedding on create/update
6. Tests (unit + integration, maintain 95%+ coverage)
7. Web UI:
   - Entry pages: EntryList (timeline), EntryCreate, EntryEdit
   - Template pages: TemplateList, TemplateCreate, TemplateEdit
   - Components: TemplatePicker, MediaUpload, MediaGallery
   - API client, routes, nav update
8. Sync script source column update

---

## Verification

1. `pnpm check` passes (typecheck + lint + tests with coverage)
2. Create entry via web → appears in `search_entries` MCP tool after embedding completes
3. Upload photo → visible in entry edit page, URL resolves from R2
4. Create from template → editor pre-filled with template body and tags
5. Edit entry → version bumps, 409 on stale version
6. Day One sync still works (`pnpm sync --skip-media`)
7. `on_this_day` and `find_similar` return web-created entries

---

## Critical Files

- `specs/schema.sql` — Schema source of truth
- `src/db/queries.ts` — All new SQL functions
- `src/transports/http.ts` — REST endpoints
- `src/storage/r2.ts` — Buffer upload variant
- `web/src/main.tsx` — New routes
- `web/src/api.ts` — Frontend API client
- `web/src/pages/EntryList.tsx` — New page
- `web/src/pages/EntryCreate.tsx` — New page
- `web/src/pages/EntryEdit.tsx` — New page
- `scripts/sync-dayone.ts` — Source column update
