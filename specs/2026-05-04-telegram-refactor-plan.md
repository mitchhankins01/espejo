---
status: implemented
author: Mitch + Claude
date: 2026-05-04
---

# Telegram bot refactor — flow-based, prompt-driven, DB-backed checkpoints

## Problem

Every Telegram message → universal `runAgent` with full tool catalog + last 50 messages of scrollback (`agent/constants.ts:45`) → LLM decides what to do. This causes:

- **Fabrication**: LLM pattern-matches on prior similar examples in scrollback (e.g. re-logs yesterday's last toll into today). Three patches landed in `src/tools/log-checkpoint.ts` over 24h fighting symptoms (10-min same-tuple dedup, cross-day Jaccard, same-day Jaccard). All reactive.
- **Wasted context**: Most user messages are tool-routing ("Pass", an HN URL, a substance pull) or one-shot statements. They don't need 50 turns of LLM history. Cost + latency + fabrication pressure stem from the same root.
- **System prompt bloat**: `agent/context.ts` instructs the LLM about checkpoint protocol, HN URLs, journal composition, weight detection — all deterministic, none should require a model.
- **Latency**: only `/practice` streams replies. Every other reply waits for the full non-streaming response.
- **Bespoke LLM plumbing**: `agent/tools.ts` is 550 LOC of hand-rolled tool-loop bookkeeping for both Anthropic and OpenAI, when Vercel AI SDK does the same job in ~30 LOC and adds cross-provider streaming + prompt caching for free.
- **Dead memory plumbing**: `agent.ts:100` always writes `memories: []`. `src/tools/{remember,recall,save-chat,reflect}.ts` don't exist despite `specs/memory-v2.md` claiming "All phases shipped." Specs lie.
- **UX gaps the data already showed**: 6 attempts at `/evening` `/morning` `/assess` over 90 days — all hit nothing. Mitch has been bumping into a missing surface for months.

## What 90 days of usage actually shows

```
Telegram tool calls (90d)            Slash attempts (90d)
  distill_hn_thread:  76                /practice:  5
  log_checkpoint:     31                /compact:   3   (slated for delete)
  ingest (screen):     8                /end:       3   (practice exit)
  log_weights:         3                /evening:   3   ← no handler
  search_content:      0                /morning:   1   ← no handler, no prompt
  get_oura_summary:    0                /assess:    1   ← no handler
                                        /done /fin /cancel: 3
```

Bot is a **tool router**, not a chatbot. 64% of tool traffic is HN distills; 26% is checkpoints. `search_content` and `get_oura_summary` are zero today *but* expected to grow as Mitch shifts Claude-mobile usage to the bot for model swappability + logging + control. Chat-flow's catalog is forward-looking, not historical-fit. Weight CSVs (RENPHO format, M/D/YY,HH:MM:SS,kg,…) are sent occasionally and don't show up in tool-dispatch counts because they're parsed locally.

## Existing patterns to build on, not reinvent

- **`practice-session.ts`** — exact prototype of the flow pattern: `Map<chatId, Session>` in memory, `is*Active(chatId)` check, dedicated handler with streaming via `onTextDelta`. Generalize.
- **`screen-time.ts` + `webhook.ts:270-281`** — exact prototype of the deterministic-pre-router pattern. Photo arrives, vision classifier runs, short-circuits before agent. CSV pre-router and HN-URL flow follow this shape.
- **`insertChatMessage`** persists every user/assistant/tool_result row independently of compaction. Compaction does nothing for DB durability — only LLM-context trimming. Hard 12-message cap on chat flow obviates compaction entirely.
- **Vercel AI SDK** (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`) does cross-provider streaming + tool-loop + prompt caching natively. Replaces `agent/tools.ts`.

## Target shape

```
src/
  llm/                  new — codebase-wide cross-provider abstraction
    chat.ts             chat({provider, model, system, messages, tools, onTextDelta, cacheSystem})
    embed.ts            embed({text}) — OpenAI text-embedding-3-small
    transcribe.ts       Whisper wrapper
    vision.ts           image-in / text-out (provider-agnostic)
    tts.ts              OpenAI TTS (single provider)
    index.ts            re-export

  telegram/
    webhook.ts          entry; secret/auth + dispatch only
    router.ts           new — tiered routing (media → extraction → text → flow → handler)
    flow-state.ts       new — typed Map<chatId, FlowState>
    flows/
      checkpoint.ts     3-step state machine; deterministic parsers + 1 mirror call
      distill-hn.ts     solo HN URL → existing tool
      chat.ts           default fallback; sonnet; 12-msg cap; full read tools + write_vault_artifact
      vault-prompt.ts   generic runner: load prompt body → system + full tool catalog
      practice.ts       existing; cosmetically moved
      weight-csv.ts     deterministic CSV parser → batch log_weights
      weight-slash.ts   /weight <val> [date]
    client.ts           unchanged (incl. createStreamEditor)
    voice.ts            transcription only — synthesis path deleted
    media.ts            unchanged
    screen-time.ts      unchanged (already pre-router)
```

The Telegram refactor consumes `src/llm/` rather than building a provider abstraction locally. Scripts (`condense-insights`, `write-tomo`, `dedup/*`) migrate to `src/llm/` over time as a follow-on task.

## Routing — tiered

Three tiers, top to bottom, first match wins:

```
─── TIER 1 — Media classifiers (deterministic, pre-extraction) ──────
1. Photo classified as iOS Screen Time → screen-time handler, return.
2. Document with text/csv mime + recognizable scale-CSV header (RENPHO etc.)
   → weight-csv handler, return.

─── TIER 2 — Media extraction (transcribe / OCR / parse) ────────────
3. Voice → Whisper → text.
4. Photo (not screen-time) → vision OCR → text.
5. Document (not CSV) → text/PDF extraction → text.

─── TIER 3 — Text routing (operates on the resulting text) ──────────
6. Registered slash command:
     /checkpoint [args]  → start checkpoint flow (skip turns if pre-formed)
     /practice           → start practice flow
     /hilo | /evening    → start vault-prompt flow
     /weight <val> [date]→ /weight handler (deterministic)
     /end /done /fin     → close active flow if any; else "no active flow"
7. Unknown slash:
     - vault-prompt active  → forward to LLM as user msg (handles /pivot /deeper /en /es)
     - else                 → "unknown command — try /checkpoint /practice /hilo /evening /weight"
8. Active checkpoint flow → advance state machine.
9. Active practice flow   → existing handler.
10. Active vault-prompt flow → forward to LLM with full conversation history.
11. Solo HN URL → distill-hn handler.
12. → Chat handler (default LLM with read tools + write_vault_artifact).
```

Tier 1 short-circuits everything. Mid-`/hilo` CSVs get logged and Hilo stays open in the background — same behavior screen-time photos already have.

## Cross-provider LLM via Vercel AI SDK

`src/llm/chat.ts` wraps `streamText` from `ai`:

```ts
import {
  streamText,
  stepCountIs,
  type CoreMessage,
  type Tool,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

const providers = {
  anthropic: (id: string) => anthropic(id),
  openai:    (id: string) => openai(id),
};

export interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}
export interface ToolResultEvent extends ToolCallEvent {
  result: unknown;
}

export interface ChatRequest {
  provider: keyof typeof providers;
  model: string;
  system?: string;
  messages: CoreMessage[];
  tools?: Record<string, Tool>;
  cacheSystem?: boolean;             // Anthropic ephemeral cache marker
  maxTokens?: number;
  maxSteps?: number;                 // tool-loop cap; default 15
  onTextDelta?: (snapshot: string) => void;
  onToolCall?: (e: ToolCallEvent) => void | Promise<void>;
  onToolResult?: (e: ToolResultEvent) => void | Promise<void>;
}

export async function chat(req: ChatRequest) {
  const result = streamText({
    model: providers[req.provider](req.model),
    system: req.system,
    messages: req.messages,
    tools: req.tools,
    maxTokens: req.maxTokens ?? 2048,
    // Critical: SDK default is stepCountIs(1). With a tool catalog that
    // means: emit one tool_use, never see the result, return. Every flow
    // that uses tools must raise this.
    stopWhen: stepCountIs(req.maxSteps ?? 15),
    providerOptions: req.cacheSystem
      ? { anthropic: { cacheControl: { type: "ephemeral" } } }
      : undefined,
    onStepFinish: async ({ toolCalls, toolResults }) => {
      for (const c of toolCalls) {
        await req.onToolCall?.({
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          args: c.args,
        });
      }
      for (const r of toolResults) {
        await req.onToolResult?.({
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          args: r.args,
          result: r.result,
        });
      }
    },
  });

  let snapshot = "";
  for await (const delta of result.textStream) {
    snapshot += delta;
    req.onTextDelta?.(snapshot);
  }

  return {
    text: await result.text,
    toolCalls: await result.toolCalls,
    toolResults: await result.toolResults,
    usage: await result.usage,
    finishReason: await result.finishReason,
  };
}
```

What the SDK handles: cross-provider tool loop (with `stopWhen` set), text streaming, prompt-cache markers, multi-turn message accumulation.

What `chat()` does **not** handle — flows wire it themselves via callbacks:
- Persisting `tool_use` + `tool_result` rows into `chat_messages` (today: `agent/tools.ts:316-324`).
- Per-tool `usage_logs` entries (today: `agent/tools.ts:116-138`).
- Building the `activity_logs` row from accumulated tool-call records (today: `agent.ts:94-104`).
- Truncating the stored result body — `truncateToolResult` from `agent/truncation.ts` is preserved and called inside `onToolResult`.

Each tool-using flow shares roughly the same shape:

```ts
const toolCallRecords: ActivityLogToolCall[] = [];
const startedAt = Date.now();
await chat({
  provider: "anthropic",
  model: config.anthropic.model,
  system, messages, tools,
  cacheSystem: true,
  onTextDelta: editor.update,
  onToolResult: async ({ toolCallId, toolName, args, result }) => {
    const text = asText(result);
    const truncated = truncateToolResult(toolName, text);
    await insertChatMessage(pool, {
      chatId, externalMessageId: null,
      role: "tool_result", content: truncated, toolCallId,
      flow,                                         // 'chat' | 'vault-prompt' | ...
    });
    toolCallRecords.push({ name: toolName, args, result: text, truncated_result: truncated });
    await logUsage(pool, {
      source: "telegram", surface: "flow", action: toolName,
      actor: chatId, args, ok: true,
      durationMs: Date.now() - startedAt,
    });
  },
});
await insertActivityLog(pool, { chatId, memories: [], toolCalls: toolCallRecords, costUsd: null });
```

Lift the boilerplate into a `runFlowWithTools(...)` helper in `src/telegram/flows/` once two flows share it; don't pre-extract.

This replaces `agent/tools.ts` (550 LOC). Net code is closer to **chat() (~80 LOC) + per-flow callback boilerplate (~50 LOC each)** than the optimistic "30 LOC" framing — the win is real (cross-provider, prompt caching, no hand-rolled tool-loop bookkeeping, working `stopWhen`) but the LOC reduction is more like 550 → 250 across all flows combined.

`src/llm/embed.ts`:

```ts
import { embed } from "ai";
import { openai } from "@ai-sdk/openai";

export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: text,
  });
  return embedding;
}
```

`transcribe.ts`, `vision.ts`, `tts.ts` similarly thin.

Tool definitions reuse `specs/tools.spec.ts` Zod schemas via the SDK's `tool({ parameters: zodSchema, execute: handler })` adapter. No duplicate definition surface.

## Schema — `checkpoints` table (new, replaces R2 vault writes)

Single table; extensible to future check-in kinds (parts, energy, decision, gratitude) without migration.

```sql
CREATE TABLE IF NOT EXISTS checkpoints (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,                   -- 'substance' (now); future: 'parts','energy', etc.
  trigger      TEXT NOT NULL,                   -- substance label OR situation OR emotion
  body_signal  TEXT,                            -- "where in the body" — common across kinds
  part_voice   TEXT,                            -- "what does it want" — common across kinds
  resolution   TEXT,                            -- 'pass'|'go'|'unset' for substance; freeform otherwise
  payload      JSONB NOT NULL DEFAULT '{}',     -- kind-specific extras + parser_fallback flag
  source       TEXT NOT NULL DEFAULT 'telegram',
  chat_id      TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  local_date   DATE NOT NULL,                   -- denormalized in config.timezone for index
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX checkpoints_local_date_idx       ON checkpoints (local_date DESC);
CREATE INDEX checkpoints_kind_local_date_idx  ON checkpoints (kind, local_date DESC);

-- Idempotent backfill + 10-min duplicate guard:
CREATE UNIQUE INDEX checkpoints_dedup_idx ON checkpoints (
  kind, trigger,
  COALESCE(body_signal,''),
  COALESCE(part_voice,''),
  occurred_at
);
```

`local_hhmm` is dropped — format at read time with `to_char(occurred_at AT TIME ZONE $tz, 'HH24:MI')`. `payload->>'parser_fallback'` is set to `'true'` when the deterministic split fails and the whole reply was used as `trigger`; query later to spot parser issues.

The migration is a new entry in the `migrations` array in `scripts/migrate.ts` (no loose `.sql` files in this repo — schemas are inline strings).

### Backfill (one-time)

`scripts/backfill-checkpoints.ts`:
1. List `Artifacts/Checkpoint/*.md` from R2.
2. Parse bullets via existing `parseBullet` (`src/tools/log-checkpoint.ts:83`).
3. Insert with `kind='substance'`, `source='vault-backfill'`, `occurred_at` reconstructed from filename date + bullet HH:MM.
4. Default `--dry-run` mode logs what would be inserted; `--apply` mutates.
5. Idempotent via `INSERT ... ON CONFLICT DO NOTHING` against `checkpoints_dedup_idx`.

Vault `.md` files stay in place as historical artifact (read-only). All new writes go to DB only.

## chat_messages — add `flow` column + move user-message persistence into flows

```sql
ALTER TABLE chat_messages ADD COLUMN flow TEXT;
CREATE INDEX chat_messages_flow_chat_id_idx ON chat_messages (chat_id, flow, created_at DESC);
```

`insertChatMessage` (`src/db/queries/chat.ts:17`) gains a `flow?: string` param. Flow handlers tag every row they write — user, assistant, tool_result — with the same flow name (`'chat' | 'checkpoint' | 'vault-prompt' | 'practice'`). Chat flow's context query filters `WHERE flow IS NULL OR flow = 'chat'` (NULL covers historical rows pre-migration).

**Persistence ordering changes — Phase 2 has to invert today's order.** `webhook.ts:326-333` currently inserts the user `chat_messages` row *before* `parseSlashCommand` at line 337. If we add the column without changing this, every user turn lands as `flow=NULL` regardless of where it actually gets routed, and the column is meaningless for filtering. The router must resolve which flow owns the turn first; the flow handler then performs the insert.

Concretely:
- `webhook.ts` no longer calls `insertChatMessage` for user messages. It reassembles the message and hands it to `router.ts`.
- The router resolves the flow tag (or returns "Tier-1 short-circuited, nothing to persist").
- The flow handler is responsible for: inserting the user row with `flow=<name>`, inserting the assistant reply with `flow=<name>`, and inserting any `tool_result` rows from `chat()`'s `onToolResult` callback with the same `flow`.
- Tier-1 short-circuit handlers (screen-time, CSV pre-router) do **not** insert into `chat_messages`. Their data goes to dedicated tables (`daily_screen_time`, `daily_metrics`). This matches today's screen-time behavior.
- The `ON CONFLICT (external_message_id) DO NOTHING RETURNING id` retry guard stays inside `insertChatMessage`. Flow handlers check `inserted === false` and return early on duplicate (webhook retry after restart).

Edge case — flow transitions mid-turn (e.g. `/end` while a vault-prompt is active): the slash text is owned by the flow that the *router* picks for it. `/end` in tier 6 closes the active flow before any new flow opens, so its row is tagged with the closing flow's name (`'vault-prompt'` for the goodbye, then state cleared). Subsequent messages route fresh.

## New MCP tool — `write_vault_artifact`

Closes the only gap keeping Telegram from full Claude-mobile parity on vault-prompt sessions. Used by chat flow, vault-prompt flow, and any MCP client (Claude Desktop included).

```ts
write_vault_artifact: {
  description:
    "Write a markdown file to the Obsidian vault. The handler writes to Cloudflare " +
    "R2 (Remotely Save replicates to Obsidian) AND immediately upserts the artifact " +
    "into knowledge_artifacts so same-session reads see it. Use for saving insights " +
    "to Pending/, reviews to Review/, notes to Note/, etc. Path is relative to vault root.",
  input: {
    path: z.string()
      .regex(/^(Pending|Insight|Review|Note|Project|Reference)\/[^./][^/]*\.md$/),
    content: z.string(),               // frontmatter required (validated below)
    overwrite: z.boolean().default(false),
  }
}
```

**Dual write — R2 *and* DB.** The handler does both, in this order:
1. `putObjectContent(r2, "artifacts", path, content)` — R2 is the durable source of truth that Remotely Save propagates to Obsidian.
2. `upsertObsidianArtifact(pool, { sourcePath, title, body, kind, contentHash })` — synchronous DB upsert via the same query the timer-driven sync uses.

Without step 2 the parity claim collapses: `/hilo` Phase 4 writes a Pending insight to R2, the same session calls `search_content` for context, and the artifact isn't in DB yet (sync timer is ~30 min). Practice extraction already does exactly this pattern — see `src/telegram/practice-session.ts:114-138` — lift it.

`title` and `kind` come from parsing the frontmatter via `src/obsidian/parser.ts` (existing). The parser runs before either write; if frontmatter is missing or malformed the call rejects with no R2 or DB mutation.

Failure handling:
- R2 write fails → return error, DB untouched.
- R2 succeeds, DB upsert fails → log the DB error, return success. The next obsidian-sync timer tick reconciles. Same posture as practice extraction (`practice-session.ts:135-138`).

Safety baked in:
- Path must start with a whitelisted kind folder; no nested subdirs; no path traversal; no hidden files.
- Frontmatter required — validate `---\nkind:` is present in first 200 chars; reject otherwise.
- `overwrite: false` default. Prompts that intentionally overwrite (e.g. updating `Project/Español Vivo.md`) pass `true`. Existence check via `headObject` against R2 before write.
- `usage_logs` records every write (success and failure paths).

Implementation: ~150 LOC in `src/tools/write-vault-artifact.ts` + spec in `tools.spec.ts` + register in `server.ts`.

## Flow specs

### Checkpoint flow (`flows/checkpoint.ts`)

3 turns. FlowState only — no scrollback access. Deterministic parsers everywhere; 1 LLM call (mirror line) at exit.

```ts
type CheckpointFlow = {
  flow: "checkpoint";
  step: "awaiting_pull" | "awaiting_voice" | "awaiting_choice";
  data: {
    trigger?: string;
    body_signal?: string;
    part_voice?: string;
    resolution?: "pass" | "go" | "unset";
    parser_fallback?: boolean;
  };
  startedAt: number;
};
```

| step | bot says | user replies | flow does |
|---|---|---|---|
| `/checkpoint` | "Toll. What's pulling — and where in the body?" | "Nicotine. Cold pulse behind sternum" | `split('. ', 2)` → `{trigger, body_signal}`. Fallback on split failure: `trigger = wholeReply`, `parser_fallback = true`, ask for body next. |
| awaiting_voice | "One long inhale. Now the slowest exhale.\n\nWhat does it want?" | "Just keep moving" | store `part_voice` verbatim |
| awaiting_choice | "Pass or go?" | "pass" / "passed" / "go" / "sí pasé" | regex normalizer: `/^(pass(ed)?\|paso\|sí pasé)$/i → 'pass'`, `/^(go\|went\|fui\|sí fui)$/i → 'go'`, else `'unset'` |
| (exit) | (haiku mirror line)\n"Logged at HH:MM." | — | insert checkpoint row; clear FlowState |

The mirror line is the single LLM call (`claude-haiku-4-5-20251001`, max_tokens 256). Prompt: *"Reflect Mitch's part in one sentence, in the part's own voice. No preface, no commentary. One sentence."* Behind a feature flag in `flows/checkpoint.ts` so it can be dropped without a refactor.

**Pre-formed shortcut** — comma-segmented args:
- `/checkpoint a, b, c, d` (≥4 segments) → skip all turns, log immediately.
- `/checkpoint a, b` (<4 segments) → start turn 1 with whatever's parsed pre-filled, ask for the missing field.

**Restart recovery**: in-memory state lost on Railway restart (~2x/month). Orphan reply ("pass") routes to chat flow. Chat flow's `getRecentMessages` filters `WHERE flow IS NULL`, so it sees no checkpoint context. Its system prompt instructs *"if you don't have context for what he's referencing, ask one short clarifying question; don't manufacture context."* Natural reply: *"What are you passing on?"* — clean recovery, no detector needed.

**MCP-side defense**: `log_checkpoint` MCP tool (callable from Claude Desktop) keeps a 10-min DB tuple check — `SELECT 1 FROM checkpoints WHERE kind=$1 AND trigger=$2 AND body_signal=$3 AND part_voice=$4 AND occurred_at > NOW() - INTERVAL '10 minutes'` — as cheap insurance against MCP-LLM re-runs. Drop both Jaccard guards; their cause is gone.

### Chat flow (`flows/chat.ts`)

- Provider/model: Anthropic `claude-sonnet-4-6` via `chat()` from `src/llm/`.
- Context: last **12** messages from `chat_messages WHERE flow IS NULL`.
- System prompt (~12 lines, condensed):

```
Mitch's chatbot. Spanish replies, B1 max — translate hard words inline.
If Mitch writes in Spanish, slip in corrective feedback inline.

Tone: Dutch directness + sassy gay edge + calm masculine presence + safe
feminine warmth. No platitudes, no therapy-speak, no "that must be hard."

He's gay Dutch-American, 30s, Barcelona sabbatical, ADHD/C-PTSD, doing
IFS/EMDR with Isa. He uses his own frameworks — don't introduce generic
therapy language. Two dogs. Building Espejo (this system).

If you don't have context for what he's referencing, ask one short
clarifying question. Don't manufacture context.

Telegram HTML only: <b>, <i>. No markdown.
```

Date/timezone preamble + `<untrusted>` rule for tool-result content prepended at runtime. Anthropic prompt caching enabled (`cacheSystem: true`).

- Tool catalog (forward-looking for Claude-mobile replacement):
  - **Read journal/artifacts**: `search_content`, `search_artifacts`, `get_entries_by_date`, `find_similar`, `list_artifacts`, `on_this_day`, `entry_stats`, `get_artifact`
  - **Read Oura**: `get_oura_summary`, `get_oura_weekly`, `get_oura_trends`, `get_oura_analysis`, `oura_compare_periods`, `oura_correlate`
  - **Vault sync**: `get_obsidian_sync_status`, `sync_obsidian_vault`
  - **Write**: `write_vault_artifact`
- **Excluded**: `log_weights` (slash + CSV path), `log_checkpoint` (flow path), `distill_hn_thread` (flow path), `save_evening_review` (deleted in Phase 8).
- Streams via `chat()` `onTextDelta` + `createStreamEditor`. Tool-turn streaming uses an accumulated text variable across turns; status updates ("<i>searching journal…</i>") append to the editor and drop on the next text delta.
- Reply is **always text**. Voice synthesis path is dropped entirely. If voice replies are wanted later, add an explicit `/voice` toggle.

### Vault-prompt flow (`flows/vault-prompt.ts`)

Generic prompt-driven runner. Edit the `.md` → next session uses the new body. Same model + tool access as chat flow, so Hilo/Evening sessions reach functional parity with running them from Claude Code (modulo a few seconds of R2 → Remotely Save → DB sync delay; no shell access for prompts that need it, e.g. Tomo).

```ts
const VAULT_PROMPTS: Record<string, { sourcePath: string; model: string }> = {
  hilo:    { sourcePath: "Prompt/Spanish/Hilo.md",  model: "claude-sonnet-4-6" },
  evening: { sourcePath: "Prompt/Review/Evening.md", model: "claude-sonnet-4-6" },
};

type VaultPromptFlow = {
  flow: "vault-prompt";
  name: keyof typeof VAULT_PROMPTS;
  conversation: { role: "user" | "assistant"; content: string }[];
  startedAt: number;
};
```

On `/<name>`:
1. Load prompt body via `SELECT body FROM knowledge_artifacts WHERE source_path = $1`. Fall back to R2 fetch on miss.
2. Strip frontmatter. Use the body as `system` + 3-line preamble:
   *"You are running this prompt via Telegram. Your output renders as Telegram HTML — no markdown code blocks for prose. Use the read tools for context and `write_vault_artifact` for vault writes; if a write fails, fall back to printing the file content in chat with a note to paste manually."*
3. Initialize FlowState with empty conversation.
4. Run `chat()` with the same tool catalog as chat flow; stream via `onTextDelta`.
5. On subsequent turns, append the user message + bot reply to conversation; rerun `chat()` with full conversation history.
6. Exit on `/end` (or any registered slash command — registered slashes always reset state). No idle timeout.

Sub-commands inside the prompt (`/pivot`, `/deeper`, `/en`, `/es` per Hilo) reach the LLM as part of the user message via Tier 3 routing rule 7 (unknown slash + vault-prompt active → LLM). Adding new sub-commands is a `.md` edit, not a TS change.

**Phase-4 save parity**: when the prompt instructs Hilo PHASE 4 (Pending insight + Review file save), the LLM calls `write_vault_artifact`. Failure path: print the file content as a code block, tell user to paste manually. Mirrors `Hilo.md:388-394` MCP-mode fallback — but with the gap closed, that fallback is rarely needed.

### Distill HN flow (`flows/distill-hn.ts`)

- Trigger: message text matches `^\s*https?://(?:[\w.-]+\.)?news\.ycombinator\.com/item\?id=\d+(?:&[^\s]+)*\s*$`. Solo URL only — text like "thoughts on point 3? <url>" routes to chat instead.
- Body: parse URL, call `handleDistillHnThread(pool, { url })`, send the tool's "Starting distillation…" string. The follow-up email + Telegram message arrive when the workflow finishes.
- No LLM in this flow's own code path — the tool runs Opus internally.
- ~10 LOC.

### `/weight` slash + CSV pre-router

**`/weight` slash command** (deterministic, no LLM):
- Parser: regex for the value; relative-date resolver from `src/utils/dates.ts`.
- Examples: `/weight 78.2` → today; `/weight 78.2 yesterday`; `/weight 78.2 2026-05-03`; `/weight 78.2 last monday`.
- Calls `handleLogWeights` directly. Reply: "Logged 78.2 kg for 2026-05-03."

**CSV pre-router** (Tier 1, runs before extraction):
- Document with `text/csv` mime type and recognizable scale-CSV header (RENPHO format: first column `Date`, third column `Weight(kg)` — match flexibly to allow other scale exports later).
- Parse: M/D/YY date → YYYY-MM-DD; numeric Weight(kg) column.
- Batch `log_weights` call with `(date, kg)` pairs.
- Reply: "Logged N weights from CSV (YYYY-MM-DD to YYYY-MM-DD)."
- If parsing fails: reply "Couldn't extract weight data from this CSV; use /weight 78.2 [date] manually."

Photo-of-Apple-Health path is **deferred** — out of scope for this refactor; add later if usage warrants.

## Streaming + latency stack

Today: only practice streams. Reason — `agent/tools.ts:221-238` only uses streaming when `disableTools: true`; the tool loop calls non-streaming `messages.create`.

After refactor, all flows that run an LLM call go through `chat()` from `src/llm/`, which streams unconditionally including across tool turns. UX changes:

1. **Streaming everywhere** — every flow sends a seed message (`"…"`) immediately, builds a `createStreamEditor`, passes the editor as `onTextDelta`. First-byte-to-screen drops from "wait for full response" to "<500ms after model starts producing text."

2. **Tool-turn status updates** — when the model emits a tool_use block, append `\n\n<i>searching journal…</i>` (or per-tool string) to the editor while the tool dispatches. On next text delta from the following turn, drop the italic line and resume editing. Status appears for 1-3s, no visual jank.

3. **Anthropic prompt caching** (chat flow + vault-prompt flow) — system prompt + tool catalog hash to ~5-15k tokens, re-sent every turn today. With `cacheSystem: true` (which sets `cache_control: { type: "ephemeral" }`), turns within 5 min hit cache: ~10% input cost, faster TTFT. Mitch's chat is bursty (2-5 messages within minutes); most follow-ups hit cache.

4. **Parallel seed send + stream start** — currently `await sendTelegramMessage("…")` blocks before LLM start. Run them concurrently:

   ```ts
   const [seedId, stream] = await Promise.all([
     sendTelegramMessageReturningId(chatId, "…"),
     chatStreamPromise,
   ]);
   ```

   Buffer text deltas until `seedId` resolves, then start editing. Net TTFT becomes `max(seed, LLM-first-byte)` not `seed + LLM-first-byte`. ~200ms.

5. **Skip `getRecentMessages` for deterministic flows** — `/weight`, `/checkpoint` turn 1, solo HN URL, vault-prompt entry, CSV pre-router, screen-time pre-router — none need chat history. Save the query.

6. **Drop Oura context from chat flow's system prompt** — `buildOuraContextPrompt(pool)` runs every chat turn (~200ms) and bloats the prompt. Drop. Chat flow's tool catalog already has `get_oura_summary` etc.; LLM calls them when biometrics are relevant.

7. **`max_tokens` per flow** — chat flow `2048`, checkpoint mirror `256`, vault-prompt `4096` (long-form answers ok).

8. **Drop typing heartbeat for streaming flows** — 4.5s heartbeat is for the old non-streaming wait. Keep one initial `sendChatAction("typing")` immediately on receipt; drop the interval.

Combined: ~600-1200ms TTFT win on top of streaming. Felt-latency change is significant.

Checkpoint flow turns 1-3 are short canned strings — one-shot send, no streaming. HN flow's "Starting distillation…" is one-shot. CSV / `/weight` replies are one-shot.

## Activity logging

- **`activity_logs`** — write one row per LLM-using turn (chat flow, vault-prompt flow, checkpoint flow's mirror call). `tool_calls` JSONB captures tools invoked. `memories` stays `JSONB NOT NULL DEFAULT '[]'` (per current schema); flows write `[]`. Dropping the column is a follow-on migration, not part of this refactor.
- **`usage_logs`** — every flow handler wraps its body in `await logUsage({ source: 'telegram-flow', action: 'chat'|'checkpoint'|'hilo'|..., actor: chatId, durationMs, ok, error? })`. Replaces the today-broken approach of inferring latency from webhook ACK timestamps. Per-tool dispatch logging via `logUsage` (existing) stays.

## Migration phases (each independently mergeable)

### Phase 0 — DB schema + backfill (no Telegram changes)
- New migration entry in `scripts/migrate.ts` migrations array: create `checkpoints` table + indexes + dedup unique index; add `flow TEXT` to `chat_messages` + index.
- Add `src/db/queries/checkpoints.ts` with `insertCheckpoint`, `findRecentDuplicate`, `getCheckpointsForDate`.
- `scripts/backfill-checkpoints.ts` — read R2 vault `Checkpoint/*.md`, parse, insert with `source='vault-backfill'`. Default `--dry-run`; require `--apply` to mutate.
- Tests: `tests/db/queries/checkpoints.test.ts` — insert/find/dedup unit; backfill integration on R2 fixture.
- Bot behavior unchanged.

### Phase 1 — Cross-provider LLM via Vercel AI SDK (codebase-wide)
- Add deps: `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`.
- Add `src/llm/{chat,embed,transcribe,vision,tts,index}.ts`.
- Migrate `src/db/embeddings.ts` callers to `src/llm/embed.ts` (drop-in).
- Migrate Whisper / vision / TTS calls in `src/telegram/{voice,media,screen-time}.ts` to `src/llm/`.
- Tests: chat() integration with both providers; tool-turn streaming; prompt caching markers.
- Bot behavior unchanged (still routes through old `runAgent`, which now calls `src/llm/chat.ts` instead of bespoke loop).

### Phase 2 — Telegram scaffold (router + flow-state + persistence move)
- Add `src/telegram/router.ts` and `src/telegram/flow-state.ts`. Initially the router resolves a flow tag and delegates to a `flow='chat'` wrapper around existing `runAgent` (so chat-flow rows get tagged correctly from day one).
- Move screen-time pre-router into `router.ts` from `webhook.ts`.
- **Move user-message `insertChatMessage` out of `webhook.ts` and into the resolved flow handler** (or skip entirely for Tier-1 short-circuits). The webhook hands raw assembled messages to the router; the router decides who persists.
- `insertChatMessage` (`src/db/queries/chat.ts:17`) gains a `flow?: string` param threaded through to the SQL.
- Wire `router.ts` from `webhook.ts`.
- Tests: routing tier order (media → extraction → text → flow → handler); active-flow override of unknown slashes; user/assistant rows carry the right `flow` per route; Tier-1 short-circuits do **not** write `chat_messages`; webhook retry-after-restart still dedups via `external_message_id` UNIQUE.
- Bot behavior identical from the user's perspective.

### Phase 3 — Checkpoint flow
- Add `flows/checkpoint.ts`. Deterministic parsers; one mirror LLM call.
- `log_checkpoint` MCP tool handler swaps R2 write → `insertCheckpoint`. Adds `kind?: string` (default `"substance"`); `substance` field maps to `trigger`. Drop both Jaccard guards; keep the 10-min DB tuple check.
- Router: `/checkpoint` → flow. Active flow consumes next 1-3 user messages.
- Strip checkpoint instructions from `agent/context.ts`. Strip free-text protocol entry detection.
- Tests: end-to-end `/checkpoint` → DB row; pre-formed shortcut (≥4 segments); restart-orphan routing to chat; `parser_fallback` flag set on split failure.

### Phase 4 — Solo HN URL flow + /weight + CSV pre-router
- Add `flows/distill-hn.ts`. Router detects solo HN URLs only.
- Strip HN instructions from `agent/context.ts`. Remove `distill_hn_thread` from chat flow's tool catalog (when chat flow lands).
- Add `flows/weight-slash.ts` — `/weight` parser + relative-date resolver.
- Add `flows/weight-csv.ts` — Tier-1 CSV pre-router.
- Strip weight detection rules from `agent/context.ts`.
- Tests: HN regex (solo only); /weight relative dates; CSV parser on RENPHO fixture.

### Phase 5 — `write_vault_artifact` MCP tool
- Spec in `tools.spec.ts`; handler in `src/tools/write-vault-artifact.ts`; register in `server.ts`.
- Handler does R2 `putObjectContent` *then* `upsertObsidianArtifact` synchronously (mirrors `src/telegram/practice-session.ts:114-138`). The DB upsert is **required, not best-effort** for same-session read parity — failure to upsert is logged but doesn't fail the call (timer reconciles).
- Frontmatter parse via `src/obsidian/parser.ts` happens *before* either write; reject the call on parse failure.
- Tests: path validation, frontmatter validation, overwrite default + existence check, R2 round-trip integration, **DB upsert is visible to `search_content` immediately after write**, R2-success-but-DB-fail returns success and writes a `usage_logs` warning.
- Available to all MCP clients (Claude Desktop included) starting this phase.

### Phase 6 — Chat flow as default
- Add `flows/chat.ts`. Cap context at 12 messages from `chat_messages WHERE flow IS NULL`. Tool catalog: full read tools + `write_vault_artifact`.
- System prompt (12 lines above). Anthropic prompt caching enabled.
- Drop Oura context build from system prompt; LLM calls `get_oura_summary` if needed.
- Streams via `chat()` + `createStreamEditor`. Status text append-then-drop on tool turns.
- Reply always text — voice synth path removed.
- Router: anything not matching above → chat flow.
- Tests: 12-msg cap, tool catalog locked, snapshot test of system prompt, status-text UX.

### Phase 7 — Vault-prompt flow + /hilo + /evening
- Add `flows/vault-prompt.ts` with the `VAULT_PROMPTS` whitelist. Pin paths: `Prompt/Spanish/Hilo.md`, `Prompt/Review/Evening.md`. Lookup table: `knowledge_artifacts`.
- Same tool catalog as chat flow.
- No idle timeout. Exit only on `/end` or any other registered slash.
- Tests: prompt body load, `/end` exit, unknown-slash-pass-through, Hilo PHASE 4 calls `write_vault_artifact`.

### Phase 8 — Move /practice, delete dead code
- `/practice` and `/done`/`/end`/`/fin` move under `flows/practice.ts` (cosmetic — call `chat()` directly instead of `runAgent`).
- Delete:
  - `src/telegram/agent.ts` and `src/telegram/agent/{compaction,context,tools,truncation,constants}.ts`.
  - `compactIfNeeded` + `forceCompact` + `/compact` slash command. Compaction was DB→DB summarization for context-window control; chat flow's hard cap obviates it.
  - All callback-query handling — `webhook.ts:340-412` (`activity_detail:` + `oura_sync:` callbacks). Confirmed unused.
  - Voice synthesis path in `src/telegram/voice.ts` (`synthesizeVoiceReply`). Transcription stays.
  - The fallback `"Logged at HH:MM."` shim in `agent.ts:120-138`. Checkpoint flow always replies; no shim needed.
  - R2 write path in `src/tools/log-checkpoint.ts`. DB-only writes remain.
  - `save_evening_review` tool + handler + spec entry + server registration. Superseded by `/evening` vault-prompt flow + `write_vault_artifact`.
  - `specs/episodic-memory.md` and `specs/memory-v2.md`. Both claim "shipped" but no implementation files exist.
- Tests: delete corresponding test files; verify `pnpm check` passes.

## Decided

- **Mirror line**: keep, behind a feature flag. One sentence, in the part's voice. Single haiku call.
- **Tomo / Weekly / Monthly in vault-prompt whitelist**: ship `/hilo` + `/evening` first. Add Weekly + Monthly once Evening proves out the runner. Tomo needs shell access (`pnpm write-tomo`) so it does not fit vault-prompt — needs its own surface or stays Claude-Code-only.
- **`/morning`**: drop the slash entirely until `Morning.md` prompt exists.
- **OpenAI provider path**: stays available via Vercel AI SDK provider switch (`provider: 'openai'`). Bespoke OpenAI tool-loop in `agent/tools.ts` deletes in Phase 8.
- **Free-text "toll" / "weed" / "checkpoint"**: only `/checkpoint` enters the flow.
- **Voice replies**: dropped. Text-only replies for all flows (incl. practice). Add `/voice` later if missed.
- **Restart recovery**: chat flow handles orphans via prompt-instructed clarification, not a deterministic detector.
- **FlowState idle timeouts**: dropped. Exit on registered slash commands only.

## Open questions

1. **Chat-flow context cap of 12.** Default chosen for follow-up depth + Claude-mobile use case. Confirm with usage data after Phase 6 ships; raise if real conversation depth pushes >12 turns back.
2. **Long chat replies (>4096 chars)**. Existing `client.ts` chunking handles long sends, but streaming editor caps at `STREAM_EDIT_MAX_CHARS`. Verify in Phase 6: when a 6000-char chat reply finalizes, does the editor finalize cleanly + send a continuation, or leave a stale clipped seed? Likely needs a "final exceeds limit" branch.

## Out of scope

- Embedding Telegram messages for semantic chat-history search. YAGNI; deep recall lives in `search_content` over journal/artifact corpus.
- Cross-chat support / multi-user. Single-chat assumption stays.
- Persistent flow state in DB. In-memory; orphan-after-restart routes to chat flow.
- New check-in kinds (`parts`, `energy`, etc.). Schema is extensible; flows are additive.
- Photo-of-Apple-Health weight extraction. Deferred — RENPHO CSV covers current usage.
- A `/prompt <name>` generic command surface. Per-command (`/hilo`, `/evening`) is more discoverable; reconsider once ≥5 prompts qualify.
- Reactions handling. Already ignored at `webhook.ts:259-261`; no behavior change.
- Migrating `chat_messages` schema beyond adding `flow` column.
- Migrating scripts (`condense-insights`, `write-tomo`, `dedup/*`) to `src/llm/`. Follow-on task once the abstraction proves out via Telegram + embeddings.
- Telegram bot framework migration (Telegraf / GrammY). Existing webhook code is fine.

## Success criteria

- Fabrication classes from 2026-05-04 (cross-day, same-day-distant) are structurally impossible. Verified by deleting both Jaccard guards in Phase 3 and watching no recurrence over 30 days.
- Median Telegram first-byte-to-screen drops to <500ms. Verified via `usage_logs WHERE source = 'telegram-flow'` `duration_ms` distribution before/after.
- Concrete deletions complete: `agent.ts`, `agent/{compaction,context,tools,truncation,constants}.ts`, `/compact` handler, callback-query handlers, voice synthesis, fallback log shim, R2 write in `log-checkpoint.ts`, `save_evening_review`, `specs/{episodic-memory,memory-v2}.md`.
- System prompt in `flows/chat.ts` ≤ 15 lines (today: 76 lines, ~70 of which are protocol instructions).
- `checkpoints` table backfilled with all historical vault data; new writes go to DB only; vault folder is read-only history.
- `/weight 78.2 yesterday`, `/hilo …`, `/evening`, RENPHO CSV all work end-to-end.
- `/hilo` and `/evening` reach Phase 4 vault writes via `write_vault_artifact` — functional parity with running the prompts from Claude Code (modulo R2 → Remotely Save sync delay; modulo prompts that need shell access, which are out of scope for vault-prompt).
- Cross-provider works: `chat({ provider: 'openai', model: 'gpt-…' })` is a one-line switch from Anthropic in any flow, no code changes.
