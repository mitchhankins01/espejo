---
date: 2026-05-02
topic: chat-spanish-to-vivo
---

# Capture in-chat Spanish Q&A into Español Vivo

## What We're Building

A lazy extraction step that runs at the start of `pnpm write-tomo`, before
`ensureStyle()`, and folds any Spanish-relevant Q&A from regular Telegram
chat into `Artifacts/Project/Español Vivo.md`. From Mitch's point of view:
he just chats — asks "how do you say X", gets concept explanations, drops
in mid-sentence Spanish — and the next Tomo's `style.md` already reflects
that material because it's distilled from the freshly-updated Vivo.

No new mode, no command, no per-turn cost. The pipeline is one extra
function call that runs when a Tomo is being written.

## Why This Approach

Three earlier framings got ruled out during the discussion:

1. **Build a separate Tomo plumbing change.** Not needed —
   `scripts/book/style.ts:ensureStyle()` already distills Vivo → style.md
   on every Tomo write. Vivo *is* the source of truth; updating Vivo is
   sufficient.
2. **Per-turn extraction in the agent loop.** Rejected for cost — light
   chat volume (10–60 msgs/day, single chat_id) doesn't justify a per-turn
   classifier; the only consumer that cares about freshness is Tomo writes.
3. **Reuse the `/practice` `EXTRACTION_PROMPT`.** Rejected because that
   prompt's evidence rules require the explicit `[corrected] (why)` shape,
   which doesn't exist in regular chat. Forcing one prompt to handle both
   transcripts dilutes the practice rules.

The chosen shape: **lazy + chat-window-since-last-audit-log + dedicated
extractor prompt**.

## Key Decisions

- **Trigger surface: regular Telegram chat, no command.** Mitch just chats.
  No `/sp` prefix, no mode switch. Capture is invisible.
  *Rationale:* zero friction was the point of the request.

- **Extraction timing: lazy, at write-tomo start.** Add a step before
  `ensureStyle()` in `scripts/write-tomo.ts` that reads recent chat,
  updates Vivo, then lets the existing distillation run.
  *Rationale:* Tomo writes are the only consumer that cares about
  freshness; running on demand avoids per-turn cost and a new cron.

- **Window: messages since the latest `audit_log` timestamp in Vivo.**
  Parse the most recent `YYYY-MM-DD ... — ...` line in `audit_log`, pull
  chat from `config.telegram.allowedChatId` since that date, feed to the
  extractor.
  *Rationale:* `/practice` and write-tomo both append to `audit_log` on
  every successful run, so a single bookmark covers both paths and lets
  them interleave without double-processing.

- **New, dedicated extractor prompt (not an extension of
  `EXTRACTION_PROMPT`).** Lives next to it in `src/prompts/spanish-practice.ts`
  (or a new `spanish-chat.ts` if cleaner). The new prompt's rules are
  shaped for ask/answer/teach turns, not slip/correction turns. The
  practice prompt stays untouched.
  *Rationale:* the two transcripts produce different evidence shapes;
  one prompt handling both contradicts itself.

- **Output contract identical to `/practice`:** the extractor returns
  `{ updated_body, diff_summary }`, and we reuse `runPracticeExtraction`'s
  R2 + Postgres write path. New code for the chat extractor is just the
  prompt + a thin wrapper that calls Anthropic and the existing writer.

- **Single chat assumption is fine.** All chat volume comes from one
  `chat_id` and the env already has `TELEGRAM_ALLOWED_CHAT_ID`. No new
  config, no multi-chat dispatch.

- **No-op when the window is empty or contains no Spanish material.** The
  extractor must be allowed to return "nothing changed" — in that case we
  skip the R2 write and the Postgres upsert and don't append an
  `audit_log` line. (Otherwise an empty run would advance the bookmark
  without recording why.)

## Field-mapping rules (rough — finalize in plan)

The new prompt should encode at least these mappings:

- **"How do you say X?" → answer Y.** Append/refresh `active_vocab` entry
  `{ word: Y, gloss: X, seen: <session date> }`. Skip if already present
  with a recent `seen`.
- **Concept explanation that matches an existing `open_questions` entry.**
  Remove the question (it got answered). Mention in `audit_log`.
- **Concept explanation with no matching open question.** Do nothing —
  don't synthesize a new `open_questions` entry just to immediately resolve
  it. (`open_questions` is for *unresolved* dudas.)
- **Mitch produces Spanish in chat that demonstrates the current `focus`
  internalized.** Refresh `focus.last_evidence` to today.
- **Mitch slips on something already in `recurring_errors` and the agent
  corrects it.** Refresh `last_seen`. Same evidence bar as `/practice`:
  the slip must actually appear in Mitch's text.
- **Tenses, level, profile, focus.topic.** Never mutated by this path.
  Promotions of those fields happen via `/practice` only.

## Open Questions

These are details to settle in `/ce:plan`, not blockers for the design:

1. **Where does the diff_summary land?** Stdout from `pnpm write-tomo` is
   probably enough; no Telegram side-channel needed since no one's waiting.
2. **`--no-vivo-extract` escape hatch on write-tomo?** Useful for myth-mode
   re-runs or replays where you don't want the chat window to mutate Vivo.
   Probably yes, simple flag.
3. **What if the window is huge** (multi-week gap between Tomos)? Light
   volume says this is fine; if it ever isn't, add a max-message cap.
4. **Failure mode if Anthropic returns malformed JSON.** Mirror
   `runPracticeExtraction` — return non-destructive error, log it, let
   Tomo continue with stale Vivo rather than aborting the write.
5. **Naming.** New function probably belongs alongside `runPracticeExtraction`
   in `src/telegram/practice-session.ts` (or a sibling
   `src/spanish/chat-extraction.ts`) — decide during plan.

## Next Steps

→ `/ce:plan` for implementation details.
