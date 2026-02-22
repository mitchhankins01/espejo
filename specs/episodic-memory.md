# Episodic Memory: `fact` and `event` (Implemented)

## Status

Implemented and hardened.

- `fact` and `event` are first-class memory kinds in extraction + retrieval.
- Memory is persisted in PostgreSQL (`patterns` table) with embeddings.
- DB constraints and observability are now enforced via migration `004-memory-hardening`.
- Stale event memories are **notify-only** (no automatic prune/delete).

## What Was Added

### 1. Extraction + Retrieval

- Compaction extraction accepts `fact` and `event`.
- Retrieval scoring includes typed decay for episodic kinds:
  - `fact`: half-life `3650`, floor `0.85`
  - `event`: half-life `60`, floor `0.25`

### 2. DB Hardening (Migration 004)

- Added constraints:
  - `patterns_kind_check`
  - `patterns_status_check`
- Added provenance fields:
  - `patterns.source_type`, `patterns.source_id`
  - `pattern_observations.source_type`, `pattern_observations.source_id`
- Added event lifecycle field:
  - `patterns.expires_at`
- Added observability table:
  - `memory_retrieval_logs`

### 3. Runtime Memory Telemetry

- Agent logs retrieval telemetry on each turn:
  - query hash/text
  - degraded flag
  - retrieved pattern IDs/kinds
  - top score
- Bot activity line includes human-style usage info:
  - `used N memories (...)`

### 4. Stale Event Policy (Current)

- Expired active `event` memories are **not auto-pruned**.
- During compaction, bot sends a subtle memory note, e.g.:
  - `2 stale event memories pending review`
- This keeps control manual while behavior is tuned.

## Key Files

- `src/telegram/agent.ts`
- `src/db/queries.ts`
- `scripts/migrate.ts`
- `specs/schema.sql`
- `tests/tools/telegram-agent.test.ts`
- `tests/integration/queries.test.ts`

## Verification

1. Run migrations:

```bash
pnpm migrate
# production
pnpm migrate:prod
```

2. Run tests:

```bash
pnpm test -- tests/tools/telegram-agent.test.ts tests/tools/telegram-webhook.test.ts
pnpm test:integration -- tests/integration/queries.test.ts
```

3. Manual runtime check:

- Mention a personal fact/event in chat
- Trigger `/compact`
- Confirm Telegram memory note appears
- Confirm DB rows:

```sql
SELECT kind, content, source_type, source_id, expires_at
FROM patterns
WHERE kind IN ('fact', 'event')
ORDER BY created_at DESC
LIMIT 20;
```

- Confirm retrieval logs:

```sql
SELECT chat_id, query_hash, pattern_ids, pattern_kinds, top_score, created_at
FROM memory_retrieval_logs
ORDER BY created_at DESC
LIMIT 20;
```
