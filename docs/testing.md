# Testing

> Back to [AGENTS.md](../AGENTS.md)

## Two Test Tiers

**Unit tests** (`tests/tools/`, `tests/formatters/`, `tests/oura/`, `tests/insights/`, `tests/utils/`):
- No database needed
- Test param validation, formatter output, spec conformance
- Fast — run in milliseconds

**Integration tests** (`tests/integration/`):
- Require PostgreSQL with pgvector
- Test actual SQL queries, RRF ranking, embedding similarity
- Docker Compose auto-starts a test DB on port 5433 via vitest `globalSetup`
- Test DB uses `tmpfs` — RAM-backed, no disk persistence, fast teardown

## Test Isolation

Each test gets a clean database state:
- `beforeEach`: truncate all tables, re-seed from fixtures
- Fixtures include pre-computed embedding vectors (no OpenAI calls during tests)
- Test DB runs on port 5433 (dev DB is on port 5434)
- Test Docker Compose uses project name `espejo-test` (`-p espejo-test`) to isolate from dev containers — test teardown won't destroy dev volumes

## Pre-Computed Embeddings in Fixtures

`specs/fixtures/seed.ts` contains test entries with hardcoded 1536-dimension embedding vectors. This makes tests:
- **Deterministic** — same results every run, no API variability
- **Fast** — no network calls
- **Free** — no OpenAI charges during CI

For entries that should be "semantically similar" in tests, their fixture vectors should be similar (copy a vector and add small random noise). The exact values don't matter for unit tests.

## Custom Assertions

`tests/helpers/assertions.ts` provides assertions with actionable error messages:

```typescript
// Instead of: "expected [] to have length > 0"
// You get:    "Expected results for query 'nervous system' but got 0.
//              Hint: Check embeddings exist in fixtures.
//              Hint: Verify RRF query handles NULL embeddings."
```

When writing new assertions, always include a `Hint:` pointing to the file and function most likely to contain the bug.
