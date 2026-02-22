# Self-Healing Organism (Phase 5: Autonomous Quality Loop)

## Problem

Quality signals are logged but never acted on. The bot can't tell when its personality is drifting, stale, or overcorrecting. Soul evolution only happens when the user explicitly says things like "be more direct" — there's no feedback loop from the signals the user is already giving (reactions, felt-generic clicks, implicit corrections).

## Core Principle

The bot monitors its own quality signals, diagnoses behavioral drift, and autonomously adjusts its soul state — then logs every change transparently so the user can see what happened and why.

## Architecture

```
soul_quality_signals (existing)
        │
        ▼
  diagnoseQuality()          ← Pure function: stats → diagnosis
        │
        ▼
  proposeSoulRepairs()       ← Pure function: diagnosis + soul → repair actions
        │
        ▼
  applySoulRepairs()         ← Pure function: soul + repairs → new soul state
        │
        ├──▶ soul_state_history     (audit trail: before/after + reason)
        ├──▶ pulse_checks           (diagnosis log: what was detected)
        └──▶ chat_soul_state        (updated soul state)
```

## Diagnosis Model

Four health states based on quality signal ratios over a 30-day rolling window:

| Status | Condition | Meaning |
|--------|-----------|---------|
| `healthy` | personal_ratio >= 60% | Bot is resonating well |
| `drifting` | personal_ratio < 40% | Responses feel generic to the user |
| `stale` | total signals < 5 | Not enough feedback to assess |
| `overcorrecting` | correction_rate > 50% | Soul evolves too often — unstable personality |

`correction_rate` = corrections / total signals.

## Repair Actions

Based on diagnosis status, the system proposes zero or more atomic repairs:

| Diagnosis | Repair |
|-----------|--------|
| `drifting` | Add commitment "favor specifics over generic phrasing" (if missing). Add growth note explaining the drift. |
| `overcorrecting` | Add growth note advising stabilization. No new commitments. |
| `healthy` | No repairs. Log healthy pulse. |
| `stale` | No repairs. Log stale pulse. |

### Guardrails

- **Rate limit**: Max 1 pulse-triggered repair per 24 hours per chat.
- **Max changes**: At most 2 repair actions per pulse check.
- **Transparency**: Every repair adds a growth note starting with "pulse:" so the user can see it in `/soul`.
- **No charter violations**: Repairs never remove base commitments or override the core charter.
- **Idempotent**: Running pulse check twice with same stats produces same diagnosis.

## Soul-Aware Compaction

Current compaction extracts patterns without knowing the soul state. This phase injects soul context into the compaction prompt:

```
The user's relational commitments with this assistant:
- stay direct and avoid sugarcoating
- favor specifics over generic phrasing

Use these to guide pattern extraction. Prioritize explicit facts and events
over vague behavioral inferences.
```

This makes pattern extraction align with the personality the user has shaped.

## Schema Additions

### `pulse_checks` — Diagnosis log

```sql
CREATE TABLE IF NOT EXISTS pulse_checks (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    status TEXT NOT NULL,
    personal_ratio DOUBLE PRECISION NOT NULL,
    correction_rate DOUBLE PRECISION NOT NULL,
    signal_counts JSONB NOT NULL DEFAULT '{}',
    repairs_applied JSONB NOT NULL DEFAULT '[]',
    soul_version_before INT NOT NULL,
    soul_version_after INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT pulse_checks_status_check CHECK (
        status IN ('healthy', 'drifting', 'stale', 'overcorrecting')
    )
);
```

### `soul_state_history` — Audit trail

```sql
CREATE TABLE IF NOT EXISTS soul_state_history (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    version INT NOT NULL,
    identity_summary TEXT NOT NULL,
    relational_commitments TEXT[] NOT NULL DEFAULT '{}',
    tone_signature TEXT[] NOT NULL DEFAULT '{}',
    growth_notes TEXT[] NOT NULL DEFAULT '{}',
    change_reason TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Config

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEGRAM_PULSE_ENABLED` | `true` | Enable/disable self-healing pulse checks |
| `TELEGRAM_PULSE_INTERVAL_HOURS` | `24` | Minimum hours between pulse checks |

## Integration Points

1. **After compaction** in `agent.ts`: If pulse is enabled and interval has elapsed, run `pulseCheck()`.
2. **`/soul` command**: Show last pulse diagnosis (status + timestamp).
3. **Compaction prompt**: Inject soul commitments when present.

## Files

| File | Change |
|------|--------|
| `specs/schema.sql` | Add `pulse_checks` and `soul_state_history` tables |
| `src/config.ts` | Add `telegramPulseEnabled`, `telegramPulseIntervalHours` |
| `src/telegram/pulse.ts` | **New.** Pure diagnosis + repair functions |
| `src/db/queries.ts` | Add pulse check + soul history queries |
| `src/telegram/agent.ts` | Wire pulse into compaction; inject soul into extraction prompt |
| `src/telegram/webhook.ts` | Enhance `/soul` display |
| `tests/tools/telegram-pulse.test.ts` | **New.** Unit tests for diagnosis + repair logic |
| `tests/tools/telegram-agent.test.ts` | Add pulse integration tests |

## Success Criteria

- Pulse check correctly diagnoses `drifting` when personal_ratio < 40%.
- Repairs add targeted commitments/growth notes without touching base charter.
- Soul state history captures every pulse-triggered change.
- Compaction prompt includes soul commitments when available.
- All existing tests continue to pass.
- `pnpm check` passes.
