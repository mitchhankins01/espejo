---
title: "fix: MCP null-in-optional-params validation error"
type: fix
status: completed
date: 2026-04-09
---

# fix: MCP null-in-optional-params validation error

## Overview

MCP clients (Claude, etc.) send `null` for omitted optional tool params. Zod's `.optional()` only accepts `undefined`, causing `-32602 Input validation error` across all tools with optional fields.

## Problem Statement

When Claude calls a tool like `entry_stats` without providing `date_to`, the MCP protocol sends `{ "date_to": null }`. Zod rejects this because `.optional()` accepts `string | undefined` but not `string | null`. This affects **46 optional fields** across all tool specs.

```
MCP error -32602: Input validation error: Invalid arguments for tool entry_stats: [
  { "code": "invalid_type", "expected": "string", "received": "null",
    "path": ["date_to"], "message": "Expected string, received null" }
]
```

### Why not `z.preprocess` on the whole inputSchema?

The MCP SDK's `normalizeObjectSchema()` requires `.shape` on the schema for JSON schema generation. Wrapping with `z.preprocess()` produces a `ZodEffects` (no `.shape`), causing the SDK to fall back to `EMPTY_OBJECT_JSON_SCHEMA` — breaking tool discovery for all clients.

## Proposed Solution

Add `.nullable()` before `.optional()` on all 46 optional fields in `specs/tools.spec.ts`. This widens `T | undefined` to `T | null | undefined` while preserving the `ZodObject` shape.

**Existing precedent:** `update_todo.next_step` already uses `.nullable().optional()` at `specs/tools.spec.ts:609`.

## Acceptance Criteria

- [x] All 46 `.optional()` fields in `specs/tools.spec.ts` have `.nullable()` prepended
- [x] Nested optional object (`remember.temporal`) handles null safely via `.nullable().optional()` + `stripNulls` in `validateToolInput`
- [x] `pnpm check` passes (types, lint, tests, coverage)
- [x] Regression tests: null params accepted for string, date, boolean, enum, array, and nested object types
- [x] No behavioral change for existing valid inputs (string values, undefined/omitted params)

## Technical Considerations

### Field categories

| Category | Count | Fix | Risk |
|----------|-------|-----|------|
| String `.optional()` | ~30 | `.nullable().optional()` | None — handlers use truthiness checks |
| Number `.optional()` | ~3 | `.nullable().optional()` | None — handlers use truthiness checks |
| Boolean `.optional()` | ~5 | `.nullable().optional()` | None — handlers use truthiness/`!== undefined` |
| Enum `.optional()` | ~5 | `.nullable().optional()` | None — handlers use truthiness checks |
| Array `.optional()` | ~2 | `.nullable().optional()` | None — handlers gate on truthiness |
| Nested object `.optional()` | 1 (`temporal`) | `.nullable().transform(v => v ?? undefined).optional()` | Destructuring would throw on null without transform |

### No `.default()` interaction

Fields using `.default()` (`limitParam`, `metric`, `days`, `offset`) are NOT optional — they're required with defaults. So `.nullable()` is not needed on those.

### Query layer safety

The query layer uses `!== undefined` guards (e.g., `todos.ts:266`). After this change, `null` would pass that check. However:
- For filter params (`date_from`, `city`): handlers use truthiness (`if (dateFrom)`), so `null` is filtered out. Safe.
- For update params (`update_todo`): `!== undefined` intentionally lets `null` through to clear DB fields. This is correct behavior.

## MVP

### specs/tools.spec.ts

For each `.optional()` field, change from:

```typescript
date_to: dateString.optional().describe("End of date range"),
```

To:

```typescript
date_to: dateString.nullable().optional().describe("End of date range"),
```

For the nested object (`remember.temporal`):

```typescript
temporal: z.object({
  date: dateString.nullable().optional(),
  relevance: z.enum(["upcoming", "ongoing"]).nullable().optional(),
}).nullable().transform(v => v ?? undefined).optional()
  .describe("Optional temporal metadata for future-relevant memories"),
```

### tests/tools/entry-stats.test.ts (or similar)

Add a regression test:

```typescript
it("accepts null for optional date params", async () => {
  // Should not throw — null means "omitted" from MCP client
  const result = await handleEntryStats(pool, { date_from: null, date_to: null });
  expect(result).toContain("total_entries");
});
```

## Sources

- `specs/tools.spec.ts` — all 46 optional fields to patch
- `specs/tools.spec.ts:609` — existing `.nullable().optional()` pattern on `update_todo.next_step`
- `src/db/queries/todos.ts:266` — `!== undefined` guard pattern
- MCP SDK `dist/esm/server/mcp.js:75-82` — `normalizeObjectSchema` + JSON schema fallback
- MCP SDK `dist/esm/server/mcp.js:166-180` — `validateToolInput` using `safeParseAsync`
