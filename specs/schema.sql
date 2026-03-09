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
        CHECK (source IN ('dayone', 'web', 'telegram')),
    version INT NOT NULL DEFAULT 1,

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

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entry_templates_touch_updated_at ON entry_templates;
CREATE TRIGGER trg_entry_templates_touch_updated_at
    BEFORE UPDATE ON entry_templates
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

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

-- Persistent relational tone state for one evolving assistant personality (global singleton)
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

-- Long-term: extracted patterns (the actual memory units)
CREATE TABLE IF NOT EXISTS patterns (
    id SERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'preference',
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
            'identity', 'preference', 'goal'
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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT memory_retrieval_logs_pattern_arrays_match CHECK (
        cardinality(pattern_ids) = cardinality(pattern_kinds)
    )
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

-- Soul quality feedback signals (Phase 4: quality loop)
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

CREATE INDEX IF NOT EXISTS idx_soul_quality_signals_chat_created
    ON soul_quality_signals(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soul_quality_signals_type
    ON soul_quality_signals(signal_type);

-- Self-healing pulse checks (Phase 5: autonomous quality loop)
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

-- Soul state audit trail (Phase 5: tracks every soul mutation with reason)
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

-- ============================================================================
-- Spanish learning memory
-- ============================================================================

-- Per-chat learner profile
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

-- Global Spanish verb conjugation reference data
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

-- Per-chat vocabulary with spaced-repetition state
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

-- Review audit trail (FSRS state transitions)
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

-- Daily learning snapshots per chat
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
-- Spanish learning assessments (LLM-as-judge conversation quality)
-- ============================================================================

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

-- ============================================================================
-- Knowledge artifacts
-- ============================================================================

CREATE TABLE IF NOT EXISTS knowledge_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('insight', 'theory', 'model', 'reference', 'note', 'log')),
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

-- Trigger: auto-bump updated_at and version on UPDATE
CREATE OR REPLACE FUNCTION knowledge_artifact_version_bump()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
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
-- Todos
-- ============================================================================

CREATE TABLE IF NOT EXISTS todos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waiting', 'done', 'someday')),
    next_step TEXT CHECK (next_step IS NULL OR char_length(next_step) <= 500),
    body TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    urgent BOOLEAN NOT NULL DEFAULT FALSE,
    important BOOLEAN NOT NULL DEFAULT FALSE,
    is_focus BOOLEAN NOT NULL DEFAULT FALSE,
    parent_id UUID REFERENCES todos(id) ON DELETE CASCADE,
    sort_order INT NOT NULL DEFAULT 0,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_updated ON todos(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id);
CREATE INDEX IF NOT EXISTS idx_todos_focus ON todos(is_focus) WHERE is_focus = TRUE;
CREATE INDEX IF NOT EXISTS idx_todos_quadrant ON todos(urgent, important, status);

CREATE OR REPLACE FUNCTION todo_updated_at_bump()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_todo_updated_at_bump ON todos;
CREATE TRIGGER trg_todo_updated_at_bump
    BEFORE UPDATE ON todos
    FOR EACH ROW
    EXECUTE FUNCTION todo_updated_at_bump();

-- ============================================================================
-- Insights (background dot-connecting engine)
-- ============================================================================

CREATE TABLE IF NOT EXISTS insights (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('temporal_echo', 'biometric_correlation', 'stale_todo', 'oura_notable')),
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

-- ============================================================================
-- User Settings
-- ============================================================================

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

-- ============================================================================
-- Check-ins (proactive outreach)
-- ============================================================================

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
LEFT JOIN oura_sleep_sessions ss ON ss.day = d.day AND COALESCE(ss.period, 0) = 0
LEFT JOIN daily_metrics m ON m.date = d.day;
