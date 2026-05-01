CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS entries (
    id SERIAL PRIMARY KEY,
    uuid TEXT UNIQUE NOT NULL,

    -- Content
    text TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL,
    modified_at TIMESTAMPTZ,
    timezone TEXT,

    -- Location (flattened from nested object)
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    city TEXT,
    country TEXT,
    place_name TEXT,
    admin_area TEXT,

    -- Weather (most useful fields flattened)
    temperature FLOAT,
    weather_conditions TEXT,
    humidity FLOAT,
    moon_phase FLOAT,
    sunrise TIMESTAMPTZ,
    sunset TIMESTAMPTZ,

    -- Source and versioning
    source TEXT NOT NULL DEFAULT 'dayone'
        CHECK (source IN ('dayone', 'web', 'telegram', 'mcp')),
    version INT NOT NULL DEFAULT 1,

    -- Vector embedding (1536 dims for text-embedding-3-small)
    embedding vector(1536),

    -- Full-text search (auto-generated)
    text_search tsvector GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE(text, ''))
    ) STORED
);

-- NOTE: tags, entry_tags, artifact_tags are created here for migration history
-- compatibility (migrations 017-018 reference them). Migration 035 drops them.
CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id INT REFERENCES entries(id) ON DELETE CASCADE,
    tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
);

CREATE TABLE IF NOT EXISTS media (
    id SERIAL PRIMARY KEY,
    entry_id INT REFERENCES entries(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    md5 TEXT,
    file_size INT,
    dimensions JSONB,
    duration FLOAT,
    camera_info JSONB,
    location JSONB,
    storage_key TEXT,
    url TEXT
);

CREATE TABLE IF NOT EXISTS daily_metrics (
    id SERIAL PRIMARY KEY,
    date DATE UNIQUE NOT NULL,
    weight_kg DOUBLE PRECISION,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Universal usage log: every MCP tool call, HTTP request, Telegram tool, cron
-- fire, and script run records here. Telegram-specific conversation audit
-- (memories, per-message cost) stays in `activity_logs`.
CREATE TABLE IF NOT EXISTS usage_logs (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL,         -- 'mcp' | 'telegram' | 'http' | 'cron' | 'script'
    surface TEXT,                 -- 'mcp-stdio' | 'mcp-http' | 'webhook' | 'rest' | 'oura-sync' | 'obsidian-sync' | 'on-this-day' | etc.
    actor TEXT,                   -- chat_id, ip, hostname, script name
    action TEXT NOT NULL,         -- tool name, METHOD+path, job name
    args JSONB,
    ok BOOLEAN NOT NULL,
    error TEXT,
    duration_ms INTEGER,
    meta JSONB
);

CREATE INDEX IF NOT EXISTS usage_logs_ts_idx
    ON usage_logs (ts DESC);
CREATE INDEX IF NOT EXISTS usage_logs_source_ts_idx
    ON usage_logs (source, ts DESC);
CREATE INDEX IF NOT EXISTS usage_logs_action_ts_idx
    ON usage_logs (action, ts DESC);

-- ============================================================================
-- agent_sessions: Claude Code / OpenCode session metadata for usage analytics.
-- See specs/agent-sessions-ingestor.md.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    surface         TEXT NOT NULL,                  -- 'claude-code' | 'opencode' | 'codex'
    session_id      TEXT NOT NULL,                  -- surface's native session UUID
    project_path    TEXT NOT NULL,                  -- decoded path the session was tied to
    category        TEXT NOT NULL DEFAULT 'mixed',  -- 'reflection'|'dev'|'automation'|'throwaway'|'mixed'
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ,
    message_count   INTEGER NOT NULL DEFAULT 0,
    user_msg_count  INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    tools_used      TEXT[]  NOT NULL DEFAULT '{}',  -- distinct tool names
    tool_calls      JSONB   NOT NULL DEFAULT '[]',  -- [{name, args, ok, ts, error?, truncated?}]
    prompts         JSONB   NOT NULL DEFAULT '[]',  -- [{ts, text}] user messages only
    models          TEXT[]  NOT NULL DEFAULT '{}',
    transcript_uri  TEXT,
    source_mtime    TIMESTAMPTZ,
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (surface, session_id)
);

CREATE INDEX IF NOT EXISTS agent_sessions_started_at_idx
    ON agent_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS agent_sessions_project_idx
    ON agent_sessions (project_path);
CREATE INDEX IF NOT EXISTS agent_sessions_tools_used_idx
    ON agent_sessions USING GIN (tools_used);
CREATE INDEX IF NOT EXISTS agent_sessions_category_idx
    ON agent_sessions (category);

-- Canonical query surface for reflection/review/self-exploration analytics.
-- Filters out dev work (touched src/ only), automation (programmatic invocations
-- like dedup council legs), and throwaways. Use this view by default when
-- querying for "how is espejo used".
CREATE OR REPLACE VIEW reflection_sessions AS
  SELECT * FROM agent_sessions
   WHERE category IN ('reflection', 'mixed');

CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
CREATE INDEX IF NOT EXISTS idx_entries_source_created ON entries(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_text_search ON entries USING GIN(text_search);
CREATE INDEX IF NOT EXISTS idx_entries_embedding ON entries USING ivfflat(embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_entries_trgm ON entries USING GIN(text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entries_city ON entries(city);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);

-- ============================================================================
-- Chat & Pattern Memory (Telegram chatbot)
-- ============================================================================

-- Short-term: raw conversation messages (pruned on compaction)
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

-- ============================================================================
-- Activity logs (per-agent-run observability)
-- ============================================================================

-- One row per agent run: memories retrieved, tool calls with full results
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

-- ============================================================================
-- Oura Ring integration
-- ============================================================================

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
    contributors JSONB,
    raw_json JSONB NOT NULL
);

-- sleep_type values: 'long_sleep' (main night sleep), 'late_nap', 'sleep'.
-- Stage durations (deep/rem/light/awake) live in raw_json — the /sleep endpoint
-- returns them per session, not aggregated per day.
CREATE TABLE IF NOT EXISTS oura_sleep_sessions (
    oura_id TEXT PRIMARY KEY,
    day DATE NOT NULL,
    period INT,
    sleep_type TEXT,
    bedtime_start TIMESTAMPTZ,
    bedtime_end TIMESTAMPTZ,
    average_hrv DOUBLE PRECISION,
    average_heart_rate DOUBLE PRECISION,
    total_sleep_duration_seconds INT,
    efficiency DOUBLE PRECISION,
    raw_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oura_sleep_sessions_day ON oura_sleep_sessions(day DESC);
CREATE INDEX IF NOT EXISTS idx_oura_sleep_sessions_day_type ON oura_sleep_sessions(day, sleep_type);

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

-- ============================================================================
-- Knowledge artifacts
-- ============================================================================

CREATE TABLE IF NOT EXISTS knowledge_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('insight', 'reference', 'note', 'project', 'review')),
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
    body TEXT NOT NULL CHECK (char_length(body) > 0),
    tags TEXT[] NOT NULL DEFAULT '{}',
    embedding vector(1536),
    embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
    ) STORED,
    source_path TEXT,
    content_hash TEXT,
    source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'obsidian', 'mcp', 'telegram')),
    duplicate_of UUID REFERENCES knowledge_artifacts(id) ON DELETE SET NULL,
    deleted_at TIMESTAMPTZ,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_source_path
    ON knowledge_artifacts (source_path) WHERE source_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_title_lower
    ON knowledge_artifacts (lower(title));

CREATE TABLE IF NOT EXISTS knowledge_artifact_sources (
    artifact_id UUID NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
    entry_uuid TEXT NOT NULL REFERENCES entries(uuid) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (artifact_id, entry_uuid)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_artifact_sources_entry
    ON knowledge_artifact_sources (entry_uuid);

CREATE TABLE IF NOT EXISTS artifact_tags (
    artifact_id UUID REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
    tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (artifact_id, tag_id)
);

CREATE TABLE IF NOT EXISTS artifact_links (
    source_id UUID NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES knowledge_artifacts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_id, target_id),
    CHECK (source_id != target_id)
);

CREATE INDEX IF NOT EXISTS idx_artifact_links_target
    ON artifact_links (target_id);
CREATE INDEX IF NOT EXISTS idx_artifact_links_created_at
    ON artifact_links (created_at DESC);

-- ============================================================================
-- Obsidian sync runs
-- ============================================================================

CREATE TABLE IF NOT EXISTS obsidian_sync_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error')),
    files_synced INT NOT NULL DEFAULT 0,
    files_deleted INT NOT NULL DEFAULT 0,
    links_resolved INT NOT NULL DEFAULT 0,
    errors JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started
    ON obsidian_sync_runs (started_at DESC);

-- Trigger: bump version on UPDATE and auto-bump updated_at unless the caller
-- explicitly changed it (e.g. obsidian sync writing the frontmatter timestamp).
CREATE OR REPLACE FUNCTION knowledge_artifact_version_bump()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
        NEW.updated_at := NOW();
    END IF;
    NEW.version := OLD.version + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_artifact_version_bump ON knowledge_artifacts;
CREATE TRIGGER trg_knowledge_artifact_version_bump
    BEFORE UPDATE ON knowledge_artifacts
    FOR EACH ROW
    EXECUTE FUNCTION knowledge_artifact_version_bump();

-- ============================================================================
-- Views
-- ============================================================================

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
LEFT JOIN LATERAL (
    SELECT average_hrv, average_heart_rate
    FROM oura_sleep_sessions
    WHERE day = d.day AND sleep_type = 'long_sleep'
    LIMIT 1
) ss ON TRUE
LEFT JOIN daily_metrics m ON m.date = d.day;
