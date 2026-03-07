# Web App — espejo Knowledge Base Frontend

> React + Vite single-page app for managing knowledge artifacts.

## Current Status

**Implemented:**
- React 19 + React Router with 6 routes: `/` (artifact list), `/new` (create artifact), `/:id` (edit artifact), `/todos` (todo list), `/todos/new` (create todo), `/todos/:id` (edit todo)
- MDXEditor for rich markdown editing (toolbar: headings, bold, italic, underline, lists, links)
- Bearer token auth gate (validates against `MCP_SECRET` via API)
- Artifact CRUD: create, read, update (manual save with optimistic locking), delete
- Todo CRUD: create, read, update (manual save), delete with status workflow (active/waiting/done)
- Paginated artifact list (10 per page) with kind filter pills and hybrid RRF search
- Tag management (add/remove tags)
- Source entry linking (search journal entries by text)
- Light/dark mode via `prefers-color-scheme` (system preference, no toggle)
- Tailwind CSS v4 with pine green accent palette and WCAG AA contrast ratios
- Floating action button for artifact creation
- Playwright e2e test suite (auth, CRUD, filters, pagination, theme)

## Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Framework | React 19 + Vite | SPA with HMR |
| Routing | React Router v7 | Client-side routing |
| Editor | MDXEditor | Rich markdown editing |
| Styling | Tailwind CSS v4 | Utility-first styling with dark mode support |
| Testing | Playwright | E2e tests across light/dark mode |
| API | REST via Vite dev proxy | Proxies `/api` to MCP HTTP server |

## Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/` | ArtifactList | Paginated list, search, kind filter pills |
| `/new` | ArtifactCreate | Create form with kind, title, body, tags, sources |
| `/:id` | ArtifactEdit | Edit form with manual save, version display, delete |
| `/todos` | TodoList | Paginated list, status filter pills (active/waiting/done) |
| `/todos/new` | TodoCreate | Create form with title, status, next_step, body, tags |
| `/todos/:id` | TodoEdit | Edit form with manual save, delete |

## API Contract

The frontend communicates with the MCP HTTP server (`src/transports/http.ts`) via REST:

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/api/artifacts` | GET | `?limit=N&offset=N&kind=K` | `{ items: Artifact[], total: number }` |
| `/api/artifacts` | GET | `?q=search&kind=K` | `Artifact[]` (RRF search, no pagination) |
| `/api/artifacts/:id` | GET | — | `Artifact` |
| `/api/artifacts` | POST | `{ kind, title, body, tags?, source_entry_uuids? }` | `Artifact` |
| `/api/artifacts/:id` | PUT | `{ kind?, title?, body?, tags?, source_entry_uuids?, expected_version }` | `Artifact` (409 on conflict) |
| `/api/artifacts/:id` | DELETE | — | — |
| `/api/entries/search` | GET | `?q=text` | `{ uuid, created_at, preview }[]` |
| `/api/todos` | GET | `?status=S&limit=N&offset=N` | `{ items: Todo[], total: number }` |
| `/api/todos/:id` | GET | — | `Todo` |
| `/api/todos` | POST | `{ title, status?, next_step?, body?, tags? }` | `Todo` |
| `/api/todos/:id` | PUT | `{ title?, status?, next_step?, body?, tags? }` | `Todo` |
| `/api/todos/:id` | DELETE | — | — |

## Theming

Tailwind CSS v4 with dark mode via `prefers-color-scheme` media strategy. No manual toggle.

- **Light**: off-white backgrounds, dark green text, `#2e7d50` accent
- **Dark**: deep forest backgrounds, sage text, `#5bb37a` accent
- Kind badges, tags, and status indicators use semantic color classes
- All text/background combinations meet WCAG AA contrast (4.5:1 minimum)

## E2e Testing

Playwright test suite in `web/e2e/`. Runs against the dev backend + Vite dev server.

```bash
cd web
pnpm e2e          # headless (light + dark)
pnpm e2e:headed   # visible browser
pnpm e2e:ui       # Playwright interactive UI
```

Tests run serially (shared dev database). Both light and dark mode projects test the full UI.
