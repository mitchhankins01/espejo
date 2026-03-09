# Architecture

> Back to [AGENTS.md](../AGENTS.md)

## HTTP REST API

Beyond MCP transport and Telegram webhook, the HTTP server (`src/transports/http.ts`) exposes REST endpoints authenticated via bearer token (`MCP_SECRET`):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/weights` | GET | List weight history (`from`, `to`, `limit`, `offset`) |
| `/api/weights/:date` | PUT | Upsert daily weight (`{ weight_kg }`) |
| `/api/weights/:date` | DELETE | Delete daily weight by date |
| `/api/weights/patterns` | GET | Weight trend/consistency/plateau summary |
| `/api/metrics` | POST | Legacy metrics ingestion (`{ date, weight_kg }`) |
| `/api/activity` | GET | Recent activity logs (supports `limit`, `since`, `tool`) |
| `/api/activity/:id` | GET | Single activity log by ID |
| `/api/spanish/:chatId/dashboard` | GET | Aggregated Spanish learning analytics (retention, funnel, trends, assessment) |
| `/api/spanish/:chatId/assessments` | GET | Spanish assessment history |
| `/api/artifacts` | GET | List/search artifacts. Without `q`: `{ items, total }`; with `q`: array (RRF). Filters: `kind`, `tags`, `tags_mode`, `limit`, `offset` |
| `/api/artifacts/tags` | GET | Artifact tag counts for filter pills |
| `/api/artifacts/titles` | GET | Lightweight artifact titles for quick switcher/link picker |
| `/api/artifacts/graph` | GET | Graph payload (`nodes`, `edges`) for graph view |
| `/api/artifacts/:id/related` | GET | Related artifacts (`semantic` + `explicit` links/backlinks) |
| `/api/artifacts/:id` | GET | Get full artifact with sources and version |
| `/api/artifacts` | POST | Create artifact (`{ kind, title, body, tags?, source_entry_uuids? }`) |
| `/api/artifacts/:id` | PUT | Update artifact with optimistic locking (`expected_version`, 409 on conflict) |
| `/api/artifacts/:id` | DELETE | Delete artifact and cascade source links |
| `/api/entries/search` | GET | Lightweight entry search for source picker (`{ uuid, created_at, preview }`) |
| `/api/content/search` | GET | Unified search across entries + artifacts |
| `/api/todos` | GET | List todos. Filters: `status`, `urgent`, `important`, `parent_id`, `focus_only`, `include_children`, `limit`, `offset`. Returns `{ items, total }` |
| `/api/todos/focus` | GET | Get current focus todo |
| `/api/todos/:id` | GET | Get single todo with children |
| `/api/todos` | POST | Create todo (`{ title, status?, next_step?, body?, tags?, urgent?, important?, parent_id? }`) |
| `/api/todos/:id` | PUT | Update todo (`{ title?, status?, next_step?, body?, tags?, urgent?, important? }`) |
| `/api/todos/:id/complete` | POST | Complete todo (sets done + completed_at + clears focus) |
| `/api/todos/focus` | POST | Set focus `{ id }` or clear `{ clear: true }` |
| `/api/todos/:id` | DELETE | Delete todo |
| `/api/entries` | GET | Paginated entry list with filters (`limit`, `offset`, `from`, `to`, `tag`, `source`, `q`). Returns `{ items, total }` |
| `/api/entries` | POST | Create journal entry (`source='web'`, `version=1`) |
| `/api/entries/:uuid` | GET | Full entry with tags, media, version, source |
| `/api/entries/:uuid` | PUT | Update entry with optimistic locking (`expected_version`, 409 on conflict) |
| `/api/entries/:uuid` | DELETE | Delete entry and dependent rows |
| `/api/entries/:uuid/media` | POST | Upload image (`multipart/form-data`) → R2 → media row |
| `/api/media/:id` | DELETE | Delete media row and best-effort R2 cleanup |
| `/api/templates` | GET | List entry templates ordered by `sort_order` |
| `/api/templates` | POST | Create entry template |
| `/api/templates/:id` | GET | Get single entry template |
| `/api/templates/:id` | PUT | Update entry template |
| `/api/templates/:id` | DELETE | Delete entry template |
| `/api/telegram` | POST | Telegram webhook endpoint (validated via `X-Telegram-Bot-Api-Secret-Token`) |

## Spec Planning Workflow

Automated multi-LLM spec planning. Claude drafts specs with codebase context, Codex reviews with fresh eyes, and they iterate to convergence.

```bash
pnpm spec:plan <name> <description>
```
