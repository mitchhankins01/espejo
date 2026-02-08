CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS entries (
    id SERIAL PRIMARY KEY,
    uuid TEXT UNIQUE NOT NULL,

    -- Content
    text TEXT,
    rich_text JSONB,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL,
    modified_at TIMESTAMPTZ,
    timezone TEXT,

    -- Entry metadata
    is_all_day BOOLEAN DEFAULT FALSE,
    is_pinned BOOLEAN DEFAULT FALSE,
    starred BOOLEAN DEFAULT FALSE,
    editing_time FLOAT,
    duration INT,

    -- Device info
    creation_device TEXT,
    device_model TEXT,
    device_type TEXT,
    os_name TEXT,
    os_version TEXT,

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

    -- Activity
    user_activity TEXT,
    step_count INT,

    -- Template
    template_name TEXT,

    -- Source
    source_string TEXT,

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
CREATE INDEX IF NOT EXISTS idx_entries_template ON entries(template_name);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
