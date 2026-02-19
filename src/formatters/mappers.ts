import type {
  EntryRow,
  SearchResultRow,
  SimilarResultRow,
  TagCountRow,
  EntryStatsRow,
} from "../db/queries.js";
import type {
  EntryResult,
  SearchResult,
  SimilarResult,
  TagCount,
  EntryStats,
} from "../../specs/tools.spec.js";
import { getWordCount } from "./entry.js";

/**
 * Map a DB entry row to a structured EntryResult.
 * Strips DB internals (id), nests weather/activity/media, computes word_count.
 */
export function toEntryResult(row: EntryRow): EntryResult {
  const result: EntryResult = {
    uuid: row.uuid,
    created_at: row.created_at.toISOString(),
    text: row.text,
    starred: row.starred,
    is_pinned: row.is_pinned,
    tags: row.tags,
    media_counts: {
      photos: row.photo_count,
      videos: row.video_count,
      audios: row.audio_count,
    },
    word_count: getWordCount(row.text),
  };

  if (row.city) result.city = row.city;
  if (row.country) result.country = row.country;
  if (row.place_name) result.place_name = row.place_name;
  if (row.latitude !== null) result.latitude = row.latitude;
  if (row.longitude !== null) result.longitude = row.longitude;
  if (row.timezone) result.timezone = row.timezone;
  if (row.template_name) result.template_name = row.template_name;
  if (row.editing_time !== null) result.editing_time = row.editing_time;

  if (row.temperature !== null || row.weather_conditions || row.humidity !== null) {
    const weather: EntryResult["weather"] = {};
    if (row.temperature !== null) weather.temperature = row.temperature;
    if (row.weather_conditions) weather.conditions = row.weather_conditions;
    if (row.humidity !== null) weather.humidity = row.humidity;
    result.weather = weather;
  }

  if (row.user_activity || row.step_count !== null) {
    const activity: EntryResult["activity"] = {};
    if (row.user_activity) activity.name = row.user_activity;
    if (row.step_count !== null) activity.step_count = row.step_count;
    result.activity = activity;
  }

  return result;
}

/**
 * Map a DB search result row to a structured SearchResult.
 */
export function toSearchResult(row: SearchResultRow): SearchResult {
  const match_sources: ("semantic" | "fulltext")[] = [];
  if (row.has_semantic) match_sources.push("semantic");
  if (row.has_fulltext) match_sources.push("fulltext");

  return {
    ...toEntryResult(row),
    rrf_score: row.rrf_score,
    match_sources,
  };
}

/**
 * Map a DB similar result row to a structured SimilarResult.
 */
export function toSimilarResult(row: SimilarResultRow): SimilarResult {
  return {
    ...toEntryResult(row),
    similarity_score: row.similarity_score,
  };
}

/**
 * Map a DB tag count row to a structured TagCount.
 */
export function toTagCount(row: TagCountRow): TagCount {
  return {
    name: row.name,
    count: row.count,
  };
}

/**
 * Map a DB entry stats row to a structured EntryStats.
 */
export function toEntryStats(row: EntryStatsRow): EntryStats {
  return {
    total_entries: row.total_entries,
    date_range: {
      first: row.first_entry.toISOString(),
      last: row.last_entry.toISOString(),
    },
    avg_word_count: row.avg_word_count,
    total_word_count: row.total_word_count,
    entries_by_day_of_week: row.entries_by_dow,
    entries_by_month: row.entries_by_month,
    avg_entries_per_week: row.avg_entries_per_week,
    longest_streak_days: row.longest_streak_days,
    current_streak_days: row.current_streak_days,
  };
}
