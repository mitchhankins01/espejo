# Todo System Spec

Eisenhower-style task tracking with urgency/importance quadrants, a "One Thing" daily focus, and parent/child project hierarchy. Each todo lives in one of four quadrants (Do First, Schedule, Delegate, Someday) based on `urgent` + `important` flags. The focus flag implements the "One Thing" philosophy — one active todo gets full attention.

---

## Data model

### `todos`

```sql
CREATE TABLE IF NOT EXISTS todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waiting', 'done', 'someday')),
  next_step TEXT,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  urgent BOOLEAN NOT NULL DEFAULT FALSE,
  important BOOLEAN NOT NULL DEFAULT FALSE,
  is_focus BOOLEAN NOT NULL DEFAULT FALSE,
  parent_id UUID REFERENCES todos(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_updated ON todos(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id);
CREATE INDEX IF NOT EXISTS idx_todos_focus ON todos(is_focus) WHERE is_focus = TRUE;
CREATE INDEX IF NOT EXISTS idx_todos_quadrant ON todos(urgent, important, status);
```

### Fields

| Field | Purpose |
|-------|---------|
| `title` | What the todo is (e.g., "Spanish taxes 2025") |
| `status` | `active` (actionable now), `waiting` (blocked), `done` (complete), `someday` (parking lot) |
| `next_step` | At-a-glance current action. Shown on list cards. |
| `body` | Markdown for tracking history, notes, context. |
| `tags` | Simple `TEXT[]` (not normalized junction table — todos are lightweight). |
| `urgent` | Eisenhower urgency flag. |
| `important` | Eisenhower importance flag. |
| `is_focus` | "The One Thing" — only one todo can be focused at a time (enforced in app logic). |
| `parent_id` | Self-referencing FK for project hierarchy. Max 2 levels enforced in app logic. |
| `sort_order` | Manual ordering within a list or parent. |
| `completed_at` | Auto-set when status → `done`, cleared when moved to another status. |

### Eisenhower quadrants (derived)

| Quadrant | urgent | important |
|----------|--------|-----------|
| Do First | true | true |
| Schedule | false | true |
| Delegate | true | false |
| Someday | false | false |

### DB invariants

- `updated_at` auto-bumped via trigger on UPDATE (same pattern as `knowledge_artifacts`).
- Tags normalized in app layer: trim, lowercase, dedupe, stable sort.
- `completed_at` set automatically in query layer when status → `done`, cleared on other status transitions.
- `is_focus` uniqueness enforced in app layer — `setTodoFocus` clears all before setting new.
- `parent_id` nesting depth (max 2 levels) enforced in app layer — parent must exist and have no parent itself.

---

## Status model

| Status | Meaning |
|--------|---------|
| `active` | Actionable now (default) |
| `waiting` | Blocked / waiting on someone |
| `done` | Completed (sets `completed_at`) |
| `someday` | Parking lot / maybe later |

---

## Query functions — `src/db/queries.ts`

- `listTodos(pool, { status?, urgent?, important?, parent_id?, focus_only?, include_children?, limit?, offset? })` — returns `{ rows, count }`. `parent_id` accepts `"root"` (top-level only) or a UUID.
- `getTodoById(pool, id)` — includes children array.
- `createTodo(pool, { title, status?, next_step?, body?, tags?, urgent?, important?, parent_id? })` — validates parent exists and is root-level.
- `updateTodo(pool, id, { title?, status?, next_step?, body?, tags?, urgent?, important? })` — auto-sets `completed_at` on done, clears on other status.
- `deleteTodo(pool, id)`
- `completeTodo(pool, id)` — sets done + completed_at + clears focus.
- `setTodoFocus(pool, id?)` — clears all focus, optionally sets new. Returns focused todo or null.
- `getFocusTodo(pool)` — returns current focus todo or null.

---

## MCP Tools — `specs/tools.spec.ts`

| Tool | Purpose |
|------|---------|
| `list_todos` | Filter by status, quadrant, parent, focus. Supports `include_children`. |
| `create_todo` | Create with urgency/importance/parent_id. |
| `update_todo` | Partial update, auto-sets `completed_at` on done. |
| `complete_todo` | Convenience: mark done + clear focus if needed. |
| `set_todo_focus` | Set/clear "The One Thing". |

---

## REST API

All endpoints require bearer token auth (`MCP_SECRET`). Inputs validated with Zod.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/todos` | List todos. Filters: `status`, `urgent`, `important`, `parent_id` (`root` or UUID), `focus_only`, `include_children`, `limit`, `offset`. Returns `{ items, total }`. |
| `GET` | `/api/todos/focus` | Get current focus todo. |
| `GET` | `/api/todos/:id` | Get single todo with children. |
| `POST` | `/api/todos` | Create: `{ title, status?, next_step?, body?, tags?, urgent?, important?, parent_id? }`. |
| `PUT` | `/api/todos/:id` | Update: `{ title?, status?, next_step?, body?, tags?, urgent?, important? }`. |
| `POST` | `/api/todos/:id/complete` | Complete a todo (sets done + completed_at + clears focus). |
| `POST` | `/api/todos/focus` | Set focus `{ id }` or clear `{ clear: true }`. |
| `DELETE` | `/api/todos/:id` | Delete todo. |

---

## Web app

### Routes — `web/src/main.tsx`

```
/todos       -> TodoList (filterable by status, list/matrix view)
/todos/new   -> TodoCreate (with urgent/important toggles, parent picker)
/todos/:id   -> TodoEdit (with focus toggle, complete button, subtasks)
```

### TodoList features

- Focus banner pinned at top (star icon, distinct background)
- List view (default) and Eisenhower Matrix view toggle
- Quadrant indicator badges on cards
- Project cards show child count
- Filter pills: All / Active / Waiting / Someday / Done

### TodoCreate features

- Urgent/important checkboxes
- Parent picker dropdown (loads root-level todos)
- Supports `?parent` URL param for creating subtasks

### TodoEdit features

- Focus toggle button (★/☆)
- Complete button
- Urgent/important checkboxes
- Children/subtasks section with inline "Add subtask" input
- `completed_at` display

---

## Telegram integration

### Context injection — `src/todos/context.ts`

`buildTodoContextPrompt()` injected into Telegram agent system prompt alongside Oura context:
- Current focus todo
- "Do First" quadrant items (urgent + important, active)
- Waiting items count
- Total active count

### Evening/morning prompts — `src/telegram/evening-review.ts`

- **Evening**: Asks "Did you do your one thing?", offers to complete/refocus
- **Morning**: Surfaces focus and Do First items, encourages setting One Thing

---

## Out of scope (future)

- Todo search (no embedding/RRF — just list + filter)
- Todo reminders or scheduling
- Recurring todos
