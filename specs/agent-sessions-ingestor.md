# Agent Sessions Ingestor

> **Status: Planned** — manual-trigger ingest of Claude Code + OpenCode sessions into Postgres for usage analytics.

Captures sessions from Claude Code (`~/.claude/projects/...`), OpenCode (`~/.local/share/opencode/opencode.db`), and Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) into a single Postgres table. No analysis, no scheduling — just `pnpm ingest:sessions` on demand. Idempotent and incremental.

## Why

`usage_logs` covers four surfaces (mcp, http, telegram, cron). Three surfaces are dark today: CLI scripts, Claude Code sessions, OpenCode sessions. The dark surfaces are where most espejo "use" actually happens (vault prompts, dedup runs, evening reviews via Claude Code). Without ingest, "how often, what tools, what about" is invisible to SQL.

This spec covers the data layer only. Analysis ("what value does it provide", weekly digests, etc.) is out of scope and lives in a future review-agent spec.

## Scope

In:
- Claude Code session jsonls under `~/.claude/projects/{*espejo*,*Artifacts*}/`
- OpenCode sessions in `opencode.db` whose `project.worktree` or `session.directory` contains `espejo` or `Artifacts`
- Codex rollouts under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` whose `session_meta.payload.cwd` matches espejo/Artifacts
- One DB row per session, idempotent on re-run via `UNIQUE (surface, session_id)`
- Manual invocation: `pnpm ingest:sessions [--dry-run] [--since YYYY-MM-DD]` plus an AGENTS.md instruction telling agents to run with `--skip-if-fresh 24h` at session start

Out:
- Cron, timers, hooks, auto-trigger
- Review/synthesis/digest agents
- Full transcript copy (transcripts stay on disk; we store metadata + tool calls + prompts)
- Telegram, MCP, HTTP, cron sources (already in `usage_logs`)
- Non-espejo projects (greenline, oura-mcp, neuro-kb, etc.)

## Schema

New table. Adds to `specs/schema.sql`.

```sql
CREATE TABLE agent_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surface         text NOT NULL,                 -- 'claude-code' | 'opencode' | 'codex'
  session_id      text NOT NULL,                 -- surface's native session UUID
  project_path    text NOT NULL,                 -- decoded path the session was tied to
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  message_count   int NOT NULL DEFAULT 0,
  user_msg_count  int NOT NULL DEFAULT 0,        -- prompts only (no tool replies)
  tool_call_count int NOT NULL DEFAULT 0,
  tools_used      text[] NOT NULL DEFAULT '{}',  -- distinct tool names called
  tool_calls      jsonb NOT NULL DEFAULT '[]',   -- [{name, args, ok, ts, error?}]
  prompts         jsonb NOT NULL DEFAULT '[]',   -- [{ts, text}]  user messages only
  models          text[] NOT NULL DEFAULT '{}',  -- e.g. ['claude-opus-4-7']
  transcript_uri  text,                          -- absolute path to source jsonl/db
  source_mtime    timestamptz,                   -- mtime at ingest time, for staleness check
  ingested_at     timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (surface, session_id)
);

CREATE INDEX agent_sessions_started_at_idx ON agent_sessions (started_at DESC);
CREATE INDEX agent_sessions_project_idx    ON agent_sessions (project_path);
CREATE INDEX agent_sessions_tools_used_idx ON agent_sessions USING GIN (tools_used);
```

Sizing: ~10-50KB per session, ~300-500 sessions/year → <30MB/year. Negligible.

The `UNIQUE (surface, session_id)` is what makes ingest idempotent — `ON CONFLICT … DO UPDATE` refreshes the row when a session has grown since last ingest (e.g. a long-running session that was open during a prior ingest).

## Ingest sources

### Claude Code — `~/.claude/projects/<dir>/*.jsonl`

Project dirs encode the cwd path. Espejo-relevant dirs (per filesystem inspection 2026-04-26):

- `-Users-mitch-Projects-espejo` (current dev location, ~91 jsonls, 131MB)
- `-Users-mitch-Documents-Artifacts` (vault-root sessions — first-class per CLAUDE.md)
- `-Users-mitch-Desktop-espejo` (legacy March 2026 location, low-volume)

Filter rule: include any dir whose decoded path contains `espejo` OR `Artifacts`. Decoding: replace `-` with `/` after the leading `-Users-mitch-` prefix.

Each `.jsonl` file = one session. Filename UUID = `session_id`. Each line is a JSON object with at minimum `{type, sessionId, ...}`. Line types observed: assistant, user, tool_use, tool_result, system. Schema may evolve — script must tolerate unknown types.

Extract per session:
- `started_at` = timestamp of first line, fallback to file ctime
- `ended_at` = timestamp of last line, fallback to file mtime
- `message_count` = count of user + assistant messages
- `user_msg_count` = count of user messages
- `prompts` = `[{ts, text}]` for each user message (text content only, no embedded media)
- `tool_call_count` = count of tool_use blocks
- `tool_calls` = `[{name, args, ok, ts, error?}]` per tool_use, joining its tool_result. Args truncated to 500 chars; full args available in transcript.
- `tools_used` = distinct names from `tool_calls[].name`
- `models` = distinct model IDs across assistant messages
- `transcript_uri` = absolute path to the jsonl
- `source_mtime` = file mtime at read time

### Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

Each rollout file = one codex session. Filename includes the session UUID. Lines have shape `{timestamp, type, payload}`. The first line has `type=session_meta` with `payload.id` (session_id) and `payload.cwd` (the project the session ran in). Filter sessions where `cwd` matches espejo/Artifacts.

Subsequent lines:
- `type=response_item, payload.type=message` — user/assistant text. User messages have `role='user'` and `content[].type='input_text'`.
- `type=response_item, payload.type=function_call` — tool calls in OpenAI function-call style. `payload.arguments` is a JSON string of args; parse before truncation.
- `type=response_item, payload.type=function_call_output` — tool results. Match by `call_id` to set `ok` flag on the corresponding tool call.
- `type=turn_context` — has `model` for the current turn.

Skip lines whose `payload.cwd` (or session's `payload.cwd`) doesn't match espejo/Artifacts — codex sessions span all projects, only espejo ones go in the table.

### OpenCode — `~/.local/share/opencode/opencode.db`

SQLite, drizzle-managed. Tables (verified 2026-04-26): `session, session_entry, session_share, message, part, todo, event, event_sequence, account, account_state, control_account, permission, project, workspace, __drizzle_migrations`.

Canonical sources: `session` × `message` × `part`. Filter: join to `project` and keep where `project.path` contains `espejo` or `Artifacts`.

Extract per session: same fields as Claude Code, mapping OpenCode's schema:
- `session.id` → `session_id`
- `session.created_at`, `session.updated_at` → `started_at`, `ended_at`
- `project.path` → `project_path`
- `message` rows + `part` rows → `prompts`, `message_count`, `user_msg_count`
- tool_use parts → `tool_calls`, `tools_used`, `tool_call_count`
- `transcript_uri` = `${opencode.db}#session=${session_id}` (sentinel — sqlite has no per-session file)

Read sqlite via `better-sqlite3` (already in deps).

## Algorithm

```
1. Load watermark per surface from agent_sessions:
   last_claude_code = MAX(source_mtime) WHERE surface='claude-code'
   last_opencode    = MAX(source_mtime) WHERE surface='opencode'
   (--since flag overrides both)

2. Claude Code:
   FOR each jsonl in ~/.claude/projects/<espejo-or-artifacts-dir>/*.jsonl
       IF mtime <= last_claude_code AND not --force: skip
       Parse the file → session row
       UPSERT INTO agent_sessions ON CONFLICT (surface, session_id) DO UPDATE
         SET ended_at, message_count, ..., source_mtime, ingested_at = NOW()

3. OpenCode:
   Open opencode.db read-only
   SELECT sessions WHERE project.path LIKE '%espejo%' OR '%Artifacts%'
                    AND updated_at > last_opencode (or always if --force)
   FOR each session: build row, UPSERT same as above

4. Write a usage_logs row per ingest run:
   source='cli', action='ingest:sessions', meta={
     claude_code: {scanned, upserted, skipped},
     opencode:    {scanned, upserted, skipped},
     duration_ms
   }

5. Print summary to stdout.
```

## Robustness rules

- **Tolerate parse failures per file.** A single corrupt jsonl line shouldn't kill the run for that session, let alone other sessions. Log + continue.
- **Best-effort schema evolution.** Unknown line types are ignored, not fatal. Future Claude Code versions may add fields; the ingestor extracts what it knows.
- **No partial writes.** Each session upsert is one transaction. Either the whole row lands or none of it.
- **Read-only on sources.** Never mutate `~/.claude/` or `opencode.db`.
- **Dry run.** `--dry-run` prints intended UPSERTs without DB writes.
- **Force re-ingest.** `--force` ignores the watermark (re-process everything).
- **Empty sources.** If no Claude Code sessions match, that's fine — same for OpenCode. Don't fail.

## CLI

```bash
pnpm ingest:sessions                        # incremental, prod DB
pnpm ingest:sessions --dry-run              # preview
pnpm ingest:sessions --force                # re-ingest everything
pnpm ingest:sessions --since 2026-04-01     # explicit floor
pnpm ingest:sessions --surface claude-code  # one source only
pnpm ingest:sessions --skip-if-fresh 24h    # no-op if last successful run < 24h ago
```

The `--skip-if-fresh` flag makes the AGENTS.md hook (below) cheap when the user opens the project repeatedly.

## Auto-trigger via AGENTS.md

A short instruction near the top of `AGENTS.md` tells any agent (Claude Code, OpenCode, Codex) opening this directory to run the freshness check at session start. Implementation is just instructional text — agents read it and run the command. No hooks file to maintain.

Add to `package.json`:
```json
"ingest:sessions": "NODE_ENV=production tsx scripts/ingest-sessions.ts"
```

## File layout

```
scripts/ingest-sessions.ts          — entrypoint, arg parsing, orchestration
src/ingest/
  claude-code.ts                    — jsonl scanner + parser
  opencode.ts                       — sqlite reader
  types.ts                          — shared session row shape
src/db/queries/
  agent-sessions.ts                 — upsertSession, latestMtime, etc.
specs/schema.sql                    — append agent_sessions table
specs/migrations/2026-04-26_agent_sessions.sql  — additive migration
```

## Migration

Additive. Apply via `pnpm migrate:prod` per the existing migrations workflow.

```sql
CREATE TABLE IF NOT EXISTS agent_sessions ( … as above … );
CREATE INDEX IF NOT EXISTS … ;
```

No data backfill in the migration itself — first run of `pnpm ingest:sessions` does it (with `--force` if you want immediate full backfill).

## What this enables (queries that become possible)

```sql
-- "How many espejo sessions per day, by surface?"
SELECT date_trunc('day', started_at) AS d, surface, COUNT(*)
  FROM agent_sessions GROUP BY 1, 2 ORDER BY 1 DESC;

-- "Which tools fired in espejo sessions this week?"
SELECT unnest(tools_used) AS tool, COUNT(*)
  FROM agent_sessions WHERE started_at > NOW() - INTERVAL '7 days'
  GROUP BY 1 ORDER BY 2 DESC;

-- "Sessions where I worked on Spanish learning recently"
SELECT session_id, started_at, project_path, jsonb_array_length(prompts) AS n_prompts
  FROM agent_sessions
  WHERE prompts::text ILIKE '%spanish%' OR prompts::text ILIKE '%verbo%'
  ORDER BY started_at DESC LIMIT 20;

-- "What did the dedup council session look like?"
SELECT tool_calls FROM agent_sessions
  WHERE 'TaskCreate' = ANY(tools_used)
    AND started_at > '2026-04-26' ORDER BY started_at DESC LIMIT 1;

-- "Sessions that touched Artifacts/ vs sessions in src/ (use vs dev split)"
SELECT
  CASE WHEN tool_calls::text ILIKE '%Artifacts/%' THEN 'use'
       WHEN tool_calls::text ILIKE '%src/%' THEN 'dev'
       ELSE 'mixed' END AS class,
  COUNT(*)
FROM agent_sessions GROUP BY 1;
```

## Decisions on the open questions

1. **Tool args truncation: 8KB per call, with `truncated: true` flag.** Most tool calls are <1KB (file paths, queries). The few outliers are user-pasted documents — at 8KB those still get most of the content. If you ever need the literal full args, the transcript is at `transcript_uri`. Errors are kept short (500 chars).
2. **Skip the OpenCode `event` table.** Message+part already gives us tool_use entries at the granularity we need ("which tool, when, ok?"). The event log would add a per-keystroke-ish timeline that doesn't change any answer this table is built to give.
3. **Skip the `history.jsonl` fallback.** Crashed/incomplete jsonls are a rare edge case. The session row will reflect whatever made it to disk. If we ever discover a meaningful gap, we add it then.

## Out of scope (don't build now)

- Review/digest agents over `agent_sessions` — separate spec
- Embedding session prompts for semantic search — separate spec
- Auto-trigger on AGENTS.md read or any other hook — manual only
- Capture of MCP traffic outside Claude Code (already in `usage_logs`)
- Backfill of older project dirs (`-Users-mitch-Desktop-espejo`) is opt-in via `--force`
