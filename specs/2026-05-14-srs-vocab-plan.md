---
status: planned
author: Mitch + Claude
date: 2026-05-14
---

# `/srs` — Telegram-driven spaced repetition over Kindle lookups

## Problem

`pnpm import-lookups` already pulls every Kindle vocab-tap into `books/lookups.jsonl` (364 rows today). The Tomo writer inlines a recent slice of those into its prompt so it can naturally reuse the words. But there's no *review* loop — no surface for Mitch to actually relearn the words he tapped, and no signal back to the writer that some words are sticking and some aren't. The writer treats every lookup identically, even when Mitch has clearly forgotten the same word four times.

This spec adds a Telegram `/srs` flow that runs in-chat spaced repetition over those lookups using FSRS, and pipes the resulting state back into the Tomo writer's prompt as `[stalling]` / `[mastered]` annotations on the existing lookups block.

No scheduled push, no cron, no notification. `/srs` is the only entry point. Empty queue → bot says so and ends.

## What's already in place (verified)

- **Callback queries are wired but un-routed for non-slash payloads.** `src/telegram/webhook.ts:41` auth-filters callback updates; `src/telegram/updates.ts:116-117` dedups by `callback_query.id`; `updates.ts:391-406` fires `answerCallbackQuery` and delivers `callback_data` to the router as `AssembledMessage.callbackData` (also mirrored into `text`). Today the router parses that text as a slash and falls through to default chat when it doesn't match — silent breakage for any structured callback payload. This spec fixes that intercept.
- **`sendTelegramMessage(chatId, text, replyMarkup?)`** at `src/telegram/client.ts:77-89` accepts an `inline_keyboard`. **`editTelegramMessageText`** at `:230-266` updates in place and swallows the "message not modified" error.
- **`/done` + aliases** (`/end /stop /finish /fin /terminar /listo /cancel`) are routed via `END_FLOW_ALIASES` in `src/telegram/router.ts`. End-flow dispatch peeks at the active flow type at line ~185 and calls a flow-specific terminator.
- **Flow state** is a typed `Map<chatId, FlowState>` in `src/telegram/flow-state.ts`, in-memory, lost on restart by design. `startPracticeFlow` (`src/telegram/flows/practice.ts:70`) overwrites silently; `startCheckpointFlow` similar.
- **Migrations are inline TypeScript** in `scripts/migrate.ts` (a `migrations` array), not separate `.sql` files. Highest is `052-vault-fs-observability`. The earlier `spanish_vocabulary`/`spanish_reviews` tables from migration 027 were dropped at `scripts/migrate.ts:1127-1128,1153` when the web feature was retired in 2026-04 — this is a clean slate.
- **Tomo writer vocab injection point:** `scripts/write-tomo.ts:323-324` calls `formatLookupsForWriter(recentLookups(lookups, 30))` from `scripts/book/lookups.ts:58`. The DB `pool` is already imported in `write-tomo.ts:31`.
- **`ts-fsrs` is not in `package.json`** — needs to be added.

## What 364 lookups look like today

`books/lookups.jsonl` row shape (verified from file head):

```json
{"word":"diseñó","stem":"diseño","lang":"es",
 "usage":"La escalera que nadie diseñó La dopamina no funciona…",
 "book_title":"Espejo Tomo 0001 - Estoy subiendo y lo se",
 "tomo_n":1,"category":0,
 "looked_up_at":"2026-04-24T10:48:04.322Z",
 "imported_at":"2026-04-24T10:59:57.956Z"}
```

Important: there is **no gloss field**, and Kindle's `vocab.db` itself has no `definition` column either. The dictionary text Mitch sees on-Kindle is rendered from a Kindle dictionary asset, not stored in the export. We have to source glosses ourselves.

Per project memory the `category` column is unused; treat as opaque.

## Decisions (locked)

| Question | Decision |
|---|---|
| Gloss source | Claude Haiku batch at `pnpm import-lookups` time. Stored in `vocab_reviews.gloss`. ~$0.20 one-time backfill of 364 rows; rounding-error per week after. `gloss_override` column reserved for future manual edits. |
| `/srs` while another flow is active | Soft-block for *any* active flow: reply `Termina /done primero — tienes flow X activa.` and bail. No silent overwrites. |
| `status` column on `vocab_reviews` | Add day-one, defaulting `'active'`. Queue queries filter on `status='active'`. No v1 UI — suspend via direct UPDATE if a word pollutes the queue. |
| Stalling definition (windowed) | `state IN ('learning','relearning') OR (lapses >= 2 AND last_review > NOW() - INTERVAL '30 days')` — old lapses age out so a card stops "stalling" once Mitch has it down. |
| Dedup key | `(LOWER(stem), lang)`. Multi-sense ambiguity (e.g. `bajo` adj/prep) handled by multi-sense glosses, not by splitting the card. |
| Callback payload | Encode `vocab_reviews.id` (BIGINT) — fits the 64-byte limit without URL-escaping non-ASCII stems. Forms: `srs:show:<id>`, `srs:rate:<id>:<1|2|3|4>`. |
| Race / stale buttons | Per-card `current_session_id UUID` + `current_session_rated_at TIMESTAMPTZ`. Rate query updates only if session_id matches and rated_at is NULL. Double-tap and yesterday's-button cleanly no-op. |
| New cards per session | Hardcoded `SRS_NEW_PER_SESSION = 5` constant inside the flow file. Due cards (oldest `due` first) first, then up to 5 new. |
| `/done` mid-card after Show but before rate | Discard. No log row written. `current_session_rated_at` stays NULL so the card is eligible again on next `/srs`. |

## Architecture

```
Telegram callback ──► router (NEW: intercept "srs:*" before slash parsing)
                       │
                       ├─ srs:show  ─► flow: reveal gloss, edit message, add rating buttons
                       └─ srs:rate  ─► flow: race-guarded UPDATE + append log + serve next card

Telegram /srs ────────► router (NEW: REGISTERED_SLASHES += "srs")
                       │
                       ├─ getFlow(chatId) truthy? → soft-block
                       └─ startSrsFlow → build queue from DB → send first card

Telegram /done ──────► router END_FLOW_ALIASES (existing) → endSrsFlow → summary + clearFlow

pnpm import-lookups ──► JSONL append (existing) + upsertLookup (NEW)
                                                + Haiku gloss-fill for gloss IS NULL (NEW)

scripts/write-tomo ──► getVocabStateForStems → formatLookupsForWriter(recent, stateByStem)
                                                  │
                                                  └─ bullets gain optional [stalling]/[mastered] tag
```

## Schema (migration 053)

Appended to `scripts/migrate.ts` as `{ name: '053-vocab-reviews', sql: ... }`. Also mirrored into `specs/schema.sql` per CLAUDE.md.

```sql
CREATE TABLE IF NOT EXISTS vocab_reviews (
    id              BIGSERIAL PRIMARY KEY,
    stem            TEXT NOT NULL,
    lang            TEXT NOT NULL,
    gloss           TEXT,
    gloss_override  TEXT,
    sample_usage    TEXT NOT NULL,
    sample_word     TEXT NOT NULL,
    sample_source   TEXT,
    first_seen_at   TIMESTAMPTZ NOT NULL,
    last_seen_at    TIMESTAMPTZ NOT NULL,
    lookups_count   INT NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'active',
    -- ts-fsrs Card fields, persisted verbatim:
    due             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stability       DOUBLE PRECISION NOT NULL DEFAULT 0,
    difficulty      DOUBLE PRECISION NOT NULL DEFAULT 0,
    elapsed_days    DOUBLE PRECISION NOT NULL DEFAULT 0,
    scheduled_days  DOUBLE PRECISION NOT NULL DEFAULT 0,
    reps            INT NOT NULL DEFAULT 0,
    lapses          INT NOT NULL DEFAULT 0,
    state           TEXT NOT NULL DEFAULT 'new',
    last_review     TIMESTAMPTZ,
    -- session-race guard:
    current_session_id        UUID,
    current_session_served_at TIMESTAMPTZ,
    current_session_rated_at  TIMESTAMPTZ,
    chat_id         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT vocab_reviews_state_check  CHECK (state IN ('new','learning','review','relearning')),
    CONSTRAINT vocab_reviews_status_check CHECK (status IN ('active','suspended'))
);
CREATE UNIQUE INDEX IF NOT EXISTS vocab_reviews_stem_lang_idx
    ON vocab_reviews (LOWER(stem), lang);
CREATE INDEX IF NOT EXISTS vocab_reviews_due_idx        ON vocab_reviews (due);
CREATE INDEX IF NOT EXISTS vocab_reviews_state_due_idx  ON vocab_reviews (state, due);
CREATE INDEX IF NOT EXISTS vocab_reviews_status_due_idx ON vocab_reviews (status, due);

CREATE TABLE IF NOT EXISTS vocab_review_log (
    id                BIGSERIAL PRIMARY KEY,
    review_id         BIGINT NOT NULL REFERENCES vocab_reviews(id) ON DELETE CASCADE,
    rating            SMALLINT NOT NULL,
    state_before      TEXT NOT NULL,
    state_after       TEXT NOT NULL,
    stability_before  DOUBLE PRECISION,
    stability_after   DOUBLE PRECISION,
    difficulty_before DOUBLE PRECISION,
    difficulty_after  DOUBLE PRECISION,
    elapsed_days      DOUBLE PRECISION,
    scheduled_days    DOUBLE PRECISION,
    session_id        UUID NOT NULL,
    chat_id           TEXT,
    reviewed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT vocab_review_log_rating_check CHECK (rating IN (1,2,3,4))
);
CREATE INDEX IF NOT EXISTS vocab_review_log_review_idx
    ON vocab_review_log (review_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS vocab_review_log_session_idx
    ON vocab_review_log (session_id);
CREATE INDEX IF NOT EXISTS vocab_review_log_reviewed_at_idx
    ON vocab_review_log (reviewed_at DESC);
```

### Critical SQL

**Idempotent upsert from import-lookups** — never touches FSRS fields on conflict:

```sql
INSERT INTO vocab_reviews
  (stem, lang, sample_usage, sample_word, sample_source,
   first_seen_at, last_seen_at, lookups_count)
VALUES ($1, $2, $3, $4, $5, $6, $6, 1)
ON CONFLICT (LOWER(stem), lang) DO UPDATE SET
  last_seen_at  = GREATEST(vocab_reviews.last_seen_at, EXCLUDED.last_seen_at),
  lookups_count = vocab_reviews.lookups_count + 1,
  sample_usage  = CASE WHEN EXCLUDED.last_seen_at > vocab_reviews.last_seen_at
                       THEN EXCLUDED.sample_usage  ELSE vocab_reviews.sample_usage END,
  sample_word   = CASE WHEN EXCLUDED.last_seen_at > vocab_reviews.last_seen_at
                       THEN EXCLUDED.sample_word   ELSE vocab_reviews.sample_word END,
  sample_source = CASE WHEN EXCLUDED.last_seen_at > vocab_reviews.last_seen_at
                       THEN EXCLUDED.sample_source ELSE vocab_reviews.sample_source END,
  updated_at    = NOW();
```

**Race-safe rate** — only the first rate per `(card, session)` wins:

```sql
UPDATE vocab_reviews
   SET stability=$1, difficulty=$2, elapsed_days=$3, scheduled_days=$4,
       reps=reps+1, lapses=$5, state=$6, due=$7, last_review=NOW(),
       current_session_rated_at=NOW(), updated_at=NOW()
 WHERE id=$8
   AND current_session_id=$9
   AND current_session_rated_at IS NULL
RETURNING id;
```

`rowCount=0` → stale button or double-tap → answerCallbackQuery toast, no log row inserted.

**Session counts** (end-of-session summary):

```sql
SELECT COUNT(*) FROM vocab_reviews
 WHERE status='active' AND state<>'new' AND due <= NOW();                          -- M: due
SELECT COUNT(*) FROM vocab_reviews
 WHERE status='active'
   AND (state IN ('learning','relearning')
        OR (lapses >= 2 AND last_review > NOW() - INTERVAL '30 days'));            -- K: stalling
SELECT COUNT(*) FROM vocab_reviews WHERE status='active' AND state='new';          -- J: new
```

## File-by-file changes

### New files

| File | Purpose |
|---|---|
| `src/telegram/flows/srs.ts` | `startSrsFlow`, `endSrsFlow`, `handleSrsCallback`. Owns queue building, card render, message editing, summary on natural end / `/done`. |
| `src/telegram/srs-callbacks.ts` | Pure parser: `parseSrsCallback("srs:rate:42:3") → {kind:'rate', reviewId:42, rating:3}`. Unit-testable without a Pool. |
| `src/db/queries/vocab-reviews.ts` | All queries: `upsertLookup`, `getDueQueue`, `serveCard`, `rateCard`, `getVocabStateForStems`, `getSessionCounts`. Parameterized only. |
| `src/fsrs/scheduler.ts` | Thin wrapper around `ts-fsrs`. `nextState(card, rating, now): NewCardState`. One-file replacement target if `ts-fsrs` majors. |
| `scripts/backfill-vocab-glosses.ts` | One-shot: SELECT WHERE gloss IS NULL → Haiku → UPDATE. Idempotent. |
| `scripts/seed-vocab-reviews.ts` | One-shot first-run: read `books/lookups.jsonl`, upsert every row into `vocab_reviews`. Idempotent. |

### Edited files

| File | Change |
|---|---|
| `scripts/migrate.ts` | Append migration `053-vocab-reviews` with full DDL above. |
| `specs/schema.sql` | Mirror migration 053 (canonical schema per CLAUDE.md). |
| `src/db/queries/index.ts` | Re-export `./vocab-reviews.js`. |
| `src/telegram/router.ts` | (1) Top of `routeText`: intercept `callbackData?.startsWith("srs:")` → `handleSrsCallback`, return. (2) `REGISTERED_SLASHES += "srs"`. (3) Slash dispatch branch → `startSrsFlow`. (4) End-flow peek branch → `endSrsFlow`. (5) Active-flow continuation: when flow is `srs` and message is plain prose, reply `Toca un botón o /done.` and do not route to chat. |
| `src/telegram/flow-state.ts` | Add `SrsFlowState { flow:"srs"; sessionId:string; startedAt:number; reviewedCount:number; countsByRating:{1:number,2:number,3:number,4:number}; lastServedReviewId:number\|null }`. |
| `scripts/import-lookups.ts` | After existing JSONL append: `upsertLookup` for each newly-appended row, then trigger Haiku gloss-fill for any rows where `gloss IS NULL`. FSRS fields never touched on conflict. |
| `scripts/book/lookups.ts` | Add `VocabState` interface + optional second parameter `stateByStem?: Map<string, VocabState>` to `formatLookupsForWriter`. Bullets gain optional `[stalling: lapses=N]` or `[mastered: stable]` tag. Stays pure (no DB import). |
| `scripts/write-tomo.ts` | Near line 323-324: pull `stateByStem = getVocabStateForStems(pool, recent.map(l => l.stem.toLowerCase()))` and thread into `formatLookupsForWriter`. |
| `Artifacts/Prompt/Spanish/Tomo.md` | Replace the existing "Same stem looked up twice = deliberate vocab reuse candidate" sentence (~line 68) with the expanded annotation guide below. |
| `package.json` | `pnpm add ts-fsrs` (pin to current major). Add `seed:vocab` and `backfill:glosses` scripts. |
| `CLAUDE.md` / `AGENTS.md` | Add `/srs` to the Telegram command surface; mention `vocab_reviews` / `vocab_review_log` in the SOP + Gotchas where relevant. |

## Tomo.md prompt update (replaces ~line 68)

```
Recent reader lookups may arrive with optional state tags:
- `[stalling: lapses=N]` — Mitch has forgotten this headword ≥2 times in spaced
  review (within the last 30 days), or it's currently learning/relearning.
  **Deliberate vocab reuse candidate.** Re-anchor in a different but
  unambiguous context; don't stack two stalling words in one paragraph.
- `[mastered: stable]` — fully learned (FSRS stability ≥ 30d). Safe to use
  freely; not worth re-teaching. Don't avoid them, but don't optimize for them.
- No tag — first/second exposure or no review history. Use naturally where they
  fit. Same stem looked up twice across tomos is still a reuse candidate
  independent of SRS state.

Same inflected form highlighted twice = deliberate grammar exercise candidate
(highlights, not lookups — separate signal).
```

## Telegram UX

- **Soft-block any active flow**: reply `Termina /done primero — tienes flow X activa.` Bail.
- **Empty queue**: `Cola vacía. Vuelve a leer un rato y prueba de nuevo más tarde.`
- **Card front** (HTML; reuse `escapeHtml` from `practice.ts` on user strings):
  ```
  <b>peldaño</b>

  <i>"El primer peldaño — el entrenamiento…"</i>

  [ Show ]
  ```
- **Reveal** (same message, edit in place):
  ```
  <b>peldaño</b> → step / rung (noun)

  <i>"El primer peldaño…"</i>

  [ 1 Again ]  [ 2 Hard ]  [ 3 Good ]  [ 4 Easy ]
  ```
- **After rate** (edit in place, then send next card as new message):
  ```
  ✓ peldaño (good) → next in 4d
  ```
- **Natural end**:
  ```
  Listo. N revisadas (W again, X hard, Y good, Z easy).
  M pendientes, K atascadas, J nuevas esperando.
  ```
- **`/done` early exit**: same shape prefixed `Stopped. `. If a card was shown but not rated, `current_session_rated_at` stays NULL so next `/srs` re-derives the queue and serves it again.
- **Prose mid-flow**: reply `Toca un botón o /done.` Do not route to chat.

## Test plan

| File | Type | Cases |
|---|---|---|
| `tests/telegram/srs-callbacks.test.ts` | pure | parse `srs:show:42`, `srs:rate:42:3`, malformed/unknown, missing rating, empty |
| `tests/telegram/flows/srs-flow.test.ts` | mock `pg.Pool` | empty queue ends cleanly; queue built (due+new cap 5); /done with zero rates; /done after rate; /done mid-card shown-but-not-rated discards; prose mid-flow gets toca-un-botón reply; soft-block on existing flow |
| `tests/telegram/srs-routing.test.ts` | mock | router intercepts `srs:*` before slash parsing; stale callback (mismatched session_id) is answered, no DB write |
| `tests/db/queries/vocab-reviews.test.ts` | test-DB (5433) | upsert preserves FSRS fields on conflict; case-insensitive dedup; getDueQueue ordering; getSessionCounts (M/K/J); rateCard double-call idempotent; status='suspended' excluded |
| `tests/scripts/import-lookups-vocab-sync.test.ts` | test-DB | run twice → FSRS state preserved; later lookup advances `sample_usage` + `last_seen_at` + increments `lookups_count` |
| `tests/fsrs/scheduler.test.ts` | pure | new + rating 3 → learning + future due; rating 1 increments lapses; deterministic with fixed `now` |
| `tests/scripts/book/lookups-state.test.ts` | pure | no-state input matches today's bullets; tags assigned correctly; windowed stalling boundary (lapses=2, last_review 31d ago → NOT stalling) |

`docker-compose.test.yml` on port 5433 already serves the test DB; the seeder runs `migrate.ts` end-to-end, so migration 053 lands automatically.

## `pnpm check` surface

- `src/db/queries/vocab-reviews.ts` enters the **100%-coverage** queries bucket. Match `src/db/queries/checkpoints.ts` for structure; cover every no-row branch and empty-input shortcut.
- `src/telegram/flows/srs.ts`, `src/telegram/srs-callbacks.ts`, `src/fsrs/scheduler.ts` fall under global **95/95/90/95**. The branchiest module is `srs.ts` (empty queue, due-only, new-only, mid-card /done, race no-op). Extract pure `renderCardFront` / `renderCardBack` / `renderRevealedAnswer` helpers so render branches are testable without Telegram mocks.
- `scripts/*.ts` (seed + backfill) are not under coverage thresholds.
- **No existing thresholds move.**

## Out of scope

- No scheduled morning push, no cron, no notification.
- No card edit UI in Telegram. Gloss edits via direct DB UPDATE for v1.
- No EN→ES recognition. Recognition only (ES→EN gloss).
- No FSRS parameter optimization. Use library defaults; the log gives us data to fit later if it ever matters.
- No "resume" UX after walk-away — next `/srs` re-derives queue from DB.
- No v1 surface for `gloss_override` or `status='suspended'`. Columns reserved.

## Verification (post-implementation)

1. `pnpm check` clean.
2. `pnpm migrate` (dev port 5434) — `\d vocab_reviews` / `\d vocab_review_log` match the DDL.
3. `pnpm seed:vocab` — 364 rows in `vocab_reviews`.
4. `pnpm backfill:glosses` — every row now `gloss IS NOT NULL`; spot-check (e.g. `peldaño` ≈ `step / rung`).
5. `pnpm dev` + Telegram: `/srs` → Show → Good → message edits in place, next card arrives. Exhaust queue → summary message.
6. Restart bot mid-session; tap a now-stale card → toast appears, no DB row.
7. `/srs` again → queue rebuilt correctly.
8. `/srs` while in `/practice` → soft-block reply, practice flow untouched.
9. `pnpm import-lookups` → no review state changes; new lookups appear `state='new'`.
10. `pnpm write-tomo --plan-only` → `--pick=1` → writer prompt's lookups block carries `[stalling]` / `[mastered]` tags where applicable.
11. Production migration before push (CLAUDE.md Main Branch Release Protocol).
