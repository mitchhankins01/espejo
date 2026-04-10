# On This Day — Automatic Daily Reflections

**Date:** 2026-04-10
**Status:** Brainstorm complete

## What We're Building

An automatic daily Telegram notification that surfaces journal entries from the same calendar date in prior years, synthesized by Claude into a meaningful reflection. Think Day One's "On This Day" feature, but delivered proactively to Telegram with LLM-generated narrative about themes, evolution, and connections across years.

### Core Behavior

- **Timing:** Sent each morning around 8-9am (user's timezone)
- **Content:** Claude reads all entries from this MM-DD across all years and writes a concise narrative reflection — highlighting significant events, recurring themes, personal growth, and surprising connections
- **Language:** Always in English
- **Empty days:** Skip silently — no message if there are no prior-year entries
- **High volume:** Claude summarizes all entries into a concise synthesis, never dumps walls of text
- **Delivery:** Single Telegram message via `sendTelegramMessage`

## Why This Approach

**Background Timer** (same pattern as Oura sync and Obsidian sync):

- Consistent with established codebase patterns — `setInterval` + `pg_try_advisory_lock` + error notification
- Self-contained within the MCP server process, no external dependencies
- Simple dedup: track last-sent date to prevent double-sends on restart
- Reuses existing `getEntriesOnThisDay` query and `sendTelegramMessage` infrastructure

### Rejected Alternatives

- **Insight Engine:** Would require building the full engine infrastructure first. Overkill for a single feature. Can migrate into it later if the engine gets built.
- **External Cron:** Depends on scheduling outside the app. Fragile, harder to maintain.

## Key Decisions

1. **LLM-synthesized reflection** over raw entry listing — the value is in the narrative, not the data dump
2. **Morning delivery (8-9am)** — start the day with reflection, not wind down
3. **Skip empty days** — keep it high-signal, zero noise
4. **Background timer pattern** — proven in codebase, simple, reliable
5. **Summarize all entries** on high-volume days — Claude distills, never overwhelms

## Implementation Sketch (high-level, not a plan)

- New file: `src/notifications/on-this-day.ts`
- Timer: `startOnThisDayTimer(pool)` — checks hourly, sends at target hour
- Query: Reuse `getEntriesOnThisDay(pool, month, day)` from `src/db/queries/entries.ts`
- Synthesis: Call Claude with entries + system prompt to generate reflection
- Delivery: `sendTelegramMessage(chatId, reflection)` with HTML formatting
- Dedup: Simple last-sent date check (in-memory or lightweight DB) to handle restarts
- Advisory lock: Prevent concurrent sends if multiple instances exist

## Open Questions

None — all key decisions resolved during brainstorm.
