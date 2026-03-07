# Todo System Spec

Lightweight task tracking with daily-step workflow. Each todo represents a multi-step goal where you either take one step to advance it (active) or wait because blocked (waiting). Example: Spanish taxes — contact lawyer, wait to hear back, send forms, etc.

---

## Data model

### `todos`

```sql
CREATE TABLE IF NOT EXISTS todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waiting', 'done')),
  next_step TEXT,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_updated ON todos(updated_at DESC);
```

### Fields

| Field | Purpose |
|-------|---------|
| `title` | What the todo is (e.g., "Spanish taxes 2025") |
| `status` | `active` (take a step today), `waiting` (blocked, waiting on external), `done` (complete) |
| `next_step` | At-a-glance current action (e.g., "Send accountant the modelo 720 forms"). Shown on list cards. |
| `body` | Markdown for tracking history, notes, context. Updated as you progress. |
| `tags` | Simple `TEXT[]` (not normalized junction table — todos are lightweight). |

### DB invariants

- `updated_at` auto-bumped via trigger on UPDATE (same pattern as `knowledge_artifacts`).
- Tags normalized in app layer: trim, lowercase, dedupe, stable sort.

---

## REST API

All endpoints require bearer token auth (`MCP_SECRET`). Inputs validated with Zod.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/todos` | List todos. Optional `?status=active\|waiting\|done`, `?limit=` (default 20, max 100), `?offset=`. Returns `{ items, total }`. Ordered by `updated_at DESC`. |
| `GET` | `/api/todos/:id` | Get single todo. |
| `POST` | `/api/todos` | Create: `{ title, status?, next_step?, body?, tags? }`. Status defaults to `active`. |
| `PUT` | `/api/todos/:id` | Update: `{ title?, status?, next_step?, body?, tags? }`. No optimistic locking (single user). |
| `DELETE` | `/api/todos/:id` | Delete todo. |

### Zod schemas

```typescript
const todoStatusSchema = z.enum(["active", "waiting", "done"]);

const createTodoSchema = z.object({
  title: z.string().min(1).max(300),
  status: todoStatusSchema.optional(),
  next_step: z.string().max(500).nullable().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const updateTodoSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  status: todoStatusSchema.optional(),
  next_step: z.string().max(500).nullable().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
```

---

## Query functions — `src/db/queries.ts`

- `listTodos(pool, { status?, limit?, offset? })` — returns `{ rows, count }`
- `getTodoById(pool, id)`
- `createTodo(pool, { title, status?, next_step?, body?, tags? })`
- `updateTodo(pool, id, { title?, status?, next_step?, body?, tags? })`
- `deleteTodo(pool, id)`

---

## Web app

### Routes — `web/src/main.tsx`

```
/todos       -> TodoList (filterable by status)
/todos/new   -> TodoCreate
/todos/:id   -> TodoEdit
```

React Router v6 matches static segments before dynamic, so `/todos` won't conflict with existing `/:id` artifact route.

### Navigation

Add a minimal nav bar inside `AuthGate` (above `<Routes>`) with two links:
- "Knowledge Base" (`/`)
- "Todos" (`/todos`)

Highlight active link via `useLocation()`.

### TodoList page — `web/src/pages/TodoList.tsx`

Pattern from `ArtifactList.tsx`:
- Status filter pills: All / Active / Waiting / Done
- Cards show: status badge (colored), title, next_step preview (muted italic if present), tags, updated date
- Cards link to `/todos/:id`
- Floating action button → `/todos/new`
- Pagination with URL search params (`?page=N`)

### TodoCreate page — `web/src/pages/TodoCreate.tsx`

Pattern from `ArtifactCreate.tsx`:
- Title input (required)
- Status defaults to "active"
- Next step input (optional, single line)
- Body (MarkdownEditor, optional)
- Tags (TagInput component)
- Create button → navigate to `/todos/:id`

### TodoEdit page — `web/src/pages/TodoEdit.tsx`

Pattern from `ArtifactEdit.tsx`:
- Back arrow + "Edit Todo" header + Save/Delete buttons
- Title, Status (StatusSelect dropdown), Next Step, Body (MarkdownEditor), Tags
- Manual save (no autosave)
- Save → `navigate(-1)` to preserve history

### StatusSelect component — `web/src/components/StatusSelect.tsx`

Simple dropdown for `active | waiting | done`. Same pattern as `KindSelect.tsx`.

### Styling — `web/src/index.css`

Add status badge CSS variables in `@theme` (light) and dark override:

| Status | Light bg | Light text | Dark bg | Dark text |
|--------|----------|------------|---------|-----------|
| active | `#daf0e2` | `#1a6b3a` | `#1e3828` | `#82d8a0` |
| waiting | `#fef3cd` | `#856404` | `#3a3218` | `#e8c86a` |
| done | `#e8e8e8` | `#6b6b6b` | `#333333` | `#999999` |

Use Tailwind classes in components: `bg-badge-active-bg text-badge-active-text`, etc.

### Web API client — `web/src/api.ts`

```typescript
export interface Todo {
  id: string;
  title: string;
  status: "active" | "waiting" | "done";
  next_step: string | null;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}
```

Add CRUD functions using existing `apiFetch` helper.

---

## Implementation order

1. Migration 019: Add "note" kind to artifact CHECK constraint
2. Migration 020: Create `todos` table with trigger
3. Update `specs/schema.sql` with both changes
4. Backend: queries in `src/db/queries.ts` + API endpoints in `src/transports/http.ts` + add "note" to `artifactKindSchema`
5. MCP tools spec: add "note" to kind enums in `specs/tools.spec.ts`
6. Frontend: API client, CSS, components, pages, routing, nav
7. `npx vite build` to verify
8. Production migration before push

---

## Note kind changes (alongside todo system)

Add `"note"` to artifact kinds in these files:

| File | Location |
|------|----------|
| `scripts/migrate.ts` | Migration 019: ALTER CHECK constraint |
| `specs/schema.sql` | Line 565 |
| `specs/tools.spec.ts` | Lines 549, 574, 600 |
| `src/transports/http.ts` | `artifactKindSchema` (line 294) |
| `web/src/api.ts` | `Artifact.kind` type (line 3) |
| `web/src/pages/ArtifactList.tsx` | KINDS, KIND_LABELS, BADGE_COLORS |
| `web/src/components/KindSelect.tsx` | KINDS array |
| `web/src/index.css` | Badge colors: light `#f0ece5`/`#5a4d38`, dark `#3a3428`/`#d4c8a8` |

---

## Out of scope (future)

- MCP tools for todos (can add `list_todos`, `create_todo` etc. later for Telegram agent)
- Todo search (no embedding/RRF — just list + filter for now)
- Todo reminders or scheduling
