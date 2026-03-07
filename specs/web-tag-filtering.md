# Web App: Tag Filtering in List View

## Context

The artifact list page (`web/src/pages/ArtifactList.tsx`) has kind filter pills but no tag filtering. The backend API already supports `tags` and `tags_mode` query params, and `listArtifactTags()` already exists in `web/src/api.ts`. This is a frontend-only feature.

## Requirements

- Clickable tag pills below the kind filter pills on the list page
- Click a tag to toggle it as an active filter. Active = pine accent style, inactive = muted (same pattern as kind pills)
- Active tags show "x" to remove
- Multiple active tags use AND mode (comma-joined in API `tags` param)
- Tag filters apply to both paginated list view AND search results
- Reset to page 0 when tag filters change (reuse existing `prevFiltersRef` pattern)
- Fetch available tags on mount via `listArtifactTags()`

## Files to Modify

### `web/src/pages/ArtifactList.tsx`
- Add `tagFilters` state (`string[]`)
- Add `allTags` state fetched from `listArtifactTags()` on mount
- Render tag pill row between kind pills and artifact list
- Pass `tags: tagFilters.join(",")` to `listArtifacts()` call (line 73)
- Pass `tags` to `searchArtifacts()` call (line 69)
- Add tag filter changes to the `prevFiltersRef` reset-to-page-0 logic (line 55-62)

### `web/src/api.ts`
- Extend `searchArtifacts` to accept optional `tags` param:
  ```typescript
  export function searchArtifacts(q: string, kind?: string, tags?: string): Promise<Artifact[]> {
    const qs = new URLSearchParams({ q });
    if (kind) qs.set("kind", kind);
    if (tags) qs.set("tags", tags);
    return apiFetch(`/api/artifacts?${qs.toString()}`);
  }
  ```

## Existing Code to Reuse

- Kind pill styling pattern (ArtifactList.tsx lines 114-128): active = `bg-pine-600 dark:bg-pine-500 text-white shadow-sm`, inactive = `bg-surface-elevated text-text-muted hover:text-text-primary hover:bg-border`
- Tag display styling already in artifact cards (lines 165-168): `bg-pine-500/10 text-pine-700 dark:text-pine-300`
- `prevFiltersRef` pattern for resetting pagination (lines 49-62)
- `listArtifactTags()` API function already exists (api.ts line 114)

## Verification

1. Open list page — tag pills appear below kind pills
2. Click a tag — list filters to only artifacts with that tag
3. Click a second tag — AND filter, fewer results
4. Click active tag or its "x" — removes filter
5. Combined with kind filter and search — all three filters work together
6. Pagination resets to page 0 when tags change
7. `pnpm check` passes (no backend changes needed)
