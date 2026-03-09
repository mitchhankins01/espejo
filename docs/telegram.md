# Telegram Chatbot

> Back to [AGENTS.md](../AGENTS.md)

A Telegram chatbot with pattern-based long-term memory and an evolving personality. Deployed to Railway, opt-in via `TELEGRAM_BOT_TOKEN`. Original design: `specs/telegram-chatbot-plan.md`.

**What it does:**
- Conversational interface powered by Anthropic or OpenAI (configurable provider)
- Uses MCP tools in the Telegram agent loop (journal retrieval + Spanish learning + Oura analytics + memory tools + todos)
- Spanish language tutor: conducts conversations primarily in Spanish, corrects conjugation mistakes, tracks vocabulary with FSRS spaced repetition, and adapts difficulty based on real review performance
- Redirects weight logging to the web Weight page (`/weight`) instead of MCP tool calls
- Accepts text, voice, photo, and document messages (with OCR/text extraction for media)
- Voice messages transcribed via OpenAI Whisper
- Optionally responds with Telegram voice notes using adaptive/fallback rules
- Stores long-term memory intentionally through `remember`/`save_chat`; compaction is summary + trim only
- Logs activity per agent run (memories retrieved, tool calls with full results) in `activity_logs` table

**Commands:**
- `/evening` — Evening review mode: guided journaling session with somatic check-ins, system assessments (escalera, boundaries, attachment), and Spanish-primary conversation
- `/morning` — Morning flow mode: free-flow morning journal session
- `/compact` — Force conversation compaction summary (memory note)
- `/digest` — Spanish learning summary: vocabulary stats, retention rates, grade/lapse trends, adaptive status tier, latest assessment
- `/assess` — Trigger LLM-as-judge evaluation of recent Spanish conversation quality (complexity, grammar, vocabulary, code-switching ratio)

## Pattern Memory

- 3 pattern kinds with typed decay scoring: `identity`, `preference`, `goal`
- Compaction trigger: size-based (12k token budget) for context management
- Memory creation path: `remember` and `save_chat` tools (dedup by canonical hash + ANN similarity)
- Retrieval: hybrid semantic + text search with RRF merge and score floors
- Maintenance: consolidation, stale review, and active cap enforcement
- DB tables: `chat_messages`, `patterns`, `pattern_observations`, `pattern_relations`, `pattern_aliases`, `pattern_entries`, `api_usage`, `memory_retrieval_logs`
- Provenance fields: `patterns.source_type/source_id`, `pattern_observations.source_type/source_id`

Memory v2 supersedes the earlier v1 `fact`/`event` taxonomy in active retrieval and storage. See `specs/memory-v2.md`.

## Soul Personality System

One evolving personality that grows through interaction. Design: `specs/telegram-personality-plan.md` (updated in memory-v2 to global state).

- `soul_state` singleton table: identity summary, relational commitments, tone signature, growth notes, version counter
- Soul state evolves in the main agent loop with guardrails; pulse checks can apply additional repairs
- `soul_state_history` table: audit trail of every soul mutation with reason
- Soul prompt section injected into system prompt on every turn

## Self-Healing Quality Loop

Autonomous quality monitoring and personality drift correction. Design: `specs/self-healing-organism.md`.

- `soul_quality_signals` table: tracks user reactions (felt_personal, felt_generic, correction, positive_reaction)
- `pulse_checks` table: periodic diagnosis of personality health (healthy, drifting, stale, overcorrecting)
- `diagnoseQuality()` → `applySoulRepairs()` pipeline: pure functions that analyze signals and adjust soul state
- `cost_notifications` table: 12-hour spend summary tracking

## Activity Logs

Per-agent-run observability. Each time the bot processes a message, it logs:
- Memories retrieved (patterns injected into context)
- Tool calls with full input/output results
- Cost of the run

DB table: `activity_logs` with `chat_id`, `memories` (JSONB), `tool_calls` (JSONB), `cost_usd`.

HTTP endpoints for inspection:
- `GET /api/activity` — Recent activity logs (`limit`, `since`, `tool`)
- `GET /api/activity/:id` — Single activity log by ID

## Spanish Learning Infrastructure

Full design: `specs/spanish-learning.md`.

**3 MCP tools:**
- `conjugate_verb` — Look up Spanish verb conjugations by infinitive, optionally filtered by mood/tense. Data from Fred Jehle database (~11k rows).
- `log_vocabulary` — Track a vocabulary word per chat with translation, part of speech, regional context, SRS state. Upserts by `(chat_id, word, region)`.
- `spanish_quiz` — Spaced-repetition flow: `get_due` (fetch due/new cards), `record_review` (FSRS grade 1-4), `stats` (progress summary).

**DB tables:**
- `spanish_verbs` — Reference conjugation data (~11k rows, imported via `pnpm import:verbs`)
- `spanish_vocabulary` — Per-chat vocabulary with FSRS state (stability, difficulty, reps, lapses, next_review)
- `spanish_reviews` — Audit trail of every review event with before/after SRS state
- `spanish_progress` — Daily learning snapshots per chat (words learned, reviews, streak)
- `spanish_profiles` — Per-chat learner profile (CEFR level, known tenses, focus topics)

**Agent integration:**
- Agent retrieves learner profile, recent vocabulary, and due cards to build Spanish coaching context
- Adaptive difficulty: queries `getSpanishAdaptiveContext()` for retention stats and lapse rate, adjusts guidance (consolidation vs advancement)
- Language direction: Spanish-primary with English/Dutch woven in for warmth and clarification
- Vocabulary logged automatically during conversations when new words are introduced

**Import verbs:**
```bash
pnpm import:verbs   # Downloads CSV from GitHub, bulk inserts into spanish_verbs
```

### Spanish Learning Observability

Three-tier system for evaluating Spanish tutor effectiveness. Interface-agnostic: analytics layer in `src/spanish/` consumed by both Telegram commands and HTTP endpoints.

**Tier 1 — Retention & Effectiveness Queries** (in `queries.ts`):
- `getRetentionByInterval` — Retention rate bucketed by SRS interval (0-1d, 1-3d, 3-7d, 7-14d, 14-30d, 30d+)
- `getVocabularyFunnel` — Word counts by SRS state (new → learning → review → relearning) with median days
- `getGradeTrend` — Daily average grade over configurable window
- `getLapseRateTrend` — Daily lapse rate (grade ≤ 2) over configurable window
- `getProgressTimeSeries` — Historical `spanish_progress` snapshots
- `getRetentionByContext` — Retention grouped by `review_context` (quiz vs conversation)

**Tier 2 — Digest & Endpoints**:
- `src/spanish/analytics.ts` — Pure functions: `buildRetentionSummary`, `buildFunnelSummary`, `buildTrendSummary`, `buildAssessmentSummary`, `formatDigestText`, `formatProgressTimeSeries`
- `/digest` Telegram command — Sends formatted HTML summary of all analytics
- `GET /api/spanish/:chatId/dashboard` — JSON dashboard aggregating all analytics data
- `GET /api/spanish/:chatId/assessments` — Assessment history (both require bearer token auth)

**Tier 3 — LLM-as-Judge Assessment** (`src/spanish/assessment.ts`):
- Samples up to 20 recent user messages from `chat_messages`
- Sends to gpt-4o-mini for structured evaluation: complexity (1-5), grammar (1-5), vocabulary (1-5), code-switching ratio (0-1), overall (1-5), rationale
- Stores results in `spanish_assessments` table
- `AssessmentLlmClient` interface for dependency injection (testable without API calls)
- `/assess` Telegram command triggers evaluation and sends formatted result

**DB table**: `spanish_assessments` — stores LLM assessment results with scores, sample count, rationale, timestamp. Indexed on `(chat_id, assessed_at DESC)`.

## Oura Ring Integration

Hourly sync from Oura API v2 into PostgreSQL, giving the Telegram agent access to biometrics. Design: `specs/oura-integration-plan.md`.

**6 MCP tools:**
- `get_oura_summary` — Single-day health snapshot: sleep score/duration/stages, readiness, activity/steps, stress, HRV, workouts. Defaults to today.
- `get_oura_weekly` — 7-day overview: daily scores, averages, best/worst days, total steps/workouts.
- `get_oura_trends` — N-day trend analysis: rolling averages (7/14/30-day), trend direction, day-of-week patterns. Optional metric filter.
- `get_oura_analysis` — Multi-type analysis: `sleep_quality` (debt, regularity, stage ratios), `anomalies` (IQR + Z-score outliers), `hrv_trend` (rolling averages, recovery patterns), `temperature` (deviation trends, flagged days), `best_sleep` (activity/workout/day-of-week correlations).
- `oura_compare_periods` — Side-by-side metrics between two date ranges with % changes.
- `oura_correlate` — Pearson correlation between any two metrics (r, p-value, strength).

**DB tables (8):**
- `oura_sync_state` — Last sync date per endpoint
- `oura_sync_runs` — Audit trail: start/end time, records synced, errors
- `oura_daily_sleep` — Scores + contributors JSONB + raw_json
- `oura_sleep_sessions` — Per-session: stages, HR, HRV, efficiency
- `oura_daily_readiness` — Recovery score, temperature deviation
- `oura_daily_activity` — Steps, calories, intensity breakdown
- `oura_daily_stress` — Stress/recovery seconds, day summary
- `oura_workouts` — Activity type, duration, HR, distance
- `daily_health_snapshot` — SQL view joining all domains for cross-metric queries

**Sync mechanism:**
- In-process `setInterval` in HTTP server, starts when `OURA_ACCESS_TOKEN` is set
- PG advisory lock prevents overlapping runs
- Initial run: 30-day backfill. Hourly runs: 3-day rolling lookback
- 6 endpoints fetched in parallel, all upserts idempotent (`ON CONFLICT DO UPDATE`)
- Manual backfill: `pnpm sync:oura [--days 90]`

**Context injection:**
- `buildOuraContextPrompt()` auto-injects today's biometrics into the Telegram agent system prompt
- Includes sleep score/duration/stages/efficiency, readiness, activity, HRV, steps, stress, bedtime/waketime

**Config:**
```
OURA_ACCESS_TOKEN          — Personal access token from cloud.ouraring.com
OURA_SYNC_INTERVAL_MINUTES — default 60
OURA_SYNC_LOOKBACK_DAYS    — default 3
```

## Insight Engine

Background worker that surfaces non-obvious connections across data and delivers them as Telegram notifications. Runs daily on a timer (like Oura sync), uses advisory lock to prevent concurrent runs. Design: `specs/insight-engine.md`.

**3 insight types:**
- `temporal_echo` — Semantically similar entries from the same calendar date (MM-DD) in previous years. Cosine similarity threshold 0.75.
- `biometric_correlation` — When Oura data shows anomalies (low sleep, low readiness, low HRV, short sleep duration), surfaces nearby journal entries for context.
- `stale_todo` — Active todos not updated in 7+ days, ordered by importance. Resurfaces weekly via week-bracket dedup hash.

**DB table:** `insights` — stores generated insights with type, content_hash (dedup), title, body, relevance score, JSONB metadata, notified_at timestamp.

**Dedup:** SHA-256 content hash checked against configurable window (default 30 days). Daily notification cap (default 3).

**Config:**
```
INSIGHT_ENGINE_INTERVAL_HOURS    — default 24
INSIGHT_ENGINE_MAX_PER_DAY       — default 3
INSIGHT_ENGINE_DEDUP_WINDOW_DAYS — default 30
```
