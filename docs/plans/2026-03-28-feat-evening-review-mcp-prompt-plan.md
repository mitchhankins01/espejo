---
title: "feat: Add evening review MCP prompt and save tool"
type: feat
status: active
date: 2026-03-28
origin: docs/brainstorms/2026-03-28-evening-review-mcp-brainstorm.md
---

# feat: Add Evening Review MCP Prompt and Save Tool

## Overview

Replace the manual workflow of pasting a long evening review system prompt into Claude Desktop with two MCP primitives:

1. **MCP Prompt `evening-review`** — One click in the prompt picker assembles 7 days of context (entries, past reviews, Oura weekly, weight trend) + the full evening review system prompt. Session starts immediately.
2. **MCP Tool `save_evening_review`** — Saves the final review text as a knowledge artifact (`kind: 'review'`, `status: 'pending'`, `source: 'mcp'`).

(see brainstorm: `docs/brainstorms/2026-03-28-evening-review-mcp-brainstorm.md`)

## Problem Statement / Motivation

Three friction points compound into a practice-killing loop:

1. **Setup friction** — Pasting a system prompt every evening. On tired/ADHD-resistant nights, this is enough to skip.
2. **Shallow context** — Claude Desktop can't access journal history, Oura biometrics, or past reviews without manual tool calls.
3. **No review-to-review continuity** — The three-system scan (Escalera/Boundaries/Attachment) needs trend data across sessions to work.

The personality (sassy, direct, Dutch) is load-bearing for ADHD engagement — not decorative. Neutral voice triggers disengagement. (see brainstorm: personality section)

## Proposed Solution

### MCP Prompt: `evening-review`

Register via `server.registerPrompt()` — first use of `registerPrompt` in this codebase.

**Prompt handler flow:**
1. Compute 7-day window: `dateFrom = daysAgoInTimezone(7)`, `dateTo = todayInTimezone()`
2. Run 4 parallel queries via `Promise.allSettled` (graceful degradation):
   - `getEntriesByDateRange(pool, dateFrom, dateTo, 50)` — journal entries
   - `listArtifacts(pool, { kind: 'review', limit: 20 })` + filter by `created_at` in last 7 days — past reviews
   - `getOuraWeeklyRows(pool, dateTo)` — Oura weekly analysis
   - `listWeights(pool, { from: dateFrom, to: dateTo })` — weight trend
3. Apply entry truncation (see Truncation Strategy below)
4. Assemble messages:
   - **Message 1 (user role):** System prompt instructions (personality, three-system model, weight guideline, Spanish, output guidance, save instruction)
   - **Message 2 (user role):** Context data (entries, reviews, Oura, weight) with truncation notice if applicable
5. Return `GetPromptResult` with assembled messages

**Why `Promise.allSettled`:** The brainstorm says "degrade gracefully." If Oura is down, entries and reviews still load. Each failed query produces a note like "Oura data unavailable" in the context.

### MCP Tool: `save_evening_review`

Standard tool following spec → handler → registration pattern.

**Input:** `{ text: string, date?: string }`
- `text`: Final review markdown (required, min 1 char)
- `date`: Override date for title (optional, defaults to `todayInTimezone()`). Useful when review runs past midnight — the review is for "today" even if it's technically 1am.

**Behavior:**
1. Validate input via `validateToolInput`
2. Build title: `${date} — Evening Checkin`
3. Check for existing review artifact with same title + `kind: 'review'` (upsert logic)
   - If exists: update body, return "Updated existing review"
   - If new: create artifact with `kind: 'review'`, `status: 'pending'`, `source: 'mcp'`, no tags
4. Generate embedding inline (fire-and-forget, ~500ms)
5. Return artifact ID + confirmation message

**Why upsert:** If the user revises after saving, or Claude calls save twice, we update rather than creating duplicates. Duplicate reviews with conflicting system states would confuse future trend detection. (see brainstorm: resolved question 2)

### Truncation Strategy

Full 7-day entries can be 18k+ tokens. Strategy:

- **Last 2 days (today + yesterday):** Full text — this is the primary material for the review
- **Days 3–7:** Truncated to first 300 chars + tags + date — enough for trend context
- **If truncation applied:** Include a notice at the top of the entries section: `"⚠️ Entries from [date range] were truncated to first 300 characters. Ask me to pull the full text of any specific entry if you need more detail."`

This ensures the user knows context is incomplete before the review starts.

### Entry Truncation Notice

**Requirement from user:** If any entries are truncated, the user must be advised before the review begins. The truncation notice appears in the context data message, before the entries, so Claude sees it immediately and can relay it.

Format:
```
⚠️ CONTEXT NOTE: Entries from March 22-25 were summarized (first 300 chars each) to fit context limits.
Full text is available for today and yesterday. Ask to pull any specific entry if needed.
```

## Technical Considerations

### New files

| File | Purpose |
|------|---------|
| `src/prompts/evening-review.ts` | Prompt handler: context assembly + system prompt |
| `src/tools/save-evening-review.ts` | Save tool handler |

### Modified files

| File | Change |
|------|--------|
| `src/server.ts` | Add `server.registerPrompt()` call + register save tool in handler map |
| `src/db/queries/artifacts.ts` | Extend `createArtifact` to accept optional `source` and `status` params; add `findArtifactByKindAndTitle` query for upsert |
| `specs/tools.spec.ts` | Add `save_evening_review` tool spec |
| `tests/tools/save-evening-review.test.ts` | Tests for save tool |
| `tests/prompts/evening-review.test.ts` | Tests for prompt handler |

### Extending `createArtifact`

Current: hardcodes `INSERT INTO knowledge_artifacts (kind, title, body)` — relies on DB defaults `source='web'`, `status='approved'`.

Change: Add optional `source` and `status` to the data param and include in INSERT when provided:

```typescript
export async function createArtifact(
  pool: pg.Pool,
  data: {
    kind: ArtifactKind;
    title: string;
    body: string;
    tags?: string[];
    source_entry_uuids?: string[];
    source?: ArtifactSource;  // NEW — defaults to DB default ('web')
    status?: ArtifactStatus;  // NEW — defaults to DB default ('approved')
  }
): Promise<ArtifactRow>
```

This is a backwards-compatible change — existing callers are unaffected.

### Review artifact date filtering

`listArtifacts` has no date range filter. Rather than extending the generic function, add a purpose-built query:

```typescript
export async function getRecentReviewArtifacts(
  pool: pg.Pool,
  dateFrom: string,
  dateTo: string,
  limit?: number
): Promise<ArtifactRow[]>
```

This queries `kind = 'review' AND created_at >= dateFrom AND created_at <= dateTo + 1 day` and includes both `pending` and `approved` status.

### Status: `pending` is correct

Verified: `listArtifacts` does NOT filter by status — returns both pending and approved. So the prompt handler will see past pending reviews. Note: `searchArtifacts` (semantic search) does filter `status = 'approved'`, so pending reviews won't appear in general artifact search. This is acceptable — reviews are found by the prompt handler via date query, not via semantic search.

### Embedding generation

Generate inline after save, not batch. The review needs to be searchable by the next session. The `generateEmbedding` function from `src/db/embeddings.ts` takes ~500ms. Fire-and-forget with error logging (don't block the save response on embedding success).

### Wiki link syncing

The REST API calls `syncWikiLinksForArtifact` after creation. The save tool should do the same if the review text contains `[[wiki links]]`. Call it after artifact creation — it's idempotent.

### After-midnight date handling

The `date` param on `save_evening_review` solves this. The system prompt instructs Claude: "When saving, use today's date. If the session started before midnight but it's now past midnight, use yesterday's date." The prompt handler can also embed the session start date in the context for Claude to reference.

## System-Wide Impact

- **No schema changes** — all fields already exist in `knowledge_artifacts` table (`source` already has `'mcp'` in its CHECK constraint, `kind` already has `'review'`)
- **No migration needed**
- **Backwards compatible** — `createArtifact` extension is additive (optional params)
- **First `registerPrompt` usage** — sets the pattern for future MCP prompts (morning review, etc.)

## Acceptance Criteria

- [x] `evening-review` prompt appears in Claude Desktop's prompt picker
- [x] Selecting the prompt returns system prompt + 7-day context (entries, reviews, Oura, weight)
- [x] If entries are truncated, a notice appears in the context before entries
- [x] Missing Oura/weight data degrades gracefully with a note, doesn't fail the prompt
- [x] `save_evening_review` creates an artifact with `kind: 'review'`, `status: 'pending'`, `source: 'mcp'`
- [x] Title format: `YYYY-MM-DD — Evening Checkin`
- [x] Saving twice for the same date updates the existing review (upsert)
- [x] Embedding is generated inline after save
- [x] System prompt includes personality, three-system model, weight guidelines, B1 Spanish, output guidance
- [x] System prompt instructs Claude to call `save_evening_review` at session end
- [x] Review output written in third person (not first person) to avoid future LLM confusion
- [x] `pnpm check` passes (tsc, eslint, vitest with coverage thresholds)

## Dependencies & Risks

**Dependencies:**
- MCP SDK `registerPrompt` API — already available in `@modelcontextprotocol/sdk`, not yet used in codebase. Test mock already exists in `tests/tools/server.test.ts`.
- `generateEmbedding` from `src/db/embeddings.ts` — requires `OPENAI_API_KEY` at runtime.

**Risks:**
- **Token budget:** Worst case (heavy week + daily reviews) could push context to ~25-30k tokens before conversation starts. Mitigation: truncation strategy keeps it manageable. Monitor and adjust thresholds if needed.
- **Prompt primitive support:** Not all MCP clients may support prompts equally. Claude Desktop does. Claude Code may or may not surface prompts in a picker. Mitigation: if needed later, a thin `evening_review` tool wrapper can call the same context assembly function.

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-03-28-evening-review-mcp-brainstorm.md](docs/brainstorms/2026-03-28-evening-review-mcp-brainstorm.md) — Key decisions: MCP Prompt + Tool architecture, 7-day window, minimal context, flexible output format, ADHD-driven personality design, save as pending review artifact.
- **Prior plan:** [docs/plans/2026-03-09-feat-morning-evening-telegram-commands-plan.md](docs/plans/2026-03-09-feat-morning-evening-telegram-commands-plan.md) — Shared session context builder pattern (`src/sessions/context.ts`), truncation considerations, `Promise.all` parallelization.
- **MCP SDK `registerPrompt`:** Returns `GetPromptResult` with `{ description?, messages: PromptMessage[] }` where each message has `role: 'user' | 'assistant'` and `content: { type: 'text', text: string }`.
- **Artifact queries:** `src/db/queries/artifacts.ts` — `createArtifact` (line 344), `listArtifacts` (line 560+).
- **Weight queries:** `src/db/queries/weights.ts` — `listWeights`, `getWeightPatterns`.
- **Oura queries:** `src/tools/get-oura-weekly.ts` — `getOuraWeeklyRows` + `formatOuraWeekly`.
- **Entry queries:** `src/tools/get-entries-by-date.ts` — `getEntriesByDateRange` + `toEntryResult`.
