# Web App Spec — espejo-mcp Frontend

> Spec-driven development harness for the SvelteKit journal frontend.
> This is the source of truth for the web app's architecture, types, and test contracts.
> Phase 1 is fully specced. Phases 2–4 are outlined for future planning.

## Current Status (Feb 2026)

**What's working:**
- Monorepo structure (`pnpm-workspace.yaml`, `packages/shared/`, `web/`)
- SvelteKit app scaffolded with all Phase 1 routes: home (entry list), `entries/new`, `entries/[uuid]` (view/edit)
- Server-side queries (`web/src/lib/server/queries.ts`) wired to shared PG database
- Components: `EntryCard`, `EntryEditor` (plain textarea), `TagInput`
- Utility functions: `dates.ts`, `text.ts` (includes `stripMarkdown()` for previews, `markdownToHtml()` for rendered view)
- Tailwind CSS v4 styling
- 29 unit tests passing

**What needs work — Tiptap editor:**
- The spec calls for Tiptap rich text editing, but Tiptap v3 + Svelte 5 had issues: the editor mounted but synced markdown content didn't render in edit mode (blank editor on existing entries, worked fine for new entries).
- Replaced Tiptap with a plain `<textarea>` as a workaround to unblock other Phase 1 work.
- **Next step:** Reintegrate Tiptap using `@tiptap/extension-markdown` to convert between markdown (stored in DB `text` column) and Tiptap's internal JSON at the editor boundary. No schema change needed — keep markdown as the storage format.

**Not yet implemented:**
- E2E tests (Playwright) — specced but not written
- Histoire component stories — specced but not created
- `EntryList` and `MoodPicker` components — specced but not built
- Delete entry flow
- Autosave
- `+layout.server.ts` (global layout data loading)

## Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Framework | SvelteKit | SSR + SPA hybrid, file-based routing |
| Adapter | `adapter-node` | Railway deployment (Node.js server) |
| Editor | Tiptap via `svelte-tiptap` | Rich text editing with JSON output |
| Styling | Tailwind CSS v4 | Utility-first CSS |
| Database | PostgreSQL + pgvector | Shared with MCP server (same Railway instance) |
| PG Client | `pg` (node-postgres) | Direct queries from `+page.server.ts` |
| Unit Tests | vitest | Component logic, utils, stores |
| E2E Tests | Playwright | Full browser tests against test DB |
| Stories | Histoire | Component development and visual testing |
| Future | Capacitor | Native mobile (architecture should not preclude) |

## Monorepo Structure

```
espejo/
├── package.json              ← root workspace config (existing MCP server)
├── pnpm-workspace.yaml       ← workspace: packages/*, web
├── packages/
│   └── shared/
│       ├── package.json      ← @espejo/shared
│       ├── tsconfig.json
│       └── src/
│           ├── types.ts      ← shared type definitions
│           └── index.ts      ← barrel export
├── web/
│   ├── package.json          ← @espejo/web
│   ├── svelte.config.js      ← adapter-node
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── playwright.config.ts
│   ├── Dockerfile
│   ├── src/
│   │   ├── app.html
│   │   ├── app.css           ← Tailwind imports
│   │   ├── lib/
│   │   │   ├── server/
│   │   │   │   ├── db.ts     ← PG pool (server-only module)
│   │   │   │   └── queries.ts← CRUD SQL queries
│   │   │   ├── components/
│   │   │   │   ├── EntryEditor.svelte
│   │   │   │   ├── EntryCard.svelte
│   │   │   │   ├── EntryList.svelte
│   │   │   │   ├── TagInput.svelte
│   │   │   │   └── MoodPicker.svelte
│   │   │   ├── stores/
│   │   │   │   └── entries.ts
│   │   │   └── utils/
│   │   │       ├── dates.ts
│   │   │       └── text.ts
│   │   └── routes/
│   │       ├── +layout.svelte
│   │       ├── +layout.server.ts
│   │       ├── +page.svelte
│   │       ├── +page.server.ts
│   │       └── entries/
│   │           ├── new/
│   │           │   ├── +page.svelte
│   │           │   └── +page.server.ts
│   │           └── [uuid]/
│   │               ├── +page.svelte
│   │               └── +page.server.ts
│   ├── tests/
│   │   ├── unit/
│   │   │   ├── dates.test.ts
│   │   │   ├── text.test.ts
│   │   │   ├── entries-store.test.ts
│   │   │   └── autosave.test.ts
│   │   └── e2e/
│   │       ├── entry-create.spec.ts
│   │       ├── entry-list.spec.ts
│   │       ├── entry-edit.spec.ts
│   │       ├── entry-delete.spec.ts
│   │       └── entry-metadata.spec.ts
│   └── stories/
│       ├── EntryEditor.story.svelte
│       ├── EntryCard.story.svelte
│       ├── EntryList.story.svelte
│       ├── TagInput.story.svelte
│       └── MoodPicker.story.svelte
├── src/                      ← existing MCP server (untouched)
├── specs/                    ← existing specs (untouched)
└── tests/                    ← existing MCP tests (untouched)
```

The MCP server (`src/`) and web app (`web/`) share the same PostgreSQL database and import types from `@espejo/shared`. They are independent deployments — the web app does NOT proxy through the MCP server.

## Shared Types (`packages/shared/src/types.ts`)

These types are the contract between the MCP server and web frontend. They are derived from the database schema (`specs/schema.sql`), MCP tool return types (`specs/tools.spec.ts`), and query row types (`src/db/queries.ts`).

```typescript
// ============================================================================
// Core entry type
// ============================================================================

export interface JournalEntry {
  uuid: string;
  text: string | null;
  created_at: string; // ISO 8601
  modified_at: string | null;
  timezone: string | null;
  tags: string[];

  // Location
  city: string | null;
  country: string | null;
  place_name: string | null;
  admin_area: string | null;
  latitude: number | null;
  longitude: number | null;

  // Weather
  weather: EntryWeather | null;

  // Computed
  word_count: number;
  media_counts: MediaCounts;
}

export interface EntryWeather {
  temperature: number | null;
  conditions: string | null;
  humidity: number | null;
}

export interface MediaCounts {
  photos: number;
  videos: number;
  audios: number;
}

// ============================================================================
// Search and aggregation types
// ============================================================================

export interface SearchResult {
  uuid: string;
  created_at: string;
  preview: string;
  city: string | null;
  tags: string[];
  rrf_score: number;
  match_sources: ("semantic" | "fulltext")[];
}

export interface SimilarResult {
  uuid: string;
  created_at: string;
  preview: string;
  city: string | null;
  tags: string[];
  similarity_score: number;
}

export interface TagCount {
  name: string;
  count: number;
}

export interface EntryStats {
  total_entries: number;
  date_range: { first: string; last: string };
  avg_word_count: number;
  total_word_count: number;
  entries_by_day_of_week: Record<string, number>;
  entries_by_month: Record<string, number>;
  avg_entries_per_week: number;
  longest_streak_days: number;
  current_streak_days: number;
}

// ============================================================================
// CRUD input types (web app only)
// ============================================================================

export interface CreateEntryInput {
  text: string;
  tags?: string[];
  timezone?: string;
}

export interface UpdateEntryInput {
  text?: string;
  tags?: string[];
}
```

## Check Script Harness

### Web app (`web/package.json`)

```json
{
  "scripts": {
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json && eslint . && vitest run",
    "check:e2e": "playwright test",
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "start": "node build"
  }
}
```

### Root (`package.json`)

```json
{
  "scripts": {
    "check:all": "pnpm -r check"
  }
}
```

Same closed feedback loop as the MCP server: type errors → lint failures → test failures. Fix before moving on.

## Playwright E2E Test Specs

All e2e tests run against the test database on port 5433 (same as MCP integration tests). The test DB is seeded with fixture data from `specs/fixtures/seed.ts`.

### `tests/e2e/entry-create.spec.ts`

```typescript
test("creates a new entry with text and tags", async ({ page }) => {
  await page.goto("/entries/new");
  // Type in Tiptap editor
  // Add tags via TagInput
  // Submit form
  // Assert redirect to entry view
  // Assert entry text and tags are displayed
});

test("validates empty entry cannot be saved", async ({ page }) => { /* ... */ });
```

### `tests/e2e/entry-list.spec.ts`

```typescript
test("displays recent entries on home page", async ({ page }) => {
  await page.goto("/");
  // Assert entry cards are visible
  // Assert entries are ordered by date (newest first)
  // Assert each card shows date, preview, tags
});

test("paginates entries", async ({ page }) => { /* ... */ });
test("empty state shown when no entries", async ({ page }) => { /* ... */ });
```

### `tests/e2e/entry-edit.spec.ts`

```typescript
test("edits an existing entry", async ({ page }) => {
  await page.goto("/entries/<fixture-uuid>");
  // Modify text in Tiptap editor
  // Change tags
  // Save
  // Assert updated content persists on reload
});

test("preserves formatting through edit cycle", async ({ page }) => { /* ... */ });
```

### `tests/e2e/entry-delete.spec.ts`

```typescript
test("deletes an entry with confirmation", async ({ page }) => {
  await page.goto("/entries/<fixture-uuid>");
  // Click delete button
  // Confirm deletion dialog
  // Assert redirect to home
  // Assert entry no longer in list
});

test("cancel delete keeps entry", async ({ page }) => { /* ... */ });
```

### `tests/e2e/entry-metadata.spec.ts`

```typescript
test("displays weather and location metadata", async ({ page }) => {
  await page.goto("/entries/<fixture-uuid-with-metadata>");
  // Assert weather info shown
  // Assert location shown
});

test("handles entry with no metadata gracefully", async ({ page }) => { /* ... */ });
```

## Histoire Component Stories

### `stories/EntryEditor.story.svelte`

| Variant | Description |
|---------|-------------|
| Empty | Fresh editor, no content. Toolbar visible. |
| Editing | Pre-loaded with Tiptap JSON content. Active cursor. |
| Read-only | Content displayed but not editable. Toolbar hidden. |

### `stories/EntryCard.story.svelte`

| Variant | Description |
|---------|-------------|
| Full metadata | Date, preview, tags, city. |
| Minimal | Date and preview only (no tags, no location). |
| Long text | Preview truncated at 200 chars with ellipsis. |

### `stories/EntryList.story.svelte`

| Variant | Description |
|---------|-------------|
| With entries | 5 entry cards displayed. |
| Empty | "No entries yet" message with create CTA. |
| Loading | Skeleton placeholder cards. |

### `stories/TagInput.story.svelte`

| Variant | Description |
|---------|-------------|
| Empty | No tags selected, autocomplete dropdown hidden. |
| With tags | 3 tags shown as chips, removable. |
| Autocomplete | Dropdown showing matching tags from fixture data. |

### `stories/MoodPicker.story.svelte`

| Variant | Description |
|---------|-------------|
| Unselected | No mood selected. |
| Selected | One mood highlighted. |

## Vitest Unit Test Specs

### `tests/unit/dates.test.ts`

```typescript
describe("formatEntryDate", () => {
  test("formats ISO date to human-readable", () => { /* "2025-11-15T..." → "November 15, 2025" */ });
  test("handles timezone correctly", () => { /* respects entry timezone */ });
  test("formats relative date", () => { /* "2 days ago", "just now" */ });
});
```

### `tests/unit/text.test.ts`

```typescript
describe("tiptapToPlainText", () => {
  test("extracts text from simple paragraph", () => { /* { type: "paragraph", ... } → "Hello world" */ });
  test("handles nested lists", () => { /* preserves list item text */ });
  test("handles empty document", () => { /* returns "" */ });
  test("strips formatting marks", () => { /* bold/italic → plain text */ });
});
```

### `tests/unit/entries-store.test.ts`

```typescript
describe("entries store", () => {
  test("sets entries from server data", () => { /* ... */ });
  test("adds new entry optimistically", () => { /* ... */ });
  test("removes deleted entry", () => { /* ... */ });
  test("updates entry in place", () => { /* ... */ });
});
```

### `tests/unit/autosave.test.ts`

```typescript
describe("autosave debounce", () => {
  test("debounces rapid changes", () => { /* only saves once after 1s idle */ });
  test("saves immediately on explicit save", () => { /* bypass debounce */ });
  test("cancels pending save on unmount", () => { /* cleanup */ });
});
```

## Development Phases

### Phase 1: Write & Read (this spec)

**Scope:** Full CRUD for journal entries via SvelteKit web app.

- Create entries with Tiptap rich text editor
- View entries with formatted text, metadata, tags
- Edit entries (text, tags)
- Delete entries with confirmation
- List entries paginated (newest first)
- Tag autocomplete from existing tags
- Responsive layout (works on mobile for future Capacitor)

**Done when:** All Playwright e2e tests pass. `pnpm check` green in both root and `web/`.

### Phase 2: Search & Browse

Semantic search UI using the same RRF algorithm as the MCP `search_entries` tool. Tag browsing page. Date range filtering. City filtering.

### Phase 3: Reflect

On-this-day view (reuses `on_this_day` query pattern). Similar entries sidebar (reuses `find_similar` pattern). Writing stats dashboard (reuses `entry_stats` pattern). Mood/tag trends over time.

### Phase 4: PWA & Polish

Service worker for offline reading. Capacitor build for iOS/Android. Animations and transitions. Dark mode. Image/media display from R2 URLs.
