# Knowledge Base Spec (Knowledge Artifacts, Revised)

Synthesized knowledge (insights, theories, models, and references) as a first-class content type in Postgres, searchable alongside journal entries, editable through a web app, and readable through MCP.

---

## Scope and constraints

### Naming decision (resolved)

- "Knowledge base" is the user-facing feature name.
- "Knowledge artifact" is the storage/search unit in schema, queries, and tools.
- This spec uses "knowledge artifacts" for implementation detail and "knowledge base" for product scope.

### Goals

- Add durable, searchable "knowledge artifacts" derived from journal data and external study.
- Keep MCP write access disabled (read-only tools only).
- Reuse existing architecture: Postgres + pgvector, Express, embed script, test stack.

### Non-goals

- No background workers.
- No new deployment service.
- No changes to Telegram write behavior.

### Compatibility guardrail

`search_entries` must remain backward compatible (same default scope and response shape). Unified cross-type search is exposed through a new tool/API path to avoid breaking existing MCP and tests.

### Search decision (resolved)

- Keep `search_entries` unchanged (journal-only, existing response contract).
- Add `search_content` as the unified cross-type search surface.
- Do not add mixed-output behavior to `search_entries` in v1.

---

## TODO checklist

- [x] Align naming and scope (`knowledge base` feature, `knowledge_artifact` data model).
- [x] Resolve unified search strategy (`search_content` added, `search_entries` unchanged).
- [x] Finalize schema DDL in `specs/schema.sql` (tables, indexes, trigger).
- [x] Finalize query functions in `src/db/queries.ts` for CRUD/list/search.
- [x] Extend `scripts/embed-entries.ts` with artifact embedding pass + invalidation behavior.
- [x] Add MCP tool contracts in `specs/tools.spec.ts`.
- [x] Implement MCP handlers and register in `src/server.ts`.
- [x] Add HTTP endpoints in `src/transports/http.ts` with Zod validation.
- [x] Specify/implement web routes and editor conflict handling.
- [x] Add unit and integration tests for artifacts + unified search + optimistic locking.
- [x] Run `pnpm check` clean at the end of each implementation step.
- [x] MDXEditor with markdown shortcuts (toolbar, headings, lists, links, code blocks).
- [x] Markdown preview/render with XSS sanitization (rehype-sanitize on list page).
- [ ] Session auth (httpOnly cookie via `APP_SECRET`) — deferred, single-user.
- [ ] CSRF protection for write endpoints — deferred, no cookie auth.

---

## Critical fixes applied in this revision

1. `source_refs UUID[]` was incompatible with current schema (`entries.uuid` is `TEXT`). Replaced with a normalized join table using `entry_uuid TEXT`.
2. Directly changing `search_entries` to return mixed content would be a breaking contract change. Replaced with a new unified search surface.
3. Tag behavior was underspecified. Added normalization and filter semantics (`any` vs `all`).
4. `updated_at`/`version` consistency depended entirely on API discipline. Added DB trigger requirement.
5. Cookie auth lacked explicit CSRF handling. Added origin + CSRF requirements for write endpoints.

---

## Content taxonomy

### `insight`

Atomic, falsifiable self-observation from lived experience.

### `theory`

Causal model connecting multiple insights/patterns, with predictions.

### `model`

Reusable interpretive framework (self-created or adapted) used as a lens.

### `note`

Personal notes, procedures, and routines — non-analytical reference material (e.g., skincare routine, packing lists, recipes).

### `reference`

Curated external knowledge or structured notes (including LLM-assisted docs when tagged).

---

## Data model

### `knowledge_artifacts`

```sql
CREATE TABLE IF NOT EXISTS knowledge_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('insight', 'theory', 'model', 'reference', 'note')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  body TEXT NOT NULL CHECK (char_length(body) > 0),
  tags TEXT[] NOT NULL DEFAULT '{}',
  embedding vector(1536),
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_embedding
  ON knowledge_artifacts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_tsv
  ON knowledge_artifacts USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_kind
  ON knowledge_artifacts (kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_tags
  ON knowledge_artifacts USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_updated
  ON knowledge_artifacts (updated_at DESC);
```

### `knowledge_artifact_sources`

```sql
CREATE TABLE IF NOT EXISTS knowledge_artifact_sources (
  artifact_id UUID NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
  entry_uuid TEXT NOT NULL REFERENCES entries(uuid) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artifact_id, entry_uuid)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_artifact_sources_entry
  ON knowledge_artifact_sources (entry_uuid);
```

### DB invariants

- Tags are normalized in app layer before write: trim, lowercase, dedupe, stable sort.
- `updated_at` and `version` must be updated in DB via trigger on UPDATE, not only in API code.
- `body` stores markdown text only.

---

## Embedding lifecycle

`pnpm embed` remains the only embedding trigger.

### Behavior

- Existing journal flow remains unchanged.
- After journal entries, process `knowledge_artifacts WHERE embedding IS NULL`.
- Text to embed: `title + "\n\n" + body`.
- On artifact update, if `title` or `body` changed: set `embedding = NULL`, set `embedding_model` to default model string.
- If only `tags`/`kind`/sources changed: keep embedding intact.

### Model changes

- If embedding model changes, run `pnpm embed --force` to re-embed artifacts and entries.
- `embedding_model` enables future auditing/migrations.

---

## Retrieval surfaces

## MCP tools (read-only)

### `get_artifact`

- Input: `{ id }`
- Output: full artifact, normalized tags, source entry UUIDs, `version`, `has_embedding`

### `list_artifacts`

- Input: `{ kind?, tags?, tags_mode?, limit?, offset? }`
- Defaults: `limit=20`, `offset=0`, `tags_mode='any'`
- Max limit: `100`
- Order: `updated_at DESC`

### `search_artifacts`

- Input: `{ query, kind?, tags?, tags_mode?, limit? }`
- Hybrid RRF (semantic + BM25), top-20 per leg, merged with `1/(60 + rank)`
- Null-embedding artifacts can match BM25 leg only

### `search_content` (new unified tool)

- Input: `{ query, content_types?, date_from?, date_to?, city?, entry_tags?, artifact_kind?, artifact_tags?, limit? }`
- `content_types` defaults to `['journal_entry', 'knowledge_artifact']`
- Output rows include:
  - `content_type`
  - `id` (`entries.uuid` or `knowledge_artifacts.id`)
  - `title_or_label`
  - `snippet`
  - `rrf_score`
  - `match_sources`
- Rationale: avoids breaking the existing `search_entries` contract.

### `search_entries` (unchanged default contract)

- Keeps current behavior and schema (journal entries only).
- Optional future extension can be added later, but only behind an explicit opt-in param and updated tool spec/tests.

---

## REST API

Served by existing Express app. All inputs validated with Zod.

### Auth

- Web app uses httpOnly session cookie (`APP_SECRET`-backed).
- Write endpoints (`POST/PUT/DELETE`) require CSRF protection:
  - Validate `Origin`/`Referer`
  - Require CSRF token header tied to session
- `MCP_SECRET` remains server-side only.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/artifacts` | List/search artifacts. `q` triggers RRF search; otherwise list by `updated_at DESC`. Supports `kind`, `tags`, `tags_mode`, `limit`, `offset`. |
| `GET` | `/api/artifacts/:id` | Get full artifact with sources and version. |
| `POST` | `/api/artifacts` | Create: `{ kind, title, body, tags?, source_entry_uuids? }`. |
| `PUT` | `/api/artifacts/:id` | Update: `{ kind?, title?, body?, tags?, source_entry_uuids?, expected_version }`. Returns `409` on version mismatch. |
| `DELETE` | `/api/artifacts/:id` | Delete artifact and source links. |
| `GET` | `/api/entries/search` | Entry lookup for source picker: `{ uuid, created_at, preview }`. |
| `GET` | `/api/content/search` | Unified search for web app using same ranking semantics as `search_content`. |

### API rules

- `tags_mode` supports `any` (overlap) and `all` (contains all).
- Empty strings in tags are rejected.
- `limit` defaults to 20, max 100 for list, max 50 for search.
- `PUT` with no actual field changes returns existing record unchanged and does not bump `version`.

---

## Web app

Vite + React 19 app served as static files from existing Express service. See `specs/web-app.spec.md` for full spec.

### Routes

```text
/        -> Artifact list (paginated, search + kind filter)
/new     -> Artifact editor (create)
/:id     -> Artifact editor (edit with autosave)
```

### Key behaviors

- Bearer token auth gate (validates against `MCP_SECRET` via API).
- MDXEditor for rich markdown editing with toolbar.
- List page: paginated (`{ items, total }` response), 10 per page, kind filter pills, debounced RRF search (kind filter applies to search too).
- Autosave in edit mode: 1500ms debounce, uses `expected_version`.
- On `409`, pause autosave and show conflict banner with reload action.
- Create mode uses explicit Save. Floating action button on list page.
- Tailwind CSS v4 with dark mode via `prefers-color-scheme` (system preference). Pine green accent palette.

---

## Query semantics (required)

### Artifact tags filter

- `tags_mode='any'`: `artifact.tags && $tags`
- `tags_mode='all'`: `artifact.tags @> $tags`

### RRF candidate set

- Semantic leg: top-20
- BM25 leg: top-20
- Unified score: sum of reciprocal rank components

### Null embeddings

- Never included in semantic leg
- Eligible for BM25 leg

---

## Testing requirements

Must pass existing `pnpm check` pipeline with coverage enforcement.

### Unit tests

- Tool param validation for new MCP tools.
- Tag normalization helper.
- `has_embedding` and null-embedding behavior.
- `search_entries` contract remains unchanged.

### Integration tests

- Artifact CRUD with optimistic locking (`409`).
- Source link FK integrity and cascade behavior.
- Embedding invalidation only on title/body changes.
- Artifact RRF ranking and `tags_mode` behavior (`any`/`all`).
- Unified search returns both content types with stable discriminator.
- CSRF rejection for state-changing API calls without token.

---

## Implementation order

1. Schema updates in `specs/schema.sql` (table, join table, indexes, trigger)
2. Query layer additions in `src/db/queries.ts`
3. Embed script extension in `scripts/embed-entries.ts`
4. MCP tool spec additions in `specs/tools.spec.ts`
5. MCP handlers in `src/tools/` + registration in `src/server.ts`
6. HTTP endpoints in `src/transports/http.ts`
7. Web app implementation
8. Test additions (unit + integration)

Run `pnpm check` after each step.

---

## Decision log

- Locked for v1: keep `search_entries` unchanged and use `search_content` for unified results.
- Optional future exploration: opt-in mixed output on `search_entries` only with explicit param + spec/test updates.
