# Deployment

> Back to [AGENTS.md](../AGENTS.md)

## CI/CD

### GitHub Actions

`.github/workflows/ci.yml` runs on every push/PR to `main` with two jobs:

1. **lint** — `pnpm typecheck` + `pnpm lint`
2. **test** (needs lint) — `pnpm test -- --coverage` (unit + integration + strict coverage thresholds)

Integration tests use Docker Compose inside CI (same as local). The vitest `globalSetup` starts the test DB container automatically. Docker is pre-installed on GitHub's `ubuntu-latest` runners.

### Coverage

Coverage is enforced via `@vitest/coverage-v8` with a mixed policy in `vitest.config.ts`: global thresholds (`lines/functions/statements=95`, `branches=90`) plus 100% thresholds for critical modules (`src/db/queries.ts`, `src/transports/http.ts`, `src/tools/search.ts`, `src/oura/analysis.ts`). `pnpm check` runs coverage locally too (`pnpm test:coverage`).

Files excluded from coverage via config: `src/index.ts` (entry point), `src/db/client.ts` (module-level pool), `src/transports/oauth.ts` (runtime-only OAuth), and `src/oura/types.ts` (type-only). Defensive branches in `src/db/queries.ts`, `src/server.ts`, and `src/oura/analysis.ts` use `/* v8 ignore next */` pragmas.

Run `pnpm test:coverage` locally to check coverage before pushing.

### Local CI with act

[act](https://github.com/nektos/act) runs GitHub Actions workflows locally in Docker. Configured via `.actrc`.

```bash
act push -j lint      # Typecheck + lint (works fully on macOS)
act push              # Full pipeline (integration tests need Docker-in-Docker)
```

The `lint` job runs cleanly on Apple Silicon. The `test` job may fail locally due to Docker-in-Docker limitations under QEMU emulation — this is expected. Use `pnpm check` for full local validation including integration tests.

### Pipeline

| Environment | Trigger | What runs |
|-------------|---------|-----------|
| Local | `pnpm check` | typecheck → lint → test + coverage (100%) |
| Local (act) | `act push -j lint` | typecheck → lint (in Docker, matches CI) |
| CI | Push/PR to main | lint → test + coverage (100%) |
| Production | Merge to main | Railway auto-deploy via Dockerfile |

## Railway Deployment

Deployed to Railway. Mirrors the deployment pattern from [oura-ring-mcp](https://github.com/mitchhankins01/oura-ring-mcp).

**Required Railway env vars:**
- `DATABASE_URL` — auto-set by Railway PostgreSQL addon (must have pgvector extension)
- `OPENAI_API_KEY` — for query-time embedding in `search_entries`
- `NODE_ENV=production`
- `R2_PUBLIC_URL` — Cloudflare R2 public bucket URL

**Optional:**
- `PORT` — auto-set by Railway
- `MCP_SECRET` — static bearer token for Claude Desktop HTTP access
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` — for media sync

The Dockerfile is multi-stage: TypeScript build → slim Node.js runtime. The production image does not include dev dependencies, test fixtures, or Docker Compose files.

## Telegram Bot Deployment

The Telegram chatbot is opt-in. If `TELEGRAM_BOT_TOKEN` is set in production, these vars are required (startup will fail otherwise):

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot API token from @BotFather |
| `TELEGRAM_SECRET_TOKEN` | Webhook verification (you generate this — any random string) |
| `TELEGRAM_ALLOWED_CHAT_ID` | Your personal chat ID (single-user access control) |
| `OPENAI_API_KEY` | Embeddings + Whisper transcription + voice reply TTS |
| `ANTHROPIC_API_KEY` | Required only when `TELEGRAM_LLM_PROVIDER=anthropic` (default provider) |

**Optional Telegram behavior/config vars:**

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_LLM_PROVIDER` | Conversation model provider: `anthropic` or `openai` |
| `OPENAI_CHAT_MODEL` | OpenAI chat model when `TELEGRAM_LLM_PROVIDER=openai` |
| `ANTHROPIC_MODEL` | Anthropic model when `TELEGRAM_LLM_PROVIDER=anthropic` |
| `TELEGRAM_VOICE_REPLY_MODE` | Voice reply policy: `off`, `adaptive`, or `always` |
| `TELEGRAM_VOICE_REPLY_EVERY` | In adaptive mode, send voice for every Nth text-origin message |
| `TELEGRAM_VOICE_REPLY_MIN_CHARS` | Lower character bound for voice-eligible responses |
| `TELEGRAM_VOICE_REPLY_MAX_CHARS` | Upper character bound for voice-eligible responses |
| `OPENAI_TTS_MODEL` | OpenAI speech model used for voice replies |
| `OPENAI_TTS_VOICE` | Voice preset used for TTS output |

**Setting up the webhook:**

```bash
# Generate a secret token
openssl rand -hex 32

# Set the webhook (reads TELEGRAM_BOT_TOKEN and TELEGRAM_SECRET_TOKEN from env)
pnpm telegram:setup https://your-app.railway.app/api/telegram

# Check webhook status
pnpm telegram:setup --info

# Remove webhook (for debugging)
pnpm telegram:setup --delete
```

**Finding your chat ID:**

1. Message your bot on Telegram
2. Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Look for `"chat":{"id": 123456789}` in the response
4. Set `TELEGRAM_ALLOWED_CHAT_ID=123456789` in Railway
