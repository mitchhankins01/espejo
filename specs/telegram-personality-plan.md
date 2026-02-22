# Telegram Soul Plan (One Personality That Evolves)

## Problem
The bot is useful but feels generic. It needs one stable identity that grows with you over time, not a menu of styles.

## Core Principle
One personality. Continuous growth. Same voice across days, with deeper understanding as shared history increases.

## Goals
- Keep one consistent identity in every conversation.
- Let that identity evolve through real interaction history.
- Make replies feel personal, grounded, and alive without losing factual/tool reliability.
- Preserve safety and concise Telegram-friendly output.

## Non-Goals
- Multiple persona presets.
- Frequent style toggling.
- Random tone changes for novelty.

## Personality Charter (Permanent)
`Steady Companion`
- Warm, direct, and emotionally present.
- Reflective without sounding therapeutic or preachy.
- Honest about uncertainty.
- Gently remembers what matters to you and builds on it.

This charter is fixed and always present in the system prompt.

## What "Soul" Means in Product Terms
"Soul" here means continuity plus memory plus relational accountability:
- Continuity: same emotional texture and wording rhythm over time.
- Memory: references your ongoing themes, not just the current message.
- Accountability: if it misses tone/context, it notices and repairs.

## Architecture

## 1) Stable Core + Evolving State
Split personality into:
- **Core charter** (static, never reset).
- **Soul state** (small evolving profile derived from conversation history).

The response prompt always includes both.

## 2) Soul State Model (Per Chat)
Add one persistent record per `chat_id`, for example `chat_soul_state`:
- `identity_summary` (short paragraph of who the assistant is becoming in this relationship)
- `relational_commitments` (how it should show up for you)
- `tone_signature` (style cues that remain stable)
- `growth_notes` (what changed recently)
- `version`, `updated_at`

Keep this compact so it is always injected without bloating tokens.

## 3) Evolution Loop
After compaction windows (already present in agent flow):
- summarize meaningful interaction shifts,
- produce a proposed soul-state delta,
- merge delta into current soul state with guardrails:
  - no hard personality jumps,
  - no contradiction with core charter,
  - no adoption of unsafe/manipulative behaviors.

## 4) Memory Integration
Current pattern retrieval remains the factual memory channel.
Soul state is the relational style channel.
Prompt order:
1. Core safety/tool rules
2. Core personality charter
3. Soul state snapshot
4. Retrieved patterns + recent messages
5. Formatting constraints

## 5) Repair Behavior
If the assistant feels off-tone or gets corrected:
- acknowledge briefly,
- adjust course immediately,
- store the correction as a candidate growth note for the next soul update.

No "preset switch" language. This is growth, not mode changing.

## 6) Voice Reply Alignment
TTS should preserve the same personality:
- same tone signature in text before synthesis,
- avoid robotic over-formatting,
- keep pacing and warmth consistent with text replies.

## Implementation Plan

## Phase 1: Single-Personality Prompt Foundation
Changes:
- Add `src/telegram/soul.ts`:
  - core personality charter
  - soul-state types
  - prompt composer for personality section
- Update `buildSystemPrompt` in `src/telegram/agent.ts` to include:
  - fixed charter
  - soul-state snapshot (if present)
- Add feature flag:
  - `TELEGRAM_SOUL_ENABLED=true`

Tests:
- system prompt always includes fixed charter;
- no preset/mode fields are referenced anymore;
- fallback when soul state is absent.

Success criteria:
- clear consistency in tone across a 20+ message manual chat.

## Phase 2: Persistent Soul State
Changes:
- Add migration for `chat_soul_state`.
- Add DB queries:
  - `getSoulState(chatId)`
  - `upsertSoulState(chatId, state)`
- Load state at reply time and inject into prompt.

Tests:
- read/write persistence by chat id;
- state survives restarts and deploys.

Success criteria:
- assistant keeps the same relational voice after restart.

## Phase 3: Controlled Evolution Engine
Changes:
- On compaction, run a "soul delta" extraction pass:
  - input: recent chats + existing soul state
  - output: conservative updates only
- Merge function with hard checks:
  - max delta size,
  - no contradiction with charter,
  - no drastic style drift.

Tests:
- delta merge stability tests;
- regression tests for tool-calling behavior.

Success criteria:
- personality changes feel gradual and earned, not abrupt.

## Phase 4: Quality Loop
Add lightweight quality signals:
- explicit "that felt generic" counts,
- explicit "this feels like you know me" counts,
- response latency/token overhead.

Tune merge strictness and soul-state size based on real chats.

## Guardrails
- Truth and tool accuracy always outrank style.
- Never fabricate emotional certainty.
- Never simulate dependency or manipulate attachment.
- Keep replies concise by default even when emotionally rich.
