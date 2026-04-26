# HN Thread Distiller

**Status:** Implemented (2026-04-26)

## Context

When Mitch shares a Hacker News thread URL with the Telegram chatbot, the agent should fetch the full thread + the linked article, distill into a "signal-focused" report, email the result, and save a copy to the vault for later promotion to a permanent reference.

The email exists because Telegram is a chat surface and these distillations are dense reading material — easier to scan in Mail with proper typography. The vault copy lands in `Artifacts/Pending/Reference/` so it stays out of the insight dedup queue but still gates on a human read before being promoted to permanent reference status.

A naive single fetch of the HN HTML page under-returns deeper sub-threads (collapsed "more" links). We use the HN Algolia API (`https://hn.algolia.com/api/v1/items/{id}`) which returns the entire nested comment tree as JSON.

## Architecture

```
Telegram message containing HN URL
        │
        ▼
Telegram agent (system prompt rule)
        │
        ▼
distill_hn_thread tool   ── returns "Starting…" immediately
        │
        ▼ void / fire-and-forget
runHnDistillWorkflow()
        ├─ fetchHnItem(itemId)        — Algolia API, full recursive tree
        ├─ fetchArticleText(item.url) — bare fetch + cheerio strip (skipped for self-posts)
        ├─ formatThreadForPrompt()    — flatten tree, strip HTML, indent by depth
        ├─ distillThread()            — single Claude Opus 4.7 call
        ├─ composeEmail()             — markdown → HTML via marked, plus footer with cost
        ├─ sendEmail()                — Gmail SMTP via shared src/email/send.ts
        ├─ writePendingReference()    — Artifacts/Pending/Reference/HN-{date}-{slug}.md
        ├─ logUsage()                 — usage_logs row with cost + meta
        └─ sendTelegramMessage()      — "✅ HN #X distilled ($cost) — emailed and saved to …"
```

**Execution model:** async background. The tool handler returns within milliseconds; the heavy work (article fetch, ~30-60s Claude call, email, vault write) continues in the Node event loop. Errors are caught inside the workflow and reported back to the user as a Telegram message — the agent loop never sees the rejection.

**Why one Claude call:** A typical 100-comment thread plus article body is ~30-60K tokens; even outliers fit comfortably in Opus 4.7's 1M context window. No multi-step extraction or fan-out is needed.

## Files

| Path | Purpose |
|---|---|
| `specs/tools.spec.ts` | `distill_hn_thread` tool spec |
| `src/server.ts` | Handler registration |
| `src/tools/distill-hn-thread.ts` | MCP tool entrypoint — validates input, fires workflow |
| `src/hn/parse-url.ts` | HN URL or bare id → numeric `itemId` |
| `src/hn/algolia.ts` | `fetchHnItem(itemId)` against Algolia, returns recursive tree |
| `src/hn/article.ts` | `fetchArticleText(url)` with cheerio-based readable extraction |
| `src/hn/format-thread.ts` | Flatten tree to indented `[1.2.3] author: text` lines |
| `src/hn/pricing.ts` | Per-million token rates + cost computation |
| `src/hn/distill.ts` | Single Opus 4.7 call with the spec's system prompt |
| `src/hn/email.ts` | Compose subject/text/HTML for the email |
| `src/hn/vault.ts` | Upload `Pending/Reference/HN-{date}-{slug}.md` to the R2 vault bucket |
| `src/hn/workflow.ts` | Orchestrator — fetch → distill → email → vault → notify |
| `src/email/send.ts` | Generic Gmail SMTP wrapper, shared with `scripts/book/send.ts` |
| `src/telegram/agent/context.ts` | New behavioral rule pointing the agent at the tool |

## Output format

The distillation system prompt asks for:

1. **Headline facts** — what the article actually says, 3-6 sentences, no marketing language
2. **Where it wins / Where it loses** (or equivalent structural framing)
3. **The hidden number** — buried fact that matters most (omitted if none)
4. **Comments by angle** — practitioner reports, contrarian takes, structural/cynical takes, anecdotes
5. **Useful resources** — links/tools mentioned in passing (omitted if none)
6. **The actual signal** — numbered takeaways

Quote sparingly, paraphrase by default. Skip generic agreement, jokes-without-info, pile-ons, marketing copy.

## Email layout

- **Subject:** `HN Distill: {article_title || hn_title}`
- **HTML body:** marked-rendered markdown inside a centered card (max-width 680px, system font stack, 1.6 line-height) for readable typography across mail clients.
- **Plain-text body:** raw markdown.
- **Footer:** HN thread + article links, cost line: `$0.0234 (12,345 in / 1,234 out · claude-opus-4-7)`.

## Vault copy

- **Storage**: uploaded to R2 bucket `artifacts` at key `Pending/Reference/HN-{YYYY-MM-DD}-{slug}.md` (date in `config.timezone`). This is the same bucket Remotely Save reads/writes from in Obsidian, so the file appears in Mitch's local vault on Remotely Save's next sync.
- **DB indexing**: `src/obsidian/sync.ts` runs every 30 min, picks up the new key from R2, parses the frontmatter, upserts into `knowledge_artifacts` (status: pending). Can also be triggered on-demand via the `sync_obsidian_vault` MCP tool or `pnpm sync:obsidian`.
- **Frontmatter**: `kind: reference`, `status: pending`, `tags: [hn, ...]`
- **Title** in first `# heading` (per project convention)
- **Body**: distillation + footer with HN + article URLs
- **Review flow**: Mitch deletes OR moves to `Reference/` and flips `status: approved`. Remotely Save pushes the change back up to R2 → next sync indexes it.

Why R2 instead of writing to a local `Artifacts/` symlink? The Telegram bot runs on Railway, where the container filesystem is ephemeral. R2 is the single source of truth that both the local Obsidian vault and the production DB sync read from.

## Configuration

| Env var | Purpose | Default |
|---|---|---|
| `GMAIL_APP_PASSWORD` | Gmail SMTP credential | (required when tool fires) |
| `GMAIL_FROM_EMAIL` | SMTP user + sender | `mitchhankins01@gmail.com` |
| `GMAIL_TO_EMAIL` | Recipient | falls back to `GMAIL_FROM_EMAIL` |
| `ANTHROPIC_API_KEY` | For the distill call | (required) |
| `TELEGRAM_ALLOWED_CHAT_ID` | Where the success/failure ping lands | (required) |

The model is hard-coded (`claude-opus-4-7`) inside `src/hn/distill.ts` rather than reading from `config.anthropic.model` so the regular telegram agent can stay on Sonnet without affecting distill quality.

## Verification

- **Unit:** `tests/hn/parse-url.test.ts`, `tests/hn/format-thread.test.ts`, `tests/hn/pricing.test.ts`, `tests/hn/email.test.ts`, `tests/hn/vault.test.ts`, `tests/email/send.test.ts`.
- **End-to-end (manual):**
  1. Send any HN thread URL to the bot.
  2. Confirm immediate "Starting distillation…" reply.
  3. Confirm email arrives at the configured `GMAIL_TO_EMAIL` with HTML rendering, both source links, cost footer.
  4. Confirm `Artifacts/Pending/Reference/HN-{date}-{slug}.md` exists with the expected frontmatter.
  5. Confirm Telegram follow-up "✅ HN #X distilled ($cost)…" lands.
- **`pnpm check`** must pass — types, lint, vitest (with strict coverage thresholds).

## Open questions

- Cache key on `itemId` to skip re-distilling the same thread? Out of scope for v1; single user, low volume.
- Promote-to-Reference flow: today the user manually edits the file. Could automate with a `/promote` command later.
