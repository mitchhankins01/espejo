// ============================================================================
// Core entry type
// ============================================================================

export interface JournalEntry {
  uuid: string;
  text: string | null;
  created_at: string;
  modified_at: string | null;
  timezone: string | null;
  tags: string[];

  // Location
  city: string | null;
  country: string | null;
  place_name: string | null;
  admin_area: string | null;
  latitude: number | null;
  longitude: number | null;

  // Weather
  weather: EntryWeather | null;

  // Computed
  word_count: number;
  media_counts: MediaCounts;
}

export interface EntryWeather {
  temperature: number | null;
  conditions: string | null;
  humidity: number | null;
}

export interface MediaCounts {
  photos: number;
  videos: number;
  audios: number;
}

// ============================================================================
// Search and aggregation types
// ============================================================================

export interface SearchResult {
  uuid: string;
  created_at: string;
  preview: string;
  city: string | null;
  tags: string[];
  rrf_score: number;
  match_sources: ("semantic" | "fulltext")[];
}

export interface SimilarResult {
  uuid: string;
  created_at: string;
  preview: string;
  city: string | null;
  tags: string[];
  similarity_score: number;
}

export interface TagCount {
  name: string;
  count: number;
}

export interface EntryStats {
  total_entries: number;
  date_range: { first: string; last: string };
  avg_word_count: number;
  total_word_count: number;
  entries_by_day_of_week: Record<string, number>;
  entries_by_month: Record<string, number>;
  avg_entries_per_week: number;
  longest_streak_days: number;
  current_streak_days: number;
}

// ============================================================================
// CRUD input types (web app)
// ============================================================================

export interface CreateEntryInput {
  text: string;
  tags?: string[];
  timezone?: string;
}

export interface UpdateEntryInput {
  text?: string;
  tags?: string[];
}
