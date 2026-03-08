# Web App: Cmd+K Quick Switcher

> **Status: Implemented** — Global Cmd+K/Ctrl+K with fuzzy search, title cache, keyboard navigation. See `web/src/components/QuickSwitcher.tsx`.

## Context

Navigating between artifacts requires going back to the list and scrolling/searching. A Cmd+K quick switcher provides instant fuzzy-find navigation from any page, similar to Obsidian's quick switcher or VS Code's Cmd+P.

## Requirements

- Global `Cmd+K` / `Ctrl+K` keyboard shortcut opens a modal overlay
- Auto-focused search input with fuzzy matching against all artifact titles
- Arrow key navigation through results, Enter to navigate, Escape to close
- Click outside modal to close
- First option when input is empty: "New artifact" → `/new`
- Each result shows kind badge + title
- Works from any page (list, create, edit)
- Fetches all artifact titles on open; caches in a ref (refresh if stale >30s)
- With <50 artifacts, no pagination needed — return all titles

## Files to Create

### `web/src/components/QuickSwitcher.tsx`

Modal component with:
- `useEffect` for global keydown listener (`Cmd+K` / `Ctrl+K`, prevent default)
- `open` state toggle
- On open: fetch titles via `listArtifactTitles()`, cache in ref
- Search input at top, auto-focused
- Inline fuzzy match function (no external library):
  ```typescript
  function fuzzyMatch(query: string, target: string): number {
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    if (t.startsWith(q)) return 2 + q.length / t.length;
    if (t.includes(q)) return 1 + q.length / t.length;
    let qi = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) qi++;
    }
    return qi === q.length ? qi / t.length : 0;
  }
  ```
- Results list with keyboard nav (selectedIndex state, arrow keys, Enter)
- Click result or Enter → `navigate(\`/${id}\`)` → close modal
- "New artifact" as first result when query is empty
- Styling: fixed z-50, `bg-black/50` backdrop, centered card with `bg-surface`, `border-border`, pine accent for selected item

## Files to Modify

### `web/src/main.tsx`
Render `<QuickSwitcher />` inside `<AuthGate>`, outside `<Routes>`:
```tsx
<AuthGate>
  <QuickSwitcher />
  <Routes>...</Routes>
</AuthGate>
```

### `web/src/api.ts`
Add:
```typescript
export function listArtifactTitles(): Promise<{ id: string; title: string; kind: string }[]> {
  return apiFetch("/api/artifacts/titles");
}
```

### `src/db/queries.ts`
Add:
```typescript
export async function listArtifactTitles(pool: pg.Pool): Promise<{ id: string; title: string; kind: string }[]> {
  const result = await pool.query(
    'SELECT id, title, kind FROM knowledge_artifacts ORDER BY updated_at DESC'
  );
  return result.rows as { id: string; title: string; kind: string }[];
}
```

### `src/transports/http.ts`
Add endpoint before the existing `GET /api/artifacts/:id` (important — route order matters):
```typescript
app.get("/api/artifacts/titles", async (req, res) => {
  if (!requireBearerAuth(req, res)) return;
  try {
    const titles = await listArtifactTitles(pool);
    res.json(titles);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
```

## Existing Code to Reuse

- `BADGE_COLORS` from `ArtifactList.tsx` (lines 31-36) for kind badges in results — consider extracting to a shared constant
- `useNavigate()` from react-router-dom
- Auth pattern: `requireBearerAuth` in http.ts
- Theme variables: `bg-surface`, `border-border`, `text-text-primary`, `text-text-muted`, pine accent colors

## Verification

1. Press Cmd+K on any page — modal opens with search input focused
2. Type partial title — fuzzy matches appear with kind badges
3. Arrow down/up — selection moves
4. Enter — navigates to selected artifact, modal closes
5. Escape or click outside — modal closes
6. Empty input — shows "New artifact" option, Enter navigates to `/new`
7. `pnpm check` passes
