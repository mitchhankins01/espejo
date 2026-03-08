# Web App Spec (Knowledge Base + Todos)

> **Status: Implemented** — React + Vite SPA with artifact CRUD, todo CRUD, Tailwind CSS v4, dark mode, Playwright e2e tests. See `web/`.

React + Vite single-page app for managing knowledge artifacts and todos.

## Current scope

Implemented feature set:
- Artifact CRUD with optimistic locking (manual save, no autosave)
- Artifact kinds: `insight`, `theory`, `model`, `reference`, `note`
- Artifact list: pagination, keyword search, kind filters, tag filters (`tags_mode=all`)
- Global quick switcher (`Cmd+K` / `Ctrl+K`) for title navigation
- Semantic links/backlinks (`[[Title]]`) with related panel in editor
- Graph view (semantic, explicit, shared-tag, shared-source edges)
- Weight tracking UI (`/weight`): quick log, editable history, trend chart, pattern cards
- Todo CRUD with statuses (`active`, `waiting`, `done`)
- Journal entry CRUD with optimistic locking, `source`/`version` columns, media upload (R2), async embeddings
- Entry templates with slug, default tags, sort order
- Top nav inside auth gate: `Knowledge Base`, `Journal`, `Weight`, and `Todos`

For implementation rollout details, see `specs/web-feature-rollout.md` and `specs/web-journaling.md`.

## Stack

| Layer | Technology | Purpose |
|---|---|---|
| Framework | React 19 + Vite | SPA with HMR |
| Routing | React Router | Client-side routing |
| Editor | MDXEditor | Markdown editing |
| Styling | Tailwind CSS v4 | Theming and layout |
| Graph | react-force-graph-2d | Force-directed artifact graph |
| Upload | multer | Multipart media upload |
| Testing | Playwright | End-to-end coverage |

## Routes

| Path | Component | Description |
|---|---|---|
| `/` | `ArtifactList` | Artifact list + search/filter + list/graph toggle |
| `/new` | `ArtifactCreate` | Create artifact |
| `/weight` | `Weight` | Log daily weight, review history, view trend/pattern metrics |
| `/:id` | `ArtifactEdit` | Edit artifact, related panel, preview toggle |
| `/todos` | `TodoList` | Todo list with status filters + pagination |
| `/todos/new` | `TodoCreate` | Create todo |
| `/todos/:id` | `TodoEdit` | Edit/delete todo |
| `/journal` | `EntryList` | Entry timeline grouped by day with filters |
| `/journal/new` | `EntryCreate` | Create entry with template picker + media upload |
| `/journal/:uuid` | `EntryEdit` | Edit entry with media gallery + conflict handling |
| `/templates` | `TemplateList` | List/manage entry templates |
| `/templates/new` | `TemplateCreate` | Create entry template |
| `/templates/:id` | `TemplateEdit` | Edit entry template |

## REST contract used by the web app

All endpoints require bearer token auth (`MCP_SECRET`) from the auth gate.

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/api/artifacts` | GET | `?limit&offset&kind&tags&tags_mode` | `{ items: Artifact[], total: number }` |
| `/api/artifacts` | GET | `?q&kind&tags&tags_mode` | `Artifact[]` |
| `/api/artifacts/tags` | GET | — | `{ name, count }[]` |
| `/api/artifacts/titles` | GET | — | `{ id, title, kind }[]` |
| `/api/artifacts/graph` | GET | — | `{ nodes, edges }` |
| `/api/artifacts/:id/related` | GET | — | `{ semantic, explicit }` |
| `/api/artifacts/:id` | GET | — | `Artifact` |
| `/api/artifacts` | POST | `{ kind, title, body, tags?, source_entry_uuids? }` | `Artifact` |
| `/api/artifacts/:id` | PUT | `{ kind?, title?, body?, tags?, source_entry_uuids?, expected_version }` | `Artifact` (`409` on conflict) |
| `/api/artifacts/:id` | DELETE | — | `{ status: "deleted" }` |
| `/api/entries/search` | GET | `?q&limit` | `{ uuid, created_at, preview }[]` |
| `/api/weights` | GET | `?from&to&limit&offset` | `{ items: WeightEntry[], total: number }` |
| `/api/weights/:date` | PUT | `{ weight_kg }` | `WeightEntry` |
| `/api/weights/:date` | DELETE | — | `{ status: "deleted" }` |
| `/api/weights/patterns` | GET | `?from&to` | `WeightPatterns` |
| `/api/todos` | GET | `?status&limit&offset` | `{ items: Todo[], total: number }` |
| `/api/todos/:id` | GET | — | `Todo` |
| `/api/todos` | POST | `{ title, status?, next_step?, body?, tags? }` | `Todo` |
| `/api/todos/:id` | PUT | `{ title?, status?, next_step?, body?, tags? }` | `Todo` |
| `/api/todos/:id` | DELETE | — | `{ status: "deleted" }` |
| `/api/entries` | GET | `?limit&offset&from&to&tag&source&q` | `{ items: Entry[], total: number }` |
| `/api/entries` | POST | `{ text, tags?, timezone?, city?, ... }` | `Entry` |
| `/api/entries/:uuid` | GET | — | `Entry` (with tags, media, version, source) |
| `/api/entries/:uuid` | PUT | `{ text?, tags?, expected_version, ... }` | `Entry` (`409` on conflict) |
| `/api/entries/:uuid` | DELETE | — | `{ status: "deleted" }` |
| `/api/entries/:uuid/media` | POST | `multipart/form-data` image | `Media` |
| `/api/media/:id` | DELETE | — | `{ status: "deleted" }` |
| `/api/templates` | GET | — | `Template[]` |
| `/api/templates` | POST | `{ slug, name, body?, description?, default_tags?, sort_order? }` | `Template` |
| `/api/templates/:id` | GET | — | `Template` |
| `/api/templates/:id` | PUT | `{ name?, body?, description?, default_tags?, sort_order? }` | `Template` |
| `/api/templates/:id` | DELETE | — | `{ status: "deleted" }` |

## UI behavior

### Artifact list
- List mode: search box, kind pills, tag pills, paginated cards (10/page).
- Graph mode: hides list/search/filter controls and renders force graph.
- View preference persists in `localStorage` (`espejo_view`).
- Tag filtering is AND semantics by sending comma-separated tags + `tags_mode=all`.

### Quick switcher
- Opens on `Cmd+K` / `Ctrl+K` globally.
- Fetches titles on open and caches for 30 seconds.
- Keyboard controls: arrow up/down, Enter to navigate, Escape to close.
- Empty query inserts `New artifact` shortcut (`/new`) as first result.

### Artifact edit
- Manual save only.
- Related section combines semantic matches and explicit links/backlinks.
- Preview mode renders `[[Title]]` as internal links when title-to-id resolution exists.
- Markdown editor includes `[[]]` link insertion affordance.

### Todos
- Status lifecycle: `active`, `waiting`, `done`.
- List supports status filtering and pagination with URL page params.
- Create/edit pages follow artifact-style manual save pattern.

### Journal entries
- Entry list: timeline grouped by day with filters (date range, source, tag, text search).
- Entry create: template picker pre-fills body/tags, markdown editor, media upload.
- Entry edit: same editor with media gallery, optimistic conflict handling (409 on stale version).
- Source column tracks origin (`dayone`, `web`, `telegram`).
- Async embedding generation on create/update, version-guarded to prevent stale overwrites.

### Templates
- Entry templates with slug, name, description, body, default tags, sort order.
- Template CRUD pages follow artifact-style manual save pattern.
- Template picker on entry create page.

### Weight
- Quick log card upserts weight for a selected date.
- Range pills (`30d`, `90d`, `365d`, `All`) drive history and pattern metrics.
- History table supports inline edit/delete and delta vs previous logged day.
- Trend chart shows raw series plus 7-point and 30-point moving averages.
- Pattern cards show deltas, pace, consistency, streak, volatility, and plateau flag.

## Theming

Custom CSS variables in `web/src/index.css` include:
- Artifact badge colors including `note`
- Todo status badges (`active`, `waiting`, `done`)
- Light/dark values for both sets

## Verification

Automated:
```bash
pnpm check
cd web && npx vite build
cd web && pnpm e2e
```

Manual smoke checklist:
1. Create/edit a `note` artifact and confirm badge/filter visibility.
2. On `/`, combine kind + tag + search filters and verify results.
3. Open quick switcher with `Cmd+K`/`Ctrl+K`, navigate by keyboard.
4. Add `[[Title]]` in editor, save, verify explicit links/backlinks and preview links.
5. Toggle graph view, verify node click navigation and edge variety.
6. Create/edit/delete todos and verify status filters + pagination behavior.
