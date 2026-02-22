import dotenv from "dotenv";
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.production.local", override: true });
} else if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: ".env", override: true });
}
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const databaseUrl =
  process.env.DATABASE_URL ||
  (process.env.NODE_ENV === "test"
    ? "postgresql://test:test@localhost:5433/journal_test"
    : "postgresql://dev:dev@localhost:5434/journal_dev");

interface Migration {
  name: string;
  getSql: () => string;
}

const migrations: Migration[] = [
  {
    name: "001-initial-schema",
    getSql: () =>
      fs.readFileSync(
        path.resolve(__dirname, "..", "specs", "schema.sql"),
        "utf-8"
      ),
  },
  {
    name: "002-daily-metrics",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS daily_metrics (
          id SERIAL PRIMARY KEY,
          date DATE UNIQUE NOT NULL,
          weight_kg DOUBLE PRECISION,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);
    `,
  },
  {
    name: "003-chat-tables",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS chat_messages (
          id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          external_message_id TEXT UNIQUE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tool_call_id TEXT,
          compacted_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_active ON chat_messages(chat_id, created_at) WHERE compacted_at IS NULL;

      CREATE TABLE IF NOT EXISTS patterns (
          id SERIAL PRIMARY KEY,
          content TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'behavior',
          confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          embedding vector(1536),
          embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
          strength DOUBLE PRECISION DEFAULT 1.0,
          times_seen INT DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'active',
          temporal JSONB,
          canonical_hash TEXT,
          first_seen TIMESTAMPTZ NOT NULL,
          last_seen TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          text_search tsvector GENERATED ALWAYS AS (
              to_tsvector('english', COALESCE(content, ''))
          ) STORED
      );
      CREATE INDEX IF NOT EXISTS idx_patterns_embedding
          ON patterns USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
      CREATE INDEX IF NOT EXISTS idx_patterns_text_search ON patterns USING GIN(text_search);
      CREATE INDEX IF NOT EXISTS idx_patterns_status ON patterns(status) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_patterns_canonical_hash ON patterns(canonical_hash);

      CREATE TABLE IF NOT EXISTS pattern_observations (
          id SERIAL PRIMARY KEY,
          pattern_id INT REFERENCES patterns(id) ON DELETE CASCADE,
          chat_message_ids INT[],
          evidence TEXT NOT NULL,
          evidence_roles TEXT[] NOT NULL DEFAULT '{}',
          confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          extractor_version TEXT NOT NULL DEFAULT 'v1',
          observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pattern_observations_pattern ON pattern_observations(pattern_id);

      CREATE TABLE IF NOT EXISTS pattern_relations (
          id SERIAL PRIMARY KEY,
          from_pattern_id INT REFERENCES patterns(id) ON DELETE CASCADE,
          to_pattern_id INT REFERENCES patterns(id) ON DELETE CASCADE,
          relation TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (from_pattern_id, to_pattern_id, relation)
      );

      CREATE TABLE IF NOT EXISTS pattern_aliases (
          id SERIAL PRIMARY KEY,
          pattern_id INT REFERENCES patterns(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          embedding vector(1536),
          created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pattern_entries (
          pattern_id INT REFERENCES patterns(id) ON DELETE CASCADE,
          entry_uuid TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'compaction',
          confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          times_linked INT NOT NULL DEFAULT 1,
          last_linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (pattern_id, entry_uuid)
      );

      CREATE TABLE IF NOT EXISTS api_usage (
          id SERIAL PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          purpose TEXT NOT NULL,
          input_tokens INT NOT NULL DEFAULT 0,
          output_tokens INT NOT NULL DEFAULT 0,
          duration_seconds DOUBLE PRECISION,
          cost_usd DOUBLE PRECISION NOT NULL,
          latency_ms INT,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at);
      CREATE INDEX IF NOT EXISTS idx_api_usage_purpose ON api_usage(purpose);
    `,
  },
  {
    name: "004-memory-hardening",
    getSql: () => `
      ALTER TABLE patterns
        ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'compaction',
        ADD COLUMN IF NOT EXISTS source_id TEXT,
        ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

      ALTER TABLE pattern_observations
        ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'chat_compaction',
        ADD COLUMN IF NOT EXISTS source_id TEXT;

      ALTER TABLE patterns
        DROP CONSTRAINT IF EXISTS patterns_kind_check;
      ALTER TABLE patterns
        ADD CONSTRAINT patterns_kind_check CHECK (
          kind IN (
            'behavior', 'emotion', 'belief', 'goal', 'preference',
            'temporal', 'causal', 'fact', 'event'
          )
        );

      ALTER TABLE patterns
        DROP CONSTRAINT IF EXISTS patterns_status_check;
      ALTER TABLE patterns
        ADD CONSTRAINT patterns_status_check CHECK (
          status IN ('active', 'disputed', 'superseded', 'deprecated')
        );

      CREATE INDEX IF NOT EXISTS idx_patterns_expires_active
        ON patterns(expires_at)
        WHERE status = 'active' AND expires_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS memory_retrieval_logs (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        query_text TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        degraded BOOLEAN NOT NULL DEFAULT FALSE,
        pattern_ids INT[] NOT NULL DEFAULT '{}',
        pattern_kinds TEXT[] NOT NULL DEFAULT '{}',
        top_score DOUBLE PRECISION,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_memory_retrieval_logs_chat_created
        ON memory_retrieval_logs(chat_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_retrieval_logs_query_hash
        ON memory_retrieval_logs(query_hash);
    `,
  },
  {
    name: "005-memory-retrieval-logs-backfill",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS memory_retrieval_logs (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        query_text TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        degraded BOOLEAN NOT NULL DEFAULT FALSE,
        pattern_ids INT[] NOT NULL DEFAULT '{}',
        pattern_kinds TEXT[] NOT NULL DEFAULT '{}',
        top_score DOUBLE PRECISION,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_memory_retrieval_logs_chat_created
        ON memory_retrieval_logs(chat_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_retrieval_logs_query_hash
        ON memory_retrieval_logs(query_hash);
    `,
  },
  {
    name: "006-cost-notifications",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS cost_notifications (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        window_end TIMESTAMPTZ NOT NULL,
        cost_usd DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_cost_notifications_chat_created
        ON cost_notifications(chat_id, created_at DESC);
    `,
  },
  {
    name: "007-chat-soul-state",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS chat_soul_state (
          chat_id BIGINT PRIMARY KEY,
          identity_summary TEXT NOT NULL,
          relational_commitments TEXT[] NOT NULL DEFAULT '{}',
          tone_signature TEXT[] NOT NULL DEFAULT '{}',
          growth_notes TEXT[] NOT NULL DEFAULT '{}',
          version INT NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chat_soul_state_updated ON chat_soul_state(updated_at);
    `,
  },
  {
    name: "008-soul-quality-signals",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS soul_quality_signals (
          id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          assistant_message_id INT REFERENCES chat_messages(id) ON DELETE SET NULL,
          signal_type TEXT NOT NULL,
          soul_version INT NOT NULL DEFAULT 1,
          pattern_count INT NOT NULL DEFAULT 0,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT soul_quality_signal_type_check CHECK (
              signal_type IN ('felt_personal', 'felt_generic', 'correction', 'positive_reaction')
          )
      );
      CREATE INDEX IF NOT EXISTS idx_soul_quality_signals_chat_created ON soul_quality_signals(chat_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_soul_quality_signals_type ON soul_quality_signals(signal_type);
    `,
  },
];

async function migrate(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    // Ensure _migrations table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    for (const migration of migrations) {
      // Check if already applied
      const existing = await pool.query(
        "SELECT id FROM _migrations WHERE name = $1",
        [migration.name]
      );

      if (existing.rows.length > 0) {
        console.log(`Migration "${migration.name}" already applied, skipping.`);
        continue;
      }

      // Read and apply schema
      const sql = migration.getSql();

      await pool.query("BEGIN");
      try {
        const statements = splitSqlStatements(sql);
        for (const stmt of statements) {
          const trimmed = stmt.trim();
          if (trimmed && !trimmed.startsWith("--")) {
            await pool.query(trimmed);
          }
        }

        // Record migration
        await pool.query("INSERT INTO _migrations (name) VALUES ($1)", [
          migration.name,
        ]);

        await pool.query("COMMIT");
        console.log(`Applied migration: ${migration.name}`);
      } catch (err) {
        await pool.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await pool.end();
  }
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inParens = 0;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (char === "(") inParens++;
    if (char === ")") inParens--;

    if (char === ";" && inParens === 0) {
      statements.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements.filter((s) => s.length > 0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
