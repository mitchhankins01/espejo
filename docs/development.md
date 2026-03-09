# Development

> Back to [AGENTS.md](../AGENTS.md)

## Environment Separation

| Environment | DB Name | Port | Config Source | Notes |
|-------------|---------|------|---------------|-------|
| Development | `journal_dev` | 5434 | `.env` (gitignored) | Full journal data, persistent volume |
| Test | `journal_test` | 5433 | `.env.test` | Fixture data only, tmpfs (RAM), auto-managed |
| Production | Railway PG | — | Railway env vars | `DATABASE_URL` injected by Railway |

The `src/config.ts` module selects the right config based on `NODE_ENV`. Default is `development`.

### Dotenv Loading

Scripts and `src/config.ts` use env-aware dotenv:

```typescript
import dotenv from "dotenv";
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env", override: true });
}
```

- **Development/test**: Loads `.env` or `.env.test` with `override: true` (overrides shell env vars)
- **Production**: Skips dotenv entirely — uses env vars from the caller (Railway, or CLI for manual sync)

### Connecting to databases with psql

`psql` is installed via `libpq` (not in PATH by default — prefix commands or add to shell):

```bash
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
```

**Dev DB** (credentials in `.env`):
```bash
source .env && psql "$DATABASE_URL"
```

**Prod DB** (credentials in `.env.production.local`):
```bash
source .env.production.local && psql "$DATABASE_URL"
```

**Claude Code can query either DB directly** — just say "query dev" or "query prod" and I'll source the appropriate env file and run the SQL via Bash.

**Note (GUI tools like TablePlus):** Use the fields from `DATABASE_URL` in `.env`. If you get `database "dev" does not exist`, the tool is using the username as the database name — make sure to specify `journal_dev` explicitly.

## Common Tasks

### Reset dev database

```bash
docker compose down -v && docker compose up -d
pnpm migrate
pnpm sync
pnpm embed
```

### Run only integration tests

```bash
pnpm test:integration
```

This auto-starts the test DB container. You don't need to manage Docker manually.

### Run only unit tests

```bash
pnpm test:unit
```

No Docker needed.

### Add a migration

Create a new `.sql` file in a `migrations/` directory (if using file-based migrations) or add to `specs/schema.sql` and reset. For a personal project, schema resets are fine — no need for reversible migrations.

### Sync local data to production

After journaling new entries in Day One, push them to Railway:

```bash
# 1. Sync new entries from DayOne.sqlite → local dev DB
pnpm sync --skip-media

# 2. Embed any new entries missing embeddings
pnpm embed

# 3. Push to production (Railway)
NODE_ENV=production DATABASE_URL=<railway_url> OPENAI_API_KEY=<key> pnpm sync --skip-media
NODE_ENV=production DATABASE_URL=<railway_url> OPENAI_API_KEY=<key> pnpm embed
```

`NODE_ENV=production` skips dotenv loading, so the inline `DATABASE_URL` is used directly. Both sync and embed are idempotent — they only process new/changed entries.

For media upload to R2, drop `--skip-media` and add R2 env vars:

```bash
NODE_ENV=production DATABASE_URL=<url> R2_ACCOUNT_ID=<id> R2_ACCESS_KEY_ID=<key> \
  R2_SECRET_ACCESS_KEY=<secret> R2_BUCKET_NAME=<bucket> DAYONE_SQLITE_PATH=<path> pnpm sync
```

### Re-embed after model change

If you change the embedding model, re-embed everything:

```bash
pnpm embed --force   # Re-embeds all entries, not just those missing embeddings
```
