# Proactive Check-ins — Telegram Bot Proactive Outreach

## Status: Stub (awaiting spec worker)

## What

Telegram bot initiates conversations throughout the day to gather data and provide value, rather than only responding to user messages.

## Scope

- **Data to gather**: Mood, energy, what you're working on, meals, movement, blockers, wins
- **Check-in schedule**: Fixed times? Adaptive based on patterns? Configurable?
- **Evolution**: Start simple (2-3 check-ins/day), learn what's useful, adjust cadence
- **Data storage**: New table? Patterns? Daily metrics? Structured vs freeform
- **Integration**: Feed into Oura correlations, todo progress, pattern extraction
- **User control**: Snooze, adjust frequency, opt-out of specific check-in types

## Key Questions

- What's the minimum viable check-in that's actually useful and not annoying?
- Should check-ins be structured (multiple choice / quick reply buttons) or conversational?
- How does gathered data feed back into the Insight Engine (spec 1)?
- What does "evolves" mean concretely — ML on response rates? Manual tuning? LLM-decided?
- How to handle ignored check-ins? Back off? Reschedule? Log the non-response?
- Should check-ins be context-aware? (e.g., don't ask "how's your focus?" if no focus todo is set)
- What time zones / schedule awareness is needed?

## Context Budget Note

Check-in responses become data that feeds into agent context. This spec must define:
- How check-in data is summarized vs raw-injected into system prompt
- Whether recent check-in responses get their own context section
- Token budget for check-in context (likely small — a few key data points, not full conversation history)

## Dependencies

- **Insight Engine** (spec 1) — uses insights for "what to ask about" intelligence
- **Memory v2** (spec 3) — check-in data feeds into memory layers
- **Project Management** (spec 5) — check-ins can track project progress ("how's the visa application going?")

## Existing Code to Reuse

| Component | Location | What to reuse |
|-----------|----------|---------------|
| Telegram client | `telegram/client.ts` | `sendMessage` with retry/chunking for outbound messages |
| Agent loop | `telegram/agent.ts` | Conversational check-ins can use the same agent pipeline |
| Oura sync scheduling | `oura/sync.ts` | `setInterval` + advisory lock pattern for scheduling |
| Todo context | `todos/context.ts` | "How's your focus going?" style check-ins |
| Evening/morning review | `telegram/evening-review.ts` | Existing guided session prompts as templates |
| Soul state | `telegram/soul.ts` | Personality-consistent check-in tone |

## Check-in Types (Initial Ideas)

| Type | When | What | Storage |
|------|------|------|---------|
| Morning energy | ~9am | Energy level 1-5, sleep quality feel | daily metric |
| Midday pulse | ~1pm | What you're working on, blockers | freeform → patterns |
| Evening reflection | ~8pm | Wins, gratitude, tomorrow's intention | freeform → patterns |
| Focus nudge | When focus todo set | "How's [todo] going?" | todo progress note |
| Movement prompt | After 3+ hours sedentary (Oura) | Gentle movement suggestion | activity log |

## Open Design Decisions

- [ ] Scheduling: fixed times vs adaptive vs event-driven
- [ ] Format: structured buttons vs conversational vs mixed
- [ ] Storage model: new table, daily_metrics extension, or pattern extraction
- [ ] Adaptation mechanism: how check-ins evolve based on response patterns
- [ ] Snooze/opt-out UX
- [ ] Integration with existing `/morning` and `/evening` commands (complement or replace?)
