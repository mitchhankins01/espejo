# Brainstorm: Morning & Evening Telegram Commands

**Date:** 2026-03-09
**Status:** Ready for planning

## What We're Building

Wire up `/morning` and `/evening` Telegram commands that guide structured journaling sessions using entry templates from the database. Each command activates an agent mode with a dedicated system prompt, walks through template prompts, and saves a journal entry at the end.

### Morning (`/morning`)

- **Flow:** Guided but freeflow. Bot pre-fills Oura biometrics (sleep score, readiness, HR/HRV), then walks through each template prompt one at a time. User responds naturally to each.
- **Template source:** `entry_templates` row with slug `morning`. Template `body` provides the prompt structure; new `system_prompt` column provides agent instructions.
- **Output:** Bot composes a journal entry from the raw answers — no polishing, no editorial voice. Saves directly with `morning-journal` tag. Mode auto-clears after save.
- **Tone:** Warm, minimal. One prompt at a time. Wait for the response before moving on.

### Evening (`/evening`)

- **Flow:** Structured interview with escape hatches. Follows the question sequence (nervous system → energy → boundary score → system check → signal → story → closing) but if the user goes deep on something, the bot follows the thread and resumes the sequence after.
- **Context gathering:** On `/evening`, bot silently fetches last 7 days of entries + Oura data, assesses the three systems (escalera, boundaries, attachment), and shows a brief 2-3 line summary of what it noticed before the first question.
- **Template source:** `entry_templates` row with slug `evening`. Same `body` + `system_prompt` pattern.
- **Output:** Bot composes a journal entry in the format specified by the evening prompt (nervous system, what gave/drained, boundary score, signal, story, system state, alignment, closing note). Uses the user's own language and voice. Asks for feedback before saving. Mode auto-clears after save.
- **Resilience:** On low-energy nights where the user rushes or deflects, the bot names it and protects the practice. Even a three-line entry counts.

### Weight guideline (evening context)

The evening system prompt includes weight thresholds for assessing escalera state:
- 72.5–73.5 kg: ideal
- < 75 kg: acceptable
- 75–77 kg: danger zone
- > 77 kg: not feeling/looking good

## Why This Approach

### DB template + system_prompt column

Add a `system_prompt TEXT` column to `entry_templates`. This keeps template body (for web UI journaling) and agent instructions (for Telegram modes) in the same source of truth. When the Telegram bot enters `/morning` or `/evening` mode, it fetches the template by slug and uses both:
- `body` → injected as the prompt scaffold (what to ask)
- `system_prompt` → injected as mode-specific agent instructions (how to behave)

**Why not hardcoded in evening-review.ts?** Templates are already a first-class entity with CRUD via web UI. Putting agent prompts there too means you can iterate on the morning/evening experience without code deploys.

### Mode system extension

The existing `AgentMode` type and `getModePrompt()` function in `evening-review.ts` already support mode injection into the agent's system prompt. Extending this:
- Add `"morning"` and `"evening"` to `AgentMode`
- `getModePrompt()` fetches the template's `system_prompt` from DB instead of returning hardcoded strings
- Webhook handlers for `/morning` and `/evening` set the mode and fall through to agent execution

### Auto-clear after save

Mode resets to `"default"` once the entry is saved. No lingering state. Next message is a normal conversation.

### Language is out of scope

Language/Spanish integration is deliberately excluded from this feature. It will be handled as a cross-cutting concern at a higher level so all conversations benefit, not just morning/evening modes.

## Key Decisions

1. **Template-driven, not hardcoded** — Agent prompts live in `entry_templates.system_prompt`, editable via web UI
2. **One prompt at a time** — Morning bot asks each template section sequentially, waits for response
3. **Oura prefill for morning** — Bot auto-fills sleep/readiness/HR/HRV before first prompt
4. **Brief weekly summary for evening** — Bot shows 2-3 line system state assessment before starting interview
5. **Hybrid interview structure for evening** — Follow sequence but chase threads, resume after
6. **Raw save for morning** — No polishing, compose entry from raw answers
7. **Feedback loop for evening** — Bot shows composed entry, asks for approval before saving
8. **Auto-clear mode after save** — Mode resets to default, next message is normal conversation
9. **No language-specific logic** — Language handling will be a separate, global feature

## Scope & Changes

### Schema change
- Add `system_prompt TEXT` column to `entry_templates`

### Template data
- Update `morning` template: rich body (the full template you shared) + system prompt with agent instructions
- Update `evening` template: body (output format) + system prompt (the full evening interviewer prompt)

### Code changes
- `evening-review.ts` — Extend `AgentMode` type, make `getModePrompt()` async (DB fetch by slug)
- `webhook.ts` — Add `/morning` and `/evening` command handlers (set mode, fall through)
- `agent.ts` — Handle async mode prompt, Oura prefill for morning, 7-day context fetch for evening, entry save + mode clear on completion
- `queries.ts` — Add `getTemplateBySlug()` query, update template types for new column

### Test updates
- Unit tests for new mode prompts
- Template query tests
- Webhook routing tests for new commands

## Open Questions

None — all key decisions resolved through brainstorming.
