# Web Feature Rollout (March 2026)

> **Status: Implemented** — All features in this rollout are complete.

Comprehensive record of the implemented web and API additions:

- `note` artifact kind support
- Todo system (schema + API + web UI)
- Weight tracking migration from MCP tooling to web UI + REST endpoints
- Tag filtering in artifact list
- Cmd/Ctrl+K quick switcher
- Semantic links + explicit backlinks
- Graph view for artifact relationships

---

## 1) Data model and migrations

### Applied migrations

- `019-add-note-kind`
  - Expands `knowledge_artifacts.kind` check constraint with `note`.
- `020-todos`
  - Creates `todos` table.
  - Adds `todo_updated_at_bump()` trigger function + update trigger.
- `021-artifact-links`
  - Creates `artifact_links` table for explicit wiki links.
  - Adds target index for backlink lookups.

### Schema additions

- `knowledge_artifacts.kind` now supports:
  - `insight | theory | model | reference | note`
- `todos` table:
  - `title`, `status`, `next_step`, `body`, `tags`, timestamps
- `artifact_links` table:
  - `source_id`, `target_id`
  - PK `(source_id, target_id)`
  - `CHECK (source_id != target_id)`

---

## 2) Backend/API additions

### Query layer (`src/db/queries.ts`)

Added:

- `listArtifactTitles(pool)`
- `resolveArtifactTitleToId(pool, title)`
- `syncExplicitLinks(pool, sourceId, targetIds)`
- `getExplicitLinks(pool, artifactId)`
- `getExplicitBacklinks(pool, artifactId)`
- `findSimilarArtifacts(pool, artifactId, limit, minSimilarity)`
- `getArtifactGraph(pool)`

Todo query set:

- `listTodos(pool, { status?, limit?, offset? })`
- `getTodoById(pool, id)`
- `createTodo(pool, data)`
- `updateTodo(pool, id, data)`
- `deleteTodo(pool, id)`

### HTTP endpoints (`src/transports/http.ts`)

Added artifact endpoints:

- `GET /api/artifacts/titles`
- `GET /api/artifacts/:id/related`
- `GET /api/artifacts/graph`

Enhanced artifact create/update behavior:

- `POST /api/artifacts`
- `PUT /api/artifacts/:id`
- Both now parse `[[Title]]` wiki links and sync explicit links to `artifact_links`.

Added todo endpoints:

- `GET /api/todos`
- `GET /api/todos/:id`
- `POST /api/todos`
- `PUT /api/todos/:id`
- `DELETE /api/todos/:id`

---

## 3) Frontend additions

### Global

- Navigation in `AuthGate` with active route highlighting:
  - `Knowledge Base` (`/`)
  - `Todos` (`/todos`)

### Artifact list (`web/src/pages/ArtifactList.tsx`)

- Added `note` kind support in filters and badges.
- Added tag filter pills under kind filters.
- Multiple selected tags use `tags_mode=all` (AND semantics).
- Tag filters apply to list and search requests.
- Added list/graph toggle with `localStorage` persistence.
- Added wiki-link snippet normalization:
  - `[[Title]]` displays as plain `Title`.

### Quick switcher

- New `web/src/components/QuickSwitcher.tsx`.
- Global keyboard shortcut:
  - `Cmd+K` (macOS)
  - `Ctrl+K` (Windows/Linux)
- Fuzzy title matching (prefix > substring > char sequence).
- Keyboard navigation:
  - Arrow keys, Enter, Escape.
- First result when input is empty:
  - `New artifact` -> `/new`.

### Artifact editor (`web/src/pages/ArtifactEdit.tsx`)

- Related panel:
  - Semantic matches (cosine similarity)
  - Explicit links/backlinks (`outgoing` / `incoming`)
- Edit/Preview toggle for body.
- Preview mode converts `[[Title]]` to internal links when resolvable.
- Manual save/delete flow preserved (`Save` button, no autosave).

### Markdown editor (`web/src/components/MarkdownEditor.tsx`)

- Added `[[]]` toolbar button for artifact linking.
- Title search dropdown using cached `listArtifactTitles()`.
- Inserts `[[Selected Title]]` into markdown.

### Graph view

- New `web/src/components/GraphView.tsx` using `react-force-graph-2d`.
- Node colors by artifact kind.
- Edge types:
  - `semantic` (weighted)
  - `explicit`
  - `tag`
  - `source`
- Node click navigates to artifact edit route.

### Todo UI

- New pages:
  - `TodoList`
  - `TodoCreate`
  - `TodoEdit`
- New `StatusSelect` component.
- Routes:
  - `/todos`
  - `/todos/new`
  - `/todos/:id`

### Theme/CSS updates (`web/src/index.css`)

- Added `note` badge colors:
  - Light: `#f0ece5` / `#5a4d38`
  - Dark: `#3a3428` / `#d4c8a8`
- Added todo status badge colors:
  - `active`, `waiting`, `done` (light + dark variants)

---

## 4) How to test (end-to-end)

## Prerequisites

- Dev DB running and migrated:
  - `docker compose up -d`
  - `pnpm migrate`
- Dependencies installed:
  - `pnpm install`

## Required automated checks

From repo root:

```bash
pnpm check
```

From `web/`:

```bash
npx vite build
pnpm e2e
```

## Manual verification checklist

### A. Note kind

1. Open `/new`.
2. Ensure `Kind` includes `Note`.
3. Create a note artifact and confirm:
   - Kind badge is rendered with note color.
   - Note appears in list filter and quick switcher results.

### B. Tag filtering (AND behavior)

1. Open `/`.
2. Select one tag filter, confirm list narrows.
3. Select a second tag, confirm results narrow further (AND).
4. Combine with kind filter and search input.
5. Move to page 2, toggle a tag, confirm reset to page 1 (`?page` reset).

### C. Quick switcher

1. Press `Cmd+K` or `Ctrl+K`.
2. Confirm modal opens and input autofocuses.
3. With empty query, confirm `New artifact` top option.
4. Type partial title and confirm fuzzy ranking.
5. Navigate with arrows and press Enter to open artifact.
6. Press Escape to close.

### D. Semantic links/backlinks

1. Open an artifact with embeddings present.
2. Confirm `Related` section shows semantic matches.
3. Insert `[[Other Artifact Title]]` via toolbar `[[]]` button.
4. Save.
5. Reload artifact and confirm explicit link appears.
6. Open target artifact and confirm incoming backlink.
7. Toggle Preview and confirm wiki links become clickable internal links.

### E. Graph view

1. On `/`, switch from `List` to `Graph`.
2. Confirm nodes render and are color-coded by kind.
3. Confirm multiple edge types are visible (`semantic`, `explicit`, `tag`, `source`).
4. Click a node and verify navigation to `/:id`.
5. Refresh page and verify view preference persists.

### F. Todo system

1. Open `/todos`.
2. Create a todo with status + next step + tags.
3. Confirm it appears in list with correct status badge.
4. Edit todo, change status and body, click `Save`.
5. Confirm status filters (`All/Active/Waiting/Done`) work.
6. Delete todo and confirm removal.

---

## 5) Production rollout note

Before deploying schema-dependent changes:

```bash
NODE_ENV=production DATABASE_URL=<prod_url> pnpm migrate
```

Then deploy app as usual.
