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

    -- Vector embedding (1536 dims for text-embedding-3-small)
    embedding vector(1536),

    -- Full-text search (auto-generated)
    text_search tsvector GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE(text, ''))
    ) STORED
);

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

CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
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

-- Persistent relational tone state for one evolving assistant personality
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

-- Long-term: extracted patterns (the actual memory units)
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
    source_type TEXT NOT NULL DEFAULT 'compaction',
    source_id TEXT,
    expires_at TIMESTAMPTZ,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    text_search tsvector GENERATED ALWAYS AS (
        to_tsvector('english', COALESCE(content, ''))
    ) STORED,
    CONSTRAINT patterns_kind_check CHECK (
        kind IN (
            'behavior', 'emotion', 'belief', 'goal', 'preference',
            'temporal', 'causal', 'fact', 'event'
        )
    ),
    CONSTRAINT patterns_status_check CHECK (
        status IN ('active', 'disputed', 'superseded', 'deprecated')
    )
);

CREATE INDEX IF NOT EXISTS idx_patterns_embedding
    ON patterns USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_patterns_text_search ON patterns USING GIN(text_search);
CREATE INDEX IF NOT EXISTS idx_patterns_status ON patterns(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_patterns_canonical_hash ON patterns(canonical_hash);
CREATE INDEX IF NOT EXISTS idx_patterns_expires_active ON patterns(expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;

-- Provenance: evidence trail for each pattern observation
CREATE TABLE IF NOT EXISTS pattern_observations (
    id SERIAL PRIMARY KEY,
    pattern_id INT REFERENCES patterns(id) ON DELETE CASCADE,
    chat_message_ids INT[],
    evidence TEXT NOT NULL,
    evidence_roles TEXT[] NOT NULL DEFAULT '{}',
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    extractor_version TEXT NOT NULL DEFAULT 'v1',
    source_type TEXT NOT NULL DEFAULT 'chat_compaction',
    source_id TEXT,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pattern_observations_pattern
    ON pattern_observations(pattern_id);

-- Relationships between patterns
CREATE TABLE IF NOT EXISTS pattern_relations (
    id SERIAL PRIMARY KEY,
    from_pattern_id INT REFERENCES patterns(id) ON DELETE CASCADE,
    to_pattern_id INT REFERENCES patterns(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (from_pattern_id, to_pattern_id, relation)
);

-- Alternate phrasings of the same pattern
CREATE TABLE IF NOT EXISTS pattern_aliases (
    id SERIAL PRIMARY KEY,
    pattern_id INT REFERENCES patterns(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding vector(1536),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Links patterns to journal entries
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

-- API usage tracking for cost monitoring
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

-- Memory retrieval observability
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

CREATE INDEX IF NOT EXISTS idx_memory_retrieval_logs_chat_created ON memory_retrieval_logs(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_retrieval_logs_query_hash ON memory_retrieval_logs(query_hash);

-- Cost notification ledger for 12-hour Telegram spend summaries
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
