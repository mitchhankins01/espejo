# Telegram Personality Plan

## Problem
The Telegram bot is functionally useful but emotionally flat. It answers correctly, but the voice is generic and does not feel like a consistent companion over time.

## Goals
- Give the bot a clear, consistent personality.
- Keep factual correctness and tool reliability unchanged.
- Let personality adapt to user preference without becoming erratic.
- Preserve safe behavior and concise Telegram-friendly output.

## Non-Goals
- Building a fully separate fine-tuned model.
- Long roleplay personas that reduce truthfulness or tool use quality.
- Per-message random style changes.

## Personality Direction (Default)
`Grounded Reflective Coach`
- Warm, direct, and calm.
- Uses light humor sparingly.
- Encourages reflection and action, not generic motivational fluff.
- Speaks like a thoughtful human text thread, not a help-center bot.

## Design

## 1) Persona Layer in Prompting
Split the current system prompt into layers:
1. Core rules (safety, tools, factual constraints).
2. Output rules (Telegram HTML formatting, length, citations).
3. Persona rules (voice, tone, rhythm, wording patterns).
4. Contextual memory (retrieved patterns).

Why: this isolates style from logic and makes personality easier to tune safely.

## 2) Configurable Presets
Add preset selection via env/config:
- `TELEGRAM_PERSONA_PRESET=coach|friend|concise|analyst`
- `TELEGRAM_PERSONA_INTENSITY=1..3` (how strong the stylistic markers are)

Default:
- `coach` + intensity `2`

## 3) Per-Chat Style Preferences
Track preference by chat so the bot can stabilize style:
- New table (or profile blob) keyed by `chat_id`, e.g. `chat_personality`.
- Fields:
  - `preset`
  - `intensity`
  - `verbosity_preference` (`short|balanced|detailed`)
  - `updated_at`

Update triggers:
- explicit user command (preferred), or
- inferred repeated preference ("be shorter", "just be direct").

## 4) Explicit User Controls
Add lightweight natural-language controls:
- "Use concise mode"
- "Be more direct"
- "Talk like a coach"
- "Reset style"

Implementation path:
- parse intent in agent layer before tool loop;
- update chat personality profile;
- confirm with a short acknowledgment.

## 5) Anti-Flatness Guardrails
Add style constraints to reduce generic responses:
- Avoid repetitive openers across adjacent turns.
- Prefer concrete wording over abstract filler.
- Ask at most one reflective follow-up question unless user requests deeper coaching.
- Keep replies scannable: short paragraphs, one clear next step when relevant.

## 6) Voice Reply Alignment
When replying with TTS:
- map preset to voice settings (voice choice/speed where supported),
- normalize text for speech while preserving tone markers.

## Implementation Plan

## Phase 1: Prompt Refactor + Presets (fast win)
Changes:
- Introduce `src/telegram/persona.ts`:
  - preset definitions
  - intensity rules
  - prompt composer
- Update `buildSystemPrompt` in `src/telegram/agent.ts` to consume persona layer.
- Add config parsing in `src/config.ts` + `.env.example` placeholders.

Tests:
- `tests/tools/telegram-agent.test.ts`:
  - system prompt includes selected preset instructions;
  - fallback behavior for invalid preset/intensity.

Success criteria:
- Bot has visibly consistent voice in 20-message manual chat.

## Phase 2: Per-Chat Preference Persistence
Changes:
- Add migration for `chat_personality`.
- Read preferences at request start in webhook/agent path.
- Write preferences when user sends explicit style changes.

Tests:
- integration tests for read/write profile behavior;
- update tests for preference override precedence.

Success criteria:
- style survives process restarts and remains stable per chat.

## Phase 3: User Controls + Heuristics
Changes:
- implement parser for style-change intents;
- add anti-repetition heuristics (opener and phrasing variety).

Tests:
- intent parsing tests;
- regression tests ensuring tool-calling quality unchanged.

Success criteria:
- users can intentionally steer style in one message.

## Phase 4: Measurement + Iteration
Add optional feedback capture (simple thumbs up/down command or tag).
Track:
- response acceptance proxy (continued engagement),
- explicit style complaints frequency,
- latency/token impact of persona prompts.

Adjust preset text and intensity based on real chats.

## Risks and Mitigations
- Risk: stronger personality can hallucinate confidence.
  - Mitigation: keep factual/tool constraints in core layer above persona layer.
- Risk: style variability increases token usage.
  - Mitigation: intensity cap and concise output rules.
- Risk: user dislikes default tone.
  - Mitigation: explicit preset controls + per-chat persistence.

## Rollout
1. Deploy Phase 1 behind env flag:
   - `TELEGRAM_PERSONA_ENABLED=true`
2. Enable for your chat ID only.
3. Validate for 2-3 days.
4. Enable generally, keep quick rollback flag.

## Immediate Next Build Slice
Implement Phase 1 only:
- persona module
- config/env wiring
- prompt integration
- tests

This gives the fastest visible personality improvement with low risk.
