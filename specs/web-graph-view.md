# Web App: Graph View

## Context

Artifacts connect through semantic similarity, explicit wiki-links, shared tags, and shared source entries. A force-directed graph visualizes these connections, making the knowledge base feel like an interconnected web rather than a flat list. Depends on Features 1-3 (tag filtering, quick switcher titles endpoint, semantic links + artifact_links table).

## Requirements

- Toggle between list view and graph view on the list page
- Force-directed layout with artifacts as nodes, connections as edges
- Node colors by artifact kind (reuse badge color palette)
- Edge types with distinct visual styles:
  - Semantic similarity (solid, thickness = similarity strength)
  - Explicit `[[]]` links (solid, bold)
  - Shared tags (dashed)
  - Shared source entries (dotted)
- Click node → navigate to artifact edit page
- Hover node → show title tooltip
- Works in both light and dark mode
- Store view preference in localStorage

## Dependency

Add to `web/package.json`:
```
"react-force-graph-2d": "^1.26.0"
```

## Backend Changes

### `src/db/queries.ts`

**`getArtifactGraph(pool)`** — Returns all data needed to build the graph:
```typescript
export async function getArtifactGraph(pool: pg.Pool): Promise<{
  artifacts: { id: string; title: string; kind: string; tags: string[]; has_embedding: boolean }[];
  explicitLinks: { source_id: string; target_id: string }[];
  sharedSources: { artifact_id_1: string; artifact_id_2: string }[];
  similarities: { id_1: string; id_2: string; similarity: number }[];
}> {
```

Queries:
1. All artifacts with tags (reuse existing `listArtifacts` query pattern, no pagination)
2. All explicit links: `SELECT source_id, target_id FROM artifact_links`
3. Shared source entries:
   ```sql
   SELECT DISTINCT a1.artifact_id AS artifact_id_1, a2.artifact_id AS artifact_id_2
   FROM knowledge_artifact_sources a1
   JOIN knowledge_artifact_sources a2 ON a1.entry_uuid = a2.entry_uuid
   WHERE a1.artifact_id < a2.artifact_id
   ```
4. Pairwise cosine similarity for artifacts with embeddings (with <50 artifacts, compute all pairs server-side):
   ```sql
   SELECT a1.id AS id_1, a2.id AS id_2,
          1 - (a1.embedding <=> a2.embedding) AS similarity
   FROM knowledge_artifacts a1
   CROSS JOIN knowledge_artifacts a2
   WHERE a1.id < a2.id
     AND a1.embedding IS NOT NULL
     AND a2.embedding IS NOT NULL
     AND 1 - (a1.embedding <=> a2.embedding) > 0.3
   ```

### `src/transports/http.ts`

**`GET /api/artifacts/graph`** — Assembles and returns:
```typescript
{
  nodes: { id: string; title: string; kind: string; tags: string[] }[];
  edges: { source: string; target: string; type: "semantic" | "explicit" | "tag" | "source"; weight?: number }[];
}
```

Edge assembly:
- Semantic edges from similarity query (include weight = similarity value)
- Explicit edges from artifact_links
- Tag edges: computed server-side — two artifacts share an edge if they have at least one tag in common (N^2 is trivial with <50 artifacts)
- Source edges from shared sources query
- Deduplicate: if two artifacts have both semantic + tag edges, keep both (different types, different visual)

## Frontend Changes

### New: `web/src/components/GraphView.tsx`

```typescript
interface GraphViewProps {
  onNavigate: (id: string) => void;
}
```

- Fetch graph data from `getArtifactGraph()` on mount
- Transform to react-force-graph-2d format:
  - `nodes`: `{ id, name: title, kind, val: 1 }`
  - `links`: `{ source, target, type, weight }`
- Node rendering (canvas callback):
  - Circle colored by kind (map from badge colors)
  - Label below with title text
  - Colors read from CSS custom properties via `getComputedStyle(document.documentElement)` for dark/light mode
- Edge rendering:
  - Semantic: solid line, alpha/width proportional to similarity weight
  - Explicit: solid line, bold (width 2-3px), pine accent color
  - Tag: dashed line, muted color
  - Source: dotted line, muted color
- Interactions:
  - `onNodeClick` → `onNavigate(node.id)`
  - `onNodeHover` → show title (built-in tooltip or custom)
  - Zoom/pan (built-in with react-force-graph-2d)
- Sizing: `width` and `height` from container ref + resize observer

### `web/src/pages/ArtifactList.tsx`

- Add view toggle in header (list icon / graph icon buttons):
  ```tsx
  <div className="flex gap-1">
    <button onClick={() => setView("list")} className={...}>List</button>
    <button onClick={() => setView("graph")} className={...}>Graph</button>
  </div>
  ```
- Store preference: `localStorage.getItem/setItem("espejo_view")`
- When `view === "graph"`:
  - Hide search input, kind pills, tag pills, pagination
  - Render `<GraphView onNavigate={(id) => navigate(\`/${id}\`)} />`
  - Graph fills the content area (min-height: calc(100vh - header))
- Keep FAB visible in both views

### `web/src/api.ts`

```typescript
export interface GraphData {
  nodes: { id: string; title: string; kind: string; tags: string[] }[];
  edges: { source: string; target: string; type: "semantic" | "explicit" | "tag" | "source"; weight?: number }[];
}

export function getArtifactGraph(): Promise<GraphData> {
  return apiFetch("/api/artifacts/graph");
}
```

## Existing Code to Reuse

- `BADGE_COLORS` from `ArtifactList.tsx` — extract kind→color mapping for node colors
- `requireBearerAuth` for endpoint auth
- `getArtifactTagsMap` in queries.ts for fetching artifact tags
- react-router-dom `useNavigate()` for node click navigation

## Dark Mode Handling

Canvas-based rendering doesn't inherit CSS. Read theme colors at render time:
```typescript
const style = getComputedStyle(document.documentElement);
const bgColor = style.getPropertyValue('--color-surface-alt').trim();
const textColor = style.getPropertyValue('--color-text-primary').trim();
```

Also listen for `prefers-color-scheme` changes via `matchMedia` to re-read colors.

## Verification

1. Open list page → toggle to graph view → force-directed graph renders with all artifacts as nodes
2. Nodes colored by kind (insight=blue, theory=purple, model=green, reference=tan)
3. Semantic edges between similar artifacts (solid, variable thickness)
4. Explicit link edges (bold solid) if any `[[]]` links exist
5. Shared tag edges (dashed) between artifacts with common tags
6. Shared source edges (dotted) between artifacts linked to same journal entries
7. Click node → navigates to edit page
8. Hover node → shows title
9. Toggle back to list → list view restored
10. Refresh page → view preference persisted
11. Toggle dark mode (OS setting) → graph colors update
12. `pnpm check` passes
