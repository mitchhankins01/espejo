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
    name: "008-memory-data-backfill",
    getSql: () => `
      UPDATE memory_retrieval_logs
      SET pattern_kinds = COALESCE(
        (
          SELECT array_agg(COALESCE(memory_retrieval_logs.pattern_kinds[idx], 'unknown') ORDER BY idx)
          FROM generate_subscripts(memory_retrieval_logs.pattern_ids, 1) AS idx
        ),
        '{}'::TEXT[]
      )
      WHERE cardinality(pattern_kinds) IS DISTINCT FROM cardinality(pattern_ids);

      ALTER TABLE memory_retrieval_logs
        DROP CONSTRAINT IF EXISTS memory_retrieval_logs_pattern_arrays_match;
      ALTER TABLE memory_retrieval_logs
        ADD CONSTRAINT memory_retrieval_logs_pattern_arrays_match
        CHECK (cardinality(pattern_ids) = cardinality(pattern_kinds));

      UPDATE patterns
      SET source_type = 'chat_compaction'
      WHERE source_type = 'compaction';
      UPDATE pattern_observations
      SET source_type = 'chat_compaction'
      WHERE source_type = 'compaction';

      UPDATE patterns
      SET source_id = 'legacy:' || source_type || ':pattern:' || id::TEXT
      WHERE source_id IS NULL;
      UPDATE pattern_observations
      SET source_id = 'legacy:' || source_type || ':observation:' || id::TEXT
      WHERE source_id IS NULL;

      UPDATE pattern_observations
      SET evidence = CASE
        WHEN evidence IS JSON ARRAY THEN (evidence::jsonb)::TEXT
        WHEN evidence IS JSON THEN jsonb_build_array(evidence::jsonb)::TEXT
        ELSE jsonb_build_array(jsonb_build_object('legacy_evidence', evidence))::TEXT
      END;

      WITH observation_counts AS (
        SELECT pattern_id, COUNT(*)::INT AS observation_count
        FROM pattern_observations
        GROUP BY pattern_id
      ),
      missing AS (
        SELECT
          p.id AS pattern_id,
          GREATEST(COALESCE(p.times_seen, 0) - COALESCE(oc.observation_count, 0), 0) AS missing_count,
          COALESCE(p.last_seen, NOW()) AS observed_at
        FROM patterns p
        LEFT JOIN observation_counts oc ON oc.pattern_id = p.id
      )
      INSERT INTO pattern_observations (
        pattern_id,
        chat_message_ids,
        evidence,
        evidence_roles,
        confidence,
        extractor_version,
        source_type,
        source_id,
        observed_at
      )
      SELECT
        m.pattern_id,
        NULL,
        jsonb_build_array(
          jsonb_build_object(
            'migration',
            '008-memory-data-backfill',
            'note',
            'synthetic observation inserted to align times_seen with observation count',
            'synthetic_index',
            gs.n
          )
        )::TEXT,
        '{}'::TEXT[],
        0.5,
        'migration-backfill',
        'migration',
        'migration:008-memory-data-backfill',
        m.observed_at
      FROM missing m
      JOIN LATERAL generate_series(1, m.missing_count) AS gs(n) ON TRUE;
    `,
  },
  {
    name: "009-soul-quality-signals",
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
  {
    name: "010-spanish-learning",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS spanish_profiles (
          chat_id BIGINT PRIMARY KEY,
          cefr_level TEXT,
          known_tenses TEXT[] NOT NULL DEFAULT '{}',
          focus_topics TEXT[] NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT spanish_profiles_cefr_level_check CHECK (
              cefr_level IS NULL OR cefr_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
          )
      );

      CREATE TABLE IF NOT EXISTS spanish_verbs (
          id SERIAL PRIMARY KEY,
          infinitive TEXT NOT NULL,
          infinitive_english TEXT,
          mood TEXT NOT NULL,
          tense TEXT NOT NULL,
          verb_english TEXT,
          form_1s TEXT,
          form_2s TEXT,
          form_3s TEXT,
          form_1p TEXT,
          form_2p TEXT,
          form_3p TEXT,
          gerund TEXT,
          past_participle TEXT,
          is_irregular BOOLEAN NOT NULL DEFAULT FALSE,
          source TEXT NOT NULL DEFAULT 'jehle',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (infinitive, mood, tense)
      );
      CREATE INDEX IF NOT EXISTS idx_spanish_verbs_lookup
          ON spanish_verbs(infinitive, mood, tense);
      CREATE INDEX IF NOT EXISTS idx_spanish_verbs_irregular
          ON spanish_verbs(is_irregular);

      CREATE TABLE IF NOT EXISTS spanish_vocabulary (
          id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          word TEXT NOT NULL,
          translation TEXT,
          part_of_speech TEXT,
          region TEXT NOT NULL DEFAULT '',
          example_sentence TEXT,
          notes TEXT,
          source TEXT NOT NULL DEFAULT 'chat',
          stability DOUBLE PRECISION NOT NULL DEFAULT 0,
          difficulty DOUBLE PRECISION NOT NULL DEFAULT 0,
          reps INT NOT NULL DEFAULT 0,
          lapses INT NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'new',
          last_review TIMESTAMPTZ,
          next_review TIMESTAMPTZ,
          first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT spanish_vocabulary_state_check CHECK (
              state IN ('new', 'learning', 'review', 'relearning')
          ),
          UNIQUE (chat_id, word, region)
      );
      CREATE INDEX IF NOT EXISTS idx_spanish_vocabulary_due
          ON spanish_vocabulary(chat_id, next_review, state);
      CREATE INDEX IF NOT EXISTS idx_spanish_vocabulary_region
          ON spanish_vocabulary(chat_id, region);
      CREATE INDEX IF NOT EXISTS idx_spanish_vocabulary_seen
          ON spanish_vocabulary(chat_id, last_seen DESC);

      CREATE TABLE IF NOT EXISTS spanish_reviews (
          id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          vocabulary_id INT NOT NULL REFERENCES spanish_vocabulary(id) ON DELETE CASCADE,
          grade INT NOT NULL,
          stability_before DOUBLE PRECISION,
          stability_after DOUBLE PRECISION,
          difficulty_before DOUBLE PRECISION,
          difficulty_after DOUBLE PRECISION,
          interval_days DOUBLE PRECISION,
          retrievability DOUBLE PRECISION,
          review_context TEXT NOT NULL DEFAULT 'conversation',
          reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT spanish_reviews_grade_check CHECK (grade >= 1 AND grade <= 4)
      );
      CREATE INDEX IF NOT EXISTS idx_spanish_reviews_chat_reviewed
          ON spanish_reviews(chat_id, reviewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_spanish_reviews_vocab
          ON spanish_reviews(vocabulary_id);

      CREATE TABLE IF NOT EXISTS spanish_progress (
          id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          date DATE NOT NULL,
          words_learned INT NOT NULL DEFAULT 0,
          words_in_progress INT NOT NULL DEFAULT 0,
          reviews_today INT NOT NULL DEFAULT 0,
          new_words_today INT NOT NULL DEFAULT 0,
          tenses_practiced TEXT[] NOT NULL DEFAULT '{}',
          streak_days INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (chat_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_spanish_progress_chat_date
          ON spanish_progress(chat_id, date DESC);
    `,
  },
  {
    name: "011-activity-logs",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS activity_logs (
          id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          memories JSONB NOT NULL DEFAULT '[]',
          tool_calls JSONB NOT NULL DEFAULT '[]',
          cost_usd DOUBLE PRECISION,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_activity_logs_chat_created
          ON activity_logs(chat_id, created_at DESC);
    `,
  },
  {
    name: "012-pulse-checks-soul-history",
    getSql: () => `
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
      CREATE INDEX IF NOT EXISTS idx_pulse_checks_chat_created
          ON pulse_checks(chat_id, created_at DESC);

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
      CREATE INDEX IF NOT EXISTS idx_soul_state_history_chat_version
          ON soul_state_history(chat_id, version DESC);
    `,
  },
  {
    name: "013-spanish-assessments",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS spanish_assessments (
          id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          complexity_score DOUBLE PRECISION NOT NULL,
          grammar_score DOUBLE PRECISION NOT NULL,
          vocabulary_score DOUBLE PRECISION NOT NULL,
          code_switching_ratio DOUBLE PRECISION NOT NULL,
          overall_score DOUBLE PRECISION NOT NULL,
          sample_message_count INT NOT NULL,
          rationale TEXT NOT NULL,
          assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_spanish_assessments_chat_assessed
          ON spanish_assessments(chat_id, assessed_at DESC);
    `,
  },
  {
    name: "014-missing-indexes",
    getSql: () => `
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX IF NOT EXISTS idx_entries_trgm ON entries USING GIN(text gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_entries_city ON entries(city);
      CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
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
