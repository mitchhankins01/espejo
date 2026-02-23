# Spanish Language Learning Infrastructure

## Context

The Telegram chatbot already tutors Spanish organically — correcting conjugation mistakes, weaving in B1-level Spanish, and teaching vocabulary through conversation. But it's all ephemeral. This adds structured infrastructure so the bot can:
- Look up correct conjugations from a reference database
- Track vocabulary the user learns (including regional slang like *maje*, *chamo*, *tío*)
- Schedule spaced repetition reviews woven into natural conversation
- Coach with "sassy ayahuasca side-kick" personality

Current level: B1. Known tenses: presente, presente progresivo, futuro próximo, pretérito perfecto, pretérito indefinido.

---

## Phase 1: Database + Verb Reference

### Migration 010 — 4 new tables

Add to `scripts/migrate.ts` as `010-spanish-learning`:

**`spanish_verbs`** — Reference data (~11k rows from Jehle database)
- `infinitive`, `infinitive_english`, `mood`, `tense`, `verb_english`
- `form_1s` through `form_3p` (yo/tú/él/nosotros/vosotros/ellos)
- `gerund`, `past_participle`, `is_irregular`
- Unique index on `(infinitive, mood, tense)`

**`spanish_vocabulary`** — Words being learned, with SRS state
- `word`, `translation`, `part_of_speech`, `region` (Honduras/Venezuela/Spain/etc.)
- `example_sentence`, `notes`, `source` (chat/manual)
- FSRS fields: `stability`, `difficulty`, `reps`, `lapses`, `state` (new/learning/review/relearning), `last_review`, `next_review`
- Unique index on `(word, COALESCE(region, ''))`

**`spanish_reviews`** — Audit trail per review event
- `vocabulary_id`, `grade` (1-4), stability/difficulty before+after, `interval_days`, `retrievability`, `review_context` (quiz/conversation/correction)

**`spanish_progress`** — Daily aggregate snapshots
- `date` (unique), `words_learned`, `words_in_progress`, `reviews_today`, `new_words_today`, `tenses_practiced`, `streak_days`

Also update `specs/schema.sql` with the new tables.

### Verb data import

- **Source**: [Fred Jehle Spanish Verb Database](https://github.com/ghidinelli/fred-jehle-spanish-verbs) — ~600 verbs, all moods/tenses, CC BY-NC-SA 3.0
- New script: `scripts/import-verbs.ts` — downloads CSV from GitHub, parses, bulk inserts with `ON CONFLICT DO UPDATE` (idempotent, same pattern as `sync-dayone.ts`)
- Derives `is_irregular` by comparing each form against computed regular -ar/-er/-ir patterns
- Add `pnpm import:verbs` to `package.json`
- No need to bundle the CSV — download on first run, cache locally in `data/`

### `conjugate_verb` tool

- **Spec** in `specs/tools.spec.ts`: params = `{ verb: string, tense?: string, mood?: string }`
- **Query** in `src/db/queries.ts`: `getVerbConjugations(pool, verb, tense?, mood?)`
- **Handler** in `src/tools/conjugate-verb.ts` (follows `log-weight.ts` pattern)
- **Formatter** in `src/formatters/conjugation.ts` — readable table with all persons
- **Register** in `src/server.ts`

---

## Phase 2: Vocabulary Tracking + SRS

### Use `ts-fsrs` package

Use the [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) npm package (FSRS v6, TypeScript-native, Node 18+) instead of writing our own. It handles all the scheduling math — we just store and pass the card state.

### `log_vocabulary` tool

- **Spec**: params = `{ word, translation, part_of_speech?, region?, example_sentence?, notes? }`
- **Query**: `upsertVocabulary(pool, params)` — `ON CONFLICT (word, COALESCE(region, '')) DO UPDATE`
- **Handler**: `src/tools/log-vocabulary.ts`
- Bot calls this automatically when a new word comes up in conversation

### `spanish_quiz` tool

- **Spec**: params = `{ action: "get_due" | "record_review" | "stats", vocabulary_id?, grade?, limit? }`
- **Queries**:
  - `getDueVocabulary(pool, limit)` — `WHERE state = 'new' OR next_review <= NOW()`, ordered by overdue-ness
  - `updateVocabularyFsrs(pool, id, fsrsState)` — updates card after `ts-fsrs` scheduling
  - `insertSpanishReview(pool, params)` — audit trail
  - `getVocabularyStats(pool)` — aggregates by state
- **Handler**: `src/tools/spanish-quiz.ts` — dispatches by `action`
- Bot uses this organically: retrieves due items, weaves them into conversation, records grades based on how the user responds

---

## Phase 3: Agent Integration

### System prompt updates (`src/telegram/agent.ts`)

In `buildSystemPrompt()`, update tool list and add Spanish tutoring guidelines:

```
You have access to 11 tools:
- 7 journal tools: search_entries, get_entry, get_entries_by_date, on_this_day, find_similar, list_tags, entry_stats
- log_weight: log daily weight measurements
- conjugate_verb: look up Spanish verb conjugations
- log_vocabulary: track Spanish vocabulary
- spanish_quiz: spaced repetition reviews and stats

Spanish tutoring:
- User is learning Spanish at B1. Known tenses: presente, presente progresivo, futuro próximo, pretérito perfecto, pretérito indefinido.
- When correcting a verb mistake, call conjugate_verb to show the correct form.
- When new vocabulary comes up, call log_vocabulary to track it. Do this silently — don't announce you're tracking.
- Periodically call spanish_quiz(action=get_due) to check for due reviews. Weave due items into conversation naturally — never run formal flashcard drills.
- When the user uses a tracked word correctly, call spanish_quiz(action=record_review, grade=3). When they struggle, grade=1.
```

### Soul state personality (`src/telegram/soul.ts`)

Add signal detection in `inferSoulSignals()` for the "sassy ayahuasca side-kick" coaching energy:
- Detect coaching/accountability requests → add commitment: "coach with sassy ayahuasca energy — mirror truths they need to hear"
- Detect Spanish engagement → add growth note about active Spanish practice

---

## Phase 4: Testing

### Unit tests (no DB)
- `tests/tools/conjugate-verb.test.ts` — mock queries, test param validation + formatting
- `tests/tools/log-vocabulary.test.ts` — mock upsert, test idempotency
- `tests/tools/spanish-quiz.test.ts` — mock queries, test action dispatch, FSRS card state transitions

### Integration tests (real PG)
- Add verb fixtures to `specs/fixtures/seed.ts` (5-10 verbs across a few tenses)
- Add vocabulary fixtures (items in various FSRS states: new, due, not-yet-due)
- Test conjugation queries with filters
- Test vocabulary upsert idempotency
- Test due vocabulary ordering
- Test review flow end-to-end (get_due → record_review → verify updated state)

---

## Files to create

| File | Purpose |
|------|---------|
| `scripts/import-verbs.ts` | Download + import Jehle CSV |
| `src/tools/conjugate-verb.ts` | Verb lookup handler |
| `src/tools/log-vocabulary.ts` | Vocabulary tracking handler |
| `src/tools/spanish-quiz.ts` | Quiz/review/stats handler |
| `src/formatters/conjugation.ts` | Verb table formatting |
| `src/formatters/vocabulary.ts` | Vocabulary + quiz formatting |
| `tests/tools/conjugate-verb.test.ts` | Unit tests |
| `tests/tools/log-vocabulary.test.ts` | Unit tests |
| `tests/tools/spanish-quiz.test.ts` | Unit tests |

## Files to modify

| File | Change |
|------|--------|
| `scripts/migrate.ts` | Add migration 010 (4 tables) |
| `specs/schema.sql` | Add 4 new tables |
| `specs/tools.spec.ts` | Add 3 tool specs |
| `src/server.ts` | Register 3 new handlers |
| `src/db/queries.ts` | Add ~8 query functions |
| `src/telegram/agent.ts` | System prompt + tool count |
| `src/telegram/soul.ts` | Spanish coaching signals |
| `specs/fixtures/seed.ts` | Verb + vocabulary fixtures |
| `tests/integration/queries.test.ts` | Integration tests |
| `package.json` | Add `import:verbs` script + `ts-fsrs` dep |
| `CLAUDE.md` | Update tool list + directory map |

---

## Verification

1. `pnpm check` passes (typecheck + lint + tests)
2. Run migration locally: `pnpm migrate` — verify 4 new tables exist
3. Import verbs: `pnpm import:verbs` — verify `spanish_verbs` has ~11k rows
4. Test via Telegram: "cómo se conjuga tener?" → bot calls `conjugate_verb`, returns conjugation table
5. Test vocabulary: say a new word in conversation → bot silently calls `log_vocabulary`
6. Test SRS: after logging vocabulary, `spanish_quiz(action=get_due)` returns the item
7. Run production migration before deploy: `NODE_ENV=production DATABASE_URL=<url> pnpm migrate`

---

## Resources

- [Fred Jehle Spanish Verb Database](https://github.com/ghidinelli/fred-jehle-spanish-verbs) — verb conjugation data (CSV/JSON)
- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) — TypeScript FSRS implementation
- [fjarri/spanish-verbs](https://github.com/fjarri/spanish-verbs) — compact verb data with fixes to Jehle errors (fallback if needed)
- [Anki SRS Kai](https://github.com/kuroahna/anki_srs_kai) — FSRS reference implementation in Rust
