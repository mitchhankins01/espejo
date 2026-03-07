# Web App: Semantic Links + Backlinks

## Context

Artifacts discuss interconnected ideas but are currently isolated. The user wants **semantic** connections — "the classroom" and "trauma" might discuss the same core idea. Title matching is insufficient. Artifacts already have embedding vectors (generated via `pnpm embed`, stored in `knowledge_artifacts.embedding`). We use cosine similarity over these embeddings to automatically surface related artifacts, plus support explicit `[[Title]]` manual linking.

## Requirements

### Semantic (automatic)
- On the edit page, show artifacts semantically related to the current one (cosine similarity via pgvector)
- Computed at query time — no pre-computed link table needed (fast with <50 artifacts)
- Show similarity score as a visual indicator
- Only works for artifacts that have embeddings (`embedding IS NOT NULL`)

### Explicit (manual)
- Support `[[Title]]` wiki-link syntax in artifact bodies
- Toolbar button "Link Artifact" in the markdown editor to insert `[[Title]]` via search
- On save, detect `[[Title]]` patterns, resolve to artifact IDs, store in `artifact_links` table
- Preview mode renders `[[Title]]` as clickable links

### Backlinks panel
- Edit page shows "Related" section with both semantic matches and explicit links
- Each entry: clickable link with kind badge

## Schema Change

**`specs/schema.sql`** + new migration — `artifact_links` for explicit links only:
```sql
CREATE TABLE IF NOT EXISTS artifact_links (
    source_id UUID NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
    PRIMARY KEY (source_id, target_id),
    CHECK (source_id != target_id)
);
CREATE INDEX IF NOT EXISTS idx_artifact_links_target ON artifact_links (target_id);
```

## Backend Changes

### `src/db/queries.ts`

**`findSimilarArtifacts(pool, artifactId, limit)`** — Cosine similarity (reuse pattern from `findSimilarEntries` at line 314):
```sql
WITH source AS (SELECT id, embedding FROM knowledge_artifacts WHERE id = $1)
SELECT ka.id, ka.title, ka.kind,
       1 - (ka.embedding <=> s.embedding) AS similarity
FROM knowledge_artifacts ka
CROSS JOIN source s
WHERE ka.id != s.id
  AND ka.embedding IS NOT NULL
  AND s.embedding IS NOT NULL
ORDER BY ka.embedding <=> s.embedding
LIMIT $2
```

**`getExplicitLinks(pool, artifactId)`** — Forward links from this artifact:
```sql
SELECT ka.id, ka.title, ka.kind
FROM knowledge_artifacts ka
JOIN artifact_links al ON al.target_id = ka.id
WHERE al.source_id = $1
ORDER BY ka.title
```

**`getExplicitBacklinks(pool, artifactId)`** — Artifacts that explicitly link TO this one:
```sql
SELECT ka.id, ka.title, ka.kind
FROM knowledge_artifacts ka
JOIN artifact_links al ON al.source_id = ka.id
WHERE al.target_id = $1
ORDER BY ka.title
```

**`syncExplicitLinks(pool, sourceId, targetIds)`**:
```typescript
await pool.query('DELETE FROM artifact_links WHERE source_id = $1', [sourceId]);
for (const targetId of targetIds) {
  await pool.query(
    'INSERT INTO artifact_links (source_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [sourceId, targetId]
  );
}
```

**`resolveArtifactTitleToId(pool, title)`** — Case-insensitive title lookup:
```sql
SELECT id FROM knowledge_artifacts WHERE lower(title) = lower($1) LIMIT 1
```

### `src/transports/http.ts`

**`GET /api/artifacts/:id/related`** — Returns:
```typescript
{
  semantic: { id: string; title: string; kind: string; similarity: number }[];
  explicit: { id: string; title: string; kind: string; direction: "outgoing" | "incoming" }[];
}
```
- Calls `findSimilarArtifacts(pool, id, 10)` for semantic
- Calls `getExplicitLinks(pool, id)` + `getExplicitBacklinks(pool, id)` for explicit (tagged with direction)

**Modify POST `/api/artifacts`** and **PUT `/api/artifacts/:id`** handlers:
After successful create/update, scan body for `[[Title]]` patterns:
```typescript
const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;
const titles = [...body.matchAll(wikiLinkPattern)].map(m => m[1]);
const targetIds = await Promise.all(
  titles.map(t => resolveArtifactTitleToId(pool, t))
);
await syncExplicitLinks(pool, artifactId, targetIds.filter(Boolean));
```

## Frontend Changes

### `web/src/api.ts`
```typescript
export interface RelatedArtifacts {
  semantic: { id: string; title: string; kind: string; similarity: number }[];
  explicit: { id: string; title: string; kind: string; direction: "outgoing" | "incoming" }[];
}

export function getRelatedArtifacts(id: string): Promise<RelatedArtifacts> {
  return apiFetch(`/api/artifacts/${id}/related`);
}
```

### `web/src/pages/ArtifactEdit.tsx`
- Fetch related artifacts on load: `getRelatedArtifacts(id)` in parallel with `getArtifact(id)`
- Render "Related" section below Source Entries:
  - **Semantic matches**: Each shows kind badge, title (clickable Link), and similarity indicator (e.g., opacity or small colored dot)
  - **Explicit links**: Each shows kind badge, title (clickable Link), and direction icon (outgoing arrow vs incoming arrow)
  - Empty state: "No related artifacts found" in muted text
- Add Edit/Preview toggle button next to "Body (Markdown)" label:
  - Edit mode: MDXEditor (current behavior)
  - Preview mode: Render markdown with `[[Title]]` resolved to `<Link to="/${id}">Title</Link>`. Use the titles list (from `listArtifactTitles` cache or fetch). Simple regex replacement on the rendered HTML/text.

### `web/src/components/MarkdownEditor.tsx`
- Add toolbar button "Link Artifact" (label: `[[]]` or chain-link icon)
- On click: open a small search dropdown (similar to SourcePicker pattern)
- Fetch/reuse `listArtifactTitles()` cache
- On title selection: insert `[[Selected Title]]` at cursor via MDXEditor API
- If inserting at cursor is complex with MDXEditor, alternative: append to end of body

### `web/src/pages/ArtifactList.tsx`
- Update `plainSnippet` to strip wiki-link syntax:
  ```typescript
  .replace(/\[\[([^\]]+)\]\]/g, "$1")
  ```

## Existing Code to Reuse

- `findSimilarEntries` pattern in `queries.ts` (line 314) — same cosine similarity approach with `<=>` operator
- `SourcePicker` component pattern for the toolbar link search dropdown
- `BADGE_COLORS` for kind badges in the related section
- `listArtifactTitles()` from Feature 2 (quick switcher) — reuse the same cache
- `requireBearerAuth` for new endpoint auth

## Verification

1. Edit an artifact that has an embedding → "Related" section shows semantically similar artifacts with similarity scores
2. Click "Link Artifact" toolbar button → search dropdown → select title → `[[Title]]` inserted in body
3. Save artifact with `[[Title]]` in body → reload → explicit link appears in related section
4. Navigate to the linked artifact → its "Related" section shows an incoming explicit link back
5. Toggle to Preview mode → `[[Title]]` renders as clickable link → click navigates
6. Artifact without embedding → semantic section empty, explicit links still work
7. Run migration: `NODE_ENV=production DATABASE_URL=<url> pnpm migrate`
8. `pnpm check` passes
