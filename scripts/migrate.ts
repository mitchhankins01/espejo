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
  rawStatements?: string[];
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
      CREATE TABLE IF NOT EXISTS soul_state (
          id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          identity_summary TEXT NOT NULL,
          relational_commitments TEXT[] NOT NULL DEFAULT '{}',
          tone_signature TEXT[] NOT NULL DEFAULT '{}',
          growth_notes TEXT[] NOT NULL DEFAULT '{}',
          version INT NOT NULL DEFAULT 1,
          updated_by TEXT NOT NULL DEFAULT 'system',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_soul_state_updated ON soul_state(updated_at);
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
  {
    name: "015-oura-tables",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS oura_sync_state (
          endpoint TEXT PRIMARY KEY,
          last_synced_day DATE NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS oura_sync_runs (
          id SERIAL PRIMARY KEY,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'running',
          records_synced INT NOT NULL DEFAULT 0,
          error TEXT
      );
      CREATE TABLE IF NOT EXISTS oura_daily_sleep (
          day DATE PRIMARY KEY,
          score INT,
          total_sleep_duration_seconds INT,
          deep_sleep_duration_seconds INT,
          rem_sleep_duration_seconds INT,
          light_sleep_duration_seconds INT,
          efficiency DOUBLE PRECISION,
          contributors JSONB,
          raw_json JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oura_sleep_sessions (
          oura_id TEXT PRIMARY KEY,
          day DATE NOT NULL,
          period INT,
          bedtime_start TIMESTAMPTZ,
          bedtime_end TIMESTAMPTZ,
          average_hrv DOUBLE PRECISION,
          average_heart_rate DOUBLE PRECISION,
          total_sleep_duration_seconds INT,
          efficiency DOUBLE PRECISION,
          raw_json JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oura_sleep_sessions_day ON oura_sleep_sessions(day DESC);
      CREATE TABLE IF NOT EXISTS oura_daily_readiness (
          day DATE PRIMARY KEY,
          score INT,
          temperature_deviation DOUBLE PRECISION,
          resting_heart_rate DOUBLE PRECISION,
          hrv_balance DOUBLE PRECISION,
          contributors JSONB,
          raw_json JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oura_daily_activity (
          day DATE PRIMARY KEY,
          score INT,
          steps INT,
          active_calories INT,
          total_calories INT,
          medium_activity_seconds INT,
          high_activity_seconds INT,
          low_activity_seconds INT,
          raw_json JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oura_daily_stress (
          day DATE PRIMARY KEY,
          stress_high_seconds INT,
          recovery_high_seconds INT,
          day_summary TEXT,
          raw_json JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oura_workouts (
          oura_id TEXT PRIMARY KEY,
          day DATE NOT NULL,
          activity TEXT,
          calories DOUBLE PRECISION,
          distance DOUBLE PRECISION,
          duration_seconds INT,
          average_heart_rate DOUBLE PRECISION,
          max_heart_rate DOUBLE PRECISION,
          raw_json JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oura_workouts_day ON oura_workouts(day DESC);
      CREATE OR REPLACE VIEW daily_health_snapshot AS
      SELECT d.day,
            d.score AS sleep_score,
            r.score AS readiness_score,
            a.score AS activity_score,
            a.steps,
            st.day_summary AS stress,
            ss.average_hrv,
            ss.average_heart_rate,
            m.weight_kg
      FROM oura_daily_sleep d
      LEFT JOIN oura_daily_readiness r ON r.day = d.day
      LEFT JOIN oura_daily_activity a ON a.day = d.day
      LEFT JOIN oura_daily_stress st ON st.day = d.day
      LEFT JOIN oura_sleep_sessions ss ON ss.day = d.day AND COALESCE(ss.period, 0) = 0
      LEFT JOIN daily_metrics m ON m.date = d.day;
    `,
  },
  {
    name: "016-knowledge-artifacts",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS knowledge_artifacts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          kind TEXT NOT NULL CHECK (kind IN ('insight', 'theory', 'model', 'reference')),
          title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
          body TEXT NOT NULL CHECK (char_length(body) > 0),
          tags TEXT[] NOT NULL DEFAULT '{}',
          embedding vector(1536),
          embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
          tsv tsvector GENERATED ALWAYS AS (
              to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
          ) STORED,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          version INT NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_embedding
          ON knowledge_artifacts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
      CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_tsv
          ON knowledge_artifacts USING GIN (tsv);
      CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_kind
          ON knowledge_artifacts (kind);
      CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_tags
          ON knowledge_artifacts USING GIN (tags);
      CREATE INDEX IF NOT EXISTS idx_knowledge_artifacts_updated
          ON knowledge_artifacts (updated_at DESC);

      CREATE TABLE IF NOT EXISTS knowledge_artifact_sources (
          artifact_id UUID NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
          entry_uuid TEXT NOT NULL REFERENCES entries(uuid) ON DELETE RESTRICT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (artifact_id, entry_uuid)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_artifact_sources_entry
          ON knowledge_artifact_sources (entry_uuid);

    `,
    // Separate function because splitSqlStatements doesn't handle $$ quoting
    rawStatements: [
      `CREATE OR REPLACE FUNCTION knowledge_artifact_version_bump()
       RETURNS TRIGGER AS $$
       BEGIN
           NEW.updated_at := NOW();
           NEW.version := OLD.version + 1;
           RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS trg_knowledge_artifact_version_bump ON knowledge_artifacts`,
      `CREATE TRIGGER trg_knowledge_artifact_version_bump
           BEFORE UPDATE ON knowledge_artifacts
           FOR EACH ROW
           EXECUTE FUNCTION knowledge_artifact_version_bump()`,
    ],
  },
  {
    name: "017-artifact-tags-junction",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS artifact_tags (
          artifact_id UUID REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
          tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (artifact_id, tag_id)
      );

      DROP INDEX IF EXISTS idx_knowledge_artifacts_tags;
    `,
    rawStatements: [
      // Migrate data from TEXT[] column if it exists (production), skip on fresh DB
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'knowledge_artifacts' AND column_name = 'tags'
         ) THEN
           INSERT INTO tags (name)
           SELECT DISTINCT unnest(tags) FROM knowledge_artifacts
           WHERE array_length(tags, 1) > 0
           ON CONFLICT (name) DO NOTHING;

           INSERT INTO artifact_tags (artifact_id, tag_id)
           SELECT ka.id, t.id
           FROM knowledge_artifacts ka, unnest(ka.tags) AS tag_name
           JOIN tags t ON t.name = tag_name
           ON CONFLICT DO NOTHING;

           ALTER TABLE knowledge_artifacts DROP COLUMN tags;
         END IF;
       END
       $$`,
    ],
  },
  {
    name: "018-lowercase-tags",
    getSql: () => ``,
    rawStatements: [
      // Merge duplicate tags that differ only by case:
      // 1. Re-point entry_tags and artifact_tags from uppercase duplicates to the lowercase canonical
      // 2. Delete the now-orphaned uppercase tag rows
      // 3. Lowercase all remaining tag names
      // 4. Add a unique index on lower(name) to prevent future duplicates
      `DO $$
       DECLARE
         dup RECORD;
         canonical_id INT;
       BEGIN
         -- For each group of tags that share the same lowercase name
         FOR dup IN
           SELECT LOWER(name) AS lname, array_agg(id ORDER BY id) AS ids
           FROM tags
           GROUP BY LOWER(name)
           HAVING COUNT(*) > 1
         LOOP
           -- Pick the lowest id as canonical
           canonical_id := dup.ids[1];

           -- Re-point entry_tags
           UPDATE entry_tags SET tag_id = canonical_id
           WHERE tag_id = ANY(dup.ids[2:])
           AND NOT EXISTS (
             SELECT 1 FROM entry_tags et2
             WHERE et2.entry_id = entry_tags.entry_id AND et2.tag_id = canonical_id
           );
           DELETE FROM entry_tags WHERE tag_id = ANY(dup.ids[2:]);

           -- Re-point artifact_tags
           UPDATE artifact_tags SET tag_id = canonical_id
           WHERE tag_id = ANY(dup.ids[2:])
           AND NOT EXISTS (
             SELECT 1 FROM artifact_tags at2
             WHERE at2.artifact_id = artifact_tags.artifact_id AND at2.tag_id = canonical_id
           );
           DELETE FROM artifact_tags WHERE tag_id = ANY(dup.ids[2:]);

           -- Delete the duplicate tag rows
           DELETE FROM tags WHERE id = ANY(dup.ids[2:]);
         END LOOP;

         -- Lowercase all remaining tag names
         UPDATE tags SET name = LOWER(name) WHERE name != LOWER(name);
       END
       $$`,
      // Add case-insensitive unique index (prevents future duplicates)
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_lower ON tags (LOWER(name))`,
    ],
  },
  {
    name: "019-add-note-kind",
    getSql: () => `
      ALTER TABLE knowledge_artifacts
        DROP CONSTRAINT IF EXISTS knowledge_artifacts_kind_check;

      ALTER TABLE knowledge_artifacts
        ADD CONSTRAINT knowledge_artifacts_kind_check
        CHECK (kind IN ('insight', 'theory', 'model', 'reference', 'note'));
    `,
  },
  {
    name: "020-todos",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS todos (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waiting', 'done')),
          next_step TEXT CHECK (next_step IS NULL OR char_length(next_step) <= 500),
          body TEXT NOT NULL DEFAULT '',
          tags TEXT[] NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
      CREATE INDEX IF NOT EXISTS idx_todos_updated ON todos(updated_at DESC);
    `,
    rawStatements: [
      `CREATE OR REPLACE FUNCTION todo_updated_at_bump()
       RETURNS TRIGGER AS $$
       BEGIN
           NEW.updated_at := NOW();
           RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS trg_todo_updated_at_bump ON todos`,
      `CREATE TRIGGER trg_todo_updated_at_bump
           BEFORE UPDATE ON todos
           FOR EACH ROW
           EXECUTE FUNCTION todo_updated_at_bump()`,
    ],
  },
  {
    name: "021-artifact-links",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS artifact_links (
          source_id UUID NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
          target_id UUID NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
          PRIMARY KEY (source_id, target_id),
          CHECK (source_id != target_id)
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_links_target ON artifact_links (target_id);
    `,
  },
  {
    name: "022-todo-redesign",
    getSql: () => `
      ALTER TABLE todos
        ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS important BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS is_focus BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES todos(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

      ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_status_check;
      ALTER TABLE todos ADD CONSTRAINT todos_status_check
        CHECK (status IN ('active', 'waiting', 'done', 'someday'));

      CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id);
      CREATE INDEX IF NOT EXISTS idx_todos_focus ON todos(is_focus) WHERE is_focus = TRUE;
      CREATE INDEX IF NOT EXISTS idx_todos_quadrant ON todos(urgent, important, status);
    `,
  },
  {
    name: "023-memory-v2",
    getSql: () => `
      ALTER TABLE patterns
        DROP CONSTRAINT IF EXISTS patterns_kind_check;

      UPDATE patterns
      SET kind = CASE
        WHEN kind IN ('fact') THEN 'identity'
        WHEN kind IN ('goal') THEN 'goal'
        ELSE 'preference'
      END;

      ALTER TABLE patterns
        ADD CONSTRAINT patterns_kind_check CHECK (
          kind IN ('identity', 'preference', 'goal')
        );

      ALTER TABLE patterns
        ALTER COLUMN kind SET DEFAULT 'preference';

      CREATE TABLE IF NOT EXISTS soul_state (
          id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          identity_summary TEXT NOT NULL,
          relational_commitments TEXT[] NOT NULL DEFAULT '{}',
          tone_signature TEXT[] NOT NULL DEFAULT '{}',
          growth_notes TEXT[] NOT NULL DEFAULT '{}',
          version INT NOT NULL DEFAULT 1,
          updated_by TEXT NOT NULL DEFAULT 'system',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_soul_state_updated ON soul_state(updated_at);
    `,
    rawStatements: [
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1
           FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name = 'chat_soul_state'
         ) THEN
           INSERT INTO soul_state (
             id,
             identity_summary,
             relational_commitments,
             tone_signature,
             growth_notes,
             version,
             updated_by,
             created_at,
             updated_at
           )
           SELECT
             1,
             css.identity_summary,
             css.relational_commitments,
             css.tone_signature,
             css.growth_notes,
             css.version,
             'migration:023-memory-v2',
             css.created_at,
             css.updated_at
           FROM chat_soul_state css
           ORDER BY css.updated_at DESC
           LIMIT 1
           ON CONFLICT (id) DO NOTHING;

           DROP TABLE chat_soul_state;
         END IF;
       END
       $$`,
    ],
  },
  {
    name: "024-insights",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS insights (
          id SERIAL PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('temporal_echo', 'biometric_correlation', 'stale_todo')),
          content_hash TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          relevance DOUBLE PRECISION NOT NULL DEFAULT 0.0,
          metadata JSONB NOT NULL DEFAULT '{}',
          notified_at TIMESTAMPTZ,
          dismissed BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_insights_hash ON insights(content_hash);
      CREATE INDEX IF NOT EXISTS idx_insights_type_created ON insights(type, created_at DESC);
    `,
  },
  {
    name: "025-checkins",
    getSql: () => `
      CREATE TABLE IF NOT EXISTS user_settings (
          chat_id BIGINT PRIMARY KEY,
          timezone TEXT NOT NULL DEFAULT 'Europe/Madrid',
          checkin_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          checkin_morning_hour INT NOT NULL DEFAULT 9,
          checkin_afternoon_hour INT NOT NULL DEFAULT 14,
          checkin_evening_hour INT NOT NULL DEFAULT 21,
          checkin_snooze_until TIMESTAMPTZ,
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS checkins (
          id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          "window" TEXT NOT NULL CHECK ("window" IN ('morning', 'afternoon', 'evening', 'event')),
          trigger_type TEXT NOT NULL DEFAULT 'scheduled'
              CHECK (trigger_type IN ('scheduled', 'oura_anomaly', 'journal_pattern')),
          prompt_text TEXT NOT NULL,
          artifact_id UUID REFERENCES knowledge_artifacts(id) ON DELETE SET NULL,
          responded_at TIMESTAMPTZ,
          ignored BOOLEAN NOT NULL DEFAULT FALSE,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_checkins_chat_created ON checkins(chat_id, created_at DESC);

      ALTER TABLE knowledge_artifacts
        DROP CONSTRAINT IF EXISTS knowledge_artifacts_kind_check;
      ALTER TABLE knowledge_artifacts
        ADD CONSTRAINT knowledge_artifacts_kind_check
        CHECK (kind IN ('insight', 'theory', 'model', 'reference', 'note', 'log'));
    `,
  },
  {
    name: "026-web-journaling",
    getSql: () => `
      ALTER TABLE entries
        ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'dayone'
          CHECK (source IN ('dayone', 'web', 'telegram')),
        ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

      CREATE INDEX IF NOT EXISTS idx_entries_source_created
        ON entries (source, created_at DESC);

      CREATE TABLE IF NOT EXISTS entry_templates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          slug TEXT UNIQUE NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 80),
          name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
          description TEXT,
          body TEXT NOT NULL DEFAULT '',
          default_tags TEXT[] NOT NULL DEFAULT '{}',
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_entry_templates_sort
          ON entry_templates (sort_order ASC, created_at ASC);
    `,
    rawStatements: [
      `CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
       BEGIN
           NEW.updated_at := NOW();
           RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS trg_entry_templates_touch_updated_at ON entry_templates`,
      `CREATE TRIGGER trg_entry_templates_touch_updated_at
           BEFORE UPDATE ON entry_templates
           FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,
      // Seed templates idempotently
      `INSERT INTO entry_templates (slug, name, description, body, default_tags, sort_order)
       VALUES
         ('morning', 'Morning Journal', 'Free-flow morning reflection',
          E'## Morning\n\nHow am I landing this morning?\n\n## Body\n\nWhat does my body feel like?\n\n## Intention\n\nWhat matters today?\n',
          '{morning-journal}', 1),
         ('evening', 'Evening Review', 'End-of-day reflection',
          E'## Review\n\nWhat happened today?\n\n## Wins\n\n## Challenges\n\n## Tomorrow\n\nWhat do I want to carry forward?\n',
          '{evening-review}', 2),
         ('freeform', 'Freeform', 'Blank entry', '', '{}', 10)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         body = EXCLUDED.body,
         default_tags = EXCLUDED.default_tags,
         sort_order = EXCLUDED.sort_order`,
    ],
  },
  {
    name: "027-artifact-links-created-at",
    getSql: () => `
      ALTER TABLE artifact_links
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

      CREATE INDEX IF NOT EXISTS idx_artifact_links_created_at
        ON artifact_links (created_at DESC);
    `,
  },
  {
    name: "028-insights-oura-notable",
    getSql: () => `
      ALTER TABLE insights DROP CONSTRAINT IF EXISTS insights_type_check;
      ALTER TABLE insights ADD CONSTRAINT insights_type_check
        CHECK (type IN ('temporal_echo', 'biometric_correlation', 'stale_todo', 'oura_notable'));
    `,
  },
  {
    name: "029-template-system-prompt",
    getSql: () => `
      ALTER TABLE entry_templates ADD COLUMN IF NOT EXISTS system_prompt TEXT
        CHECK (system_prompt IS NULL OR char_length(system_prompt) <= 10000);

      ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_source_check;
      ALTER TABLE entries ADD CONSTRAINT entries_source_check
        CHECK (source IN ('dayone', 'web', 'telegram', 'mcp'));
    `,
  },
  {
    name: "030-seed-session-system-prompts",
    getSql: () => `
      UPDATE entry_templates SET system_prompt = 'You are guiding a morning journaling session. Follow these rules:

1. WARM AND MINIMAL TONE. Be present, not performative. One prompt at a time. Wait for the response before moving on.

2. PRE-FILL BIOMETRICS. If Oura data is available in the context, mention the key numbers (sleep score, readiness, HRV) naturally before the first prompt. Do not make the user report what the ring already captured.

3. WALK THROUGH THE TEMPLATE. Use the template body as your prompt scaffold. Ask each section as a natural question. Do not dump the whole template at once.

4. RAW COMPOSITION. When all prompts are answered, compose a journal entry from the raw answers. Use the user''s own words and voice. Do not polish, editorialize, or add your own observations. First person, their tone.

5. SAVE WITHOUT APPROVAL. Once composed, immediately call create_entry with the full text and tags ["morning-journal"]. Do not ask for approval — morning entries are raw by design.

6. LANGUAGE. Match whatever language(s) the user uses. If they mix English and Spanish, mirror that in the composed entry.

7. SESSION END. After saving, confirm briefly ("Entry saved.") and stop. Do not continue prompting.' WHERE slug = 'morning';

      UPDATE entry_templates SET system_prompt = 'You are conducting an evening review session. Follow these rules:

1. STRUCTURED INTERVIEW WITH FLEXIBILITY. Follow the question sequence from the template body, but if the user goes deep on something, follow that thread. Resume the sequence naturally when they surface.

2. CONTEXT AWARENESS. You have 7-day entry summaries and Oura weekly data in the context. Use these to notice patterns, changes, and threads — but let the user lead. Share brief observations (2-3 lines max) at the start, then ask.

3. WEIGHT ASSESSMENT (if available). Thresholds for escalera state:
   - 72.5-73.5 kg: ideal range
   - < 75 kg: acceptable
   - 75-77 kg: danger zone, flag it
   - > 77 kg: concerning, name it directly

4. LOW-ENERGY PROTECTION. If the user is rushing, deflecting, or giving one-word answers, name it gently and protect the practice. A three-line entry still counts. Do not force depth they do not have tonight.

5. COMPOSED ENTRY. When the interview is complete, compose a journal entry following the evening format from the template body. Use the user''s own voice and language. Include all topics covered.

6. APPROVAL LOOP. Show the composed entry and ask: "Does this capture it, or would you change anything?" If they give feedback, revise and show again. If they approve, save.

7. SAVE ON APPROVAL. Call create_entry with the approved text and tags ["evening-review"]. Use the correct source attribution (telegram if via Telegram, mcp if via Claude Desktop).

8. LANGUAGE. Match whatever language(s) the user uses. Evening entries often mix English and Spanish.

9. SESSION END. After saving, confirm briefly and stop.' WHERE slug = 'evening';
    `,
  },
  {
    name: "031-drop-removed-features",
    getSql: () => `
      -- Drop Spanish learning tables (reviews references vocabulary, drop first)
      DROP TABLE IF EXISTS spanish_reviews CASCADE;
      DROP TABLE IF EXISTS spanish_vocabulary CASCADE;
      DROP TABLE IF EXISTS spanish_progress CASCADE;
      DROP TABLE IF EXISTS spanish_profiles CASCADE;
      DROP TABLE IF EXISTS spanish_verbs CASCADE;
      DROP TABLE IF EXISTS spanish_assessments CASCADE;

      -- Drop soul system tables
      DROP TABLE IF EXISTS soul_quality_signals CASCADE;
      DROP TABLE IF EXISTS pulse_checks CASCADE;
      DROP TABLE IF EXISTS soul_state_history CASCADE;
      DROP TABLE IF EXISTS soul_state CASCADE;

      -- Drop insight engine table
      DROP TABLE IF EXISTS insights CASCADE;

      -- Drop check-in tables
      DROP TABLE IF EXISTS checkins CASCADE;

      -- Drop user settings (only used for timezone + check-in config)
      DROP TABLE IF EXISTS user_settings CASCADE;
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

        // Execute raw statements that can't be split (e.g. $$ quoting)
        if (migration.rawStatements) {
          for (const stmt of migration.rawStatements) {
            await pool.query(stmt);
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
  let inDollarQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    // Handle $$ dollar quoting (toggle on/off)
    if (char === "$" && i + 1 < sql.length && sql[i + 1] === "$") {
      inDollarQuote = !inDollarQuote;
      current += "$$";
      i++; // skip second $
      continue;
    }

    if (!inDollarQuote) {
      if (char === "(") inParens++;
      if (char === ")") inParens--;

      if (char === ";" && inParens === 0) {
        statements.push(current.trim());
        current = "";
        continue;
      }
    }

    current += char;
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
