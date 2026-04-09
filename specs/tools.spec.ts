/**
 * Tool Specifications — Source of Truth
 *
 * This file defines every MCP tool's contract: name, description, parameters,
 * and examples. All other layers derive from this:
 *
 *   - src/server.ts reads these specs to register tools
 *   - tests/tools/*.test.ts validates implementations against these specs
 *   - CLAUDE.md documents the tools based on these specs
 *
 * When adding a new tool, start here. When changing a tool's interface, change
 * here first, then update implementation and tests.
 */

import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Tool annotation presets
// ============================================================================

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const READ_ONLY_OPEN: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const WRITE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const WRITE_ADDITIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

// ============================================================================
// Shared schemas
// ============================================================================

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
  .describe("Date in YYYY-MM-DD format");

const monthDayString = z
  .string()
  .regex(/^\d{2}-\d{2}$/, "Must be MM-DD format")
  .describe("Month and day in MM-DD format");

const limitParam = (defaultVal: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(defaultVal)
    .describe(`Max results to return (default: ${defaultVal}, max: ${max})`);


const ouraMetricParam = z.enum(["sleep_score", "hrv", "readiness", "activity", "steps", "sleep_duration", "stress", "resting_heart_rate", "temperature", "active_calories", "heart_rate", "efficiency"]).describe("Oura metric: sleep_score, hrv, readiness, activity, steps, sleep_duration, stress, resting_heart_rate, temperature, active_calories, heart_rate, efficiency");

const ouraAnalysisTypeParam = z.enum(["sleep_quality", "anomalies", "hrv_trend", "temperature", "best_sleep"]);

const memoryKindParam = z
  .enum(["identity", "preference", "goal"])
  .describe("Memory kind: identity, preference, or goal");

// ============================================================================
// Tool result types
// ============================================================================

export interface EntryResult {
  uuid: string;
  created_at: string;
  text: string;
  city?: string;
  country?: string;
  place_name?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  weather?: {
    temperature?: number;
    conditions?: string;
    humidity?: number;
  };
  media_counts: {
    photos: number;
    videos: number;
    audios: number;
  };
  word_count: number;
  weight_kg?: number;
}

export type SearchResult = EntryResult & {
  rrf_score: number;
  match_sources: ("semantic" | "fulltext")[];
};

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

export type SimilarResult = EntryResult & {
  similarity_score: number;
};

// ============================================================================
// Tool definitions
// ============================================================================

export const toolSpecs = {
  search_entries: {
    name: "search_entries" as const,
    annotations: READ_ONLY_OPEN,
    description:
      "Hybrid semantic + keyword search across journal entries using Reciprocal Rank Fusion (BM25 full-text + vector cosine similarity). " +
      "Finds entries by meaning even when exact words don't match. " +
      "Supports optional filtering by date range and city. " +
      "Entries often contain somatic check-ins, sleep/readiness scores, and body-state reflections that can be cross-referenced with health and biometric data.",
    params: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Natural language or keyword search query. Searches both semantically (meaning) and lexically (exact words)."
        ),
      date_from: dateString
        .nullable().optional()
        .describe("Filter entries from this date, inclusive"),
      date_to: dateString
        .nullable().optional()
        .describe("Filter entries up to this date, inclusive"),
      city: z.string().nullable().optional().describe("Filter by city name"),
      limit: limitParam(10, 50),
    }),
    examples: [
      {
        input: { query: "feeling overwhelmed by work" },
        behavior:
          "Returns semantically similar entries about work stress even if those exact words aren't used",
      },
      {
        input: { query: "Barcelona", date_from: "2025-10-01" },
        behavior:
          "Combines keyword match on 'Barcelona' with date filter, boosted by semantic relevance",
      },
      {
        input: { query: "nicotine dopamine baseline" },
        behavior:
          "Multi-term query works correctly (unlike Day One MCP which returns 0 results for multi-term queries)",
      },
    ],
  },

  get_entry: {
    name: "get_entry" as const,
    annotations: READ_ONLY,
    description:
      "Get a single journal entry by its UUID with full text, all metadata, weather, location, and media counts. " +
      "Returns structured data including nested weather and location objects.",
    params: z.object({
      uuid: z.string().min(1).describe("The unique entry identifier"),
    }),
    examples: [
      {
        input: { uuid: "ABC123-DEF456" },
        behavior:
          "Returns full entry with text, location, weather, and media counts",
      },
    ],
  },

  get_entries_by_date: {
    name: "get_entries_by_date" as const,
    annotations: READ_ONLY,
    description:
      "Get all entries within a date range, ordered chronologically. Use for reviewing a specific period. " +
      "Entries include somatic reflections and self-reported health data — consider cross-referencing with biometric sources for a complete picture.",
    params: z.object({
      date_from: dateString.describe("Start of date range, inclusive"),
      date_to: dateString
        .nullable().optional()
        .describe("End of date range, inclusive; defaults to today"),
      limit: limitParam(20, 50),
    }),
    examples: [
      {
        input: { date_from: "2025-01-01", date_to: "2025-01-31" },
        behavior: "Returns up to 20 entries from January 2025, oldest first",
      },
      {
        input: {
          date_from: "2025-12-25",
          date_to: "2025-12-25",
          limit: 5,
        },
        behavior: "Returns entries from a single day",
      },
    ],
  },

  on_this_day: {
    name: "on_this_day" as const,
    annotations: READ_ONLY,
    description:
      "Find entries written on a specific calendar day (MM-DD) across all years. " +
      "Great for year-over-year reflection and seeing how your thinking has evolved. " +
      "Returns full entry data including weather and health reflections.",
    params: z.object({
      month_day: monthDayString.describe(
        "Month and day to search across all years, e.g. '03-15' for March 15th"
      ),
    }),
    examples: [
      {
        input: { month_day: "01-01" },
        behavior:
          "Returns all New Year's Day entries across every year in the journal",
      },
      {
        input: { month_day: "09-22" },
        behavior:
          "Returns entries from September 22nd of each year, ordered chronologically",
      },
    ],
  },

  find_similar: {
    name: "find_similar" as const,
    annotations: READ_ONLY_OPEN,
    description:
      "Find entries semantically similar to a given entry using cosine similarity on embeddings. " +
      "Useful for discovering recurring themes or finding related reflections you may have forgotten about.",
    params: z.object({
      uuid: z
        .string()
        .min(1)
        .describe("UUID of the source entry to find similar entries for"),
      limit: limitParam(5, 20),
    }),
    examples: [
      {
        input: { uuid: "ABC123" },
        behavior:
          "Returns the 5 most semantically similar entries, excluding the source entry itself",
      },
      {
        input: { uuid: "ABC123", limit: 10 },
        behavior:
          "Returns 10 similar entries with similarity scores between 0 and 1",
      },
    ],
  },

  entry_stats: {
    name: "entry_stats" as const,
    annotations: READ_ONLY,
    description:
      "Get writing statistics: total entries, word count trends, writing frequency by day of week and month, " +
      "average entry length, longest writing streak, and current streak. " +
      "Optionally filter to a date range.",
    params: z.object({
      date_from: dateString
        .nullable().optional()
        .describe("Start of date range for stats calculation"),
      date_to: dateString
        .nullable().optional()
        .describe("End of date range for stats calculation"),
    }),
    examples: [
      {
        input: {},
        behavior:
          "Returns stats across the entire journal — all-time frequency, streaks, word counts",
      },
      {
        input: { date_from: "2025-01-01", date_to: "2025-12-31" },
        behavior: "Returns stats scoped to 2025 only",
      },
    ],
  },
  get_oura_summary: {
    name: "get_oura_summary" as const,
    annotations: READ_ONLY,
    description: "Get a single-day Oura biometric snapshot including sleep, readiness, activity, HRV, steps, stress, and workouts.",
    params: z.object({
      date: dateString.nullable().optional().describe("Optional date in YYYY-MM-DD; defaults to today"),
    }),
    examples: [{ input: {}, behavior: "Returns today's Oura summary" }],
  },
  get_oura_weekly: {
    name: "get_oura_weekly" as const,
    annotations: READ_ONLY,
    description: "Get a 7-day Oura overview with daily scores, stress, efficiency, and aggregate stats.",
    params: z.object({
      end_date: dateString.nullable().optional().describe("Week end date (inclusive); defaults to today"),
    }),
    examples: [{ input: {}, behavior: "Returns the last 7 days of Oura data" }],
  },
  get_oura_trends: {
    name: "get_oura_trends" as const,
    annotations: READ_ONLY,
    description: "Get trend direction and rolling averages for a selected Oura metric. Supports: sleep_score, hrv, readiness, activity, steps, sleep_duration, stress, resting_heart_rate, temperature, active_calories, heart_rate, efficiency.",
    params: z.object({
      metric: ouraMetricParam.default("sleep_score"),
      days: z.number().int().min(7).max(120).default(30),
    }),
    examples: [{ input: { metric: "hrv", days: 30 }, behavior: "Returns HRV trend data" }],
  },
  get_oura_analysis: {
    name: "get_oura_analysis" as const,
    annotations: READ_ONLY,
    description: "Run an Oura analysis mode: sleep_quality, anomalies, hrv_trend, temperature, or best_sleep.",
    params: z.object({
      type: ouraAnalysisTypeParam,
      days: z.number().int().min(7).max(180).default(60),
    }),
    examples: [{ input: { type: "sleep_quality" }, behavior: "Returns sleep-focused analysis." }],
  },
  oura_compare_periods: {
    name: "oura_compare_periods" as const,
    annotations: READ_ONLY,
    description: "Compare biometrics between two date ranges and return percentage deltas. Covers all trendable metrics including stress, resting HR, temperature, calories, heart rate, and efficiency.",
    params: z.object({
      from_a: dateString,
      to_a: dateString,
      from_b: dateString,
      to_b: dateString,
    }),
    examples: [{ input: { from_a: "2025-01-01", to_a: "2025-01-07", from_b: "2025-01-08", to_b: "2025-01-14" }, behavior: "Compares week-over-week metrics." }],
  },
  oura_correlate: {
    name: "oura_correlate" as const,
    annotations: READ_ONLY,
    description: "Compute correlation between two Oura metrics over N days. Supports all trendable metrics including stress, resting HR, temperature, calories, heart rate, and efficiency.",
    params: z.object({
      metric_a: ouraMetricParam,
      metric_b: ouraMetricParam,
      days: z.number().int().min(7).max(180).default(60),
    }),
    examples: [{ input: { metric_a: "hrv", metric_b: "sleep_duration", days: 60 }, behavior: "Returns Pearson correlation." }],
  },

  get_artifact: {
    name: "get_artifact" as const,
    annotations: READ_ONLY,
    description:
      "Get a single knowledge artifact by ID with full content, source entry UUIDs, version, and embedding status.",
    params: z.object({
      id: z.string().min(1).describe("The artifact UUID"),
    }),
    examples: [
      {
        input: { id: "abc-123" },
        behavior: "Returns full artifact with body, source_entry_uuids, version, has_embedding",
      },
    ],
  },

  list_artifacts: {
    name: "list_artifacts" as const,
    annotations: READ_ONLY,
    description:
      "List knowledge artifacts with optional filtering by kind. Ordered by most recently updated.",
    params: z.object({
      kind: z.enum(["insight", "reference", "note", "project", "review"]).nullable().optional().describe("Filter by artifact kind"),
      source: z.enum(["web", "obsidian", "mcp", "telegram"]).nullable().optional().describe("Filter by source"),
      limit: limitParam(20, 100),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    }),
    examples: [
      {
        input: { kind: "insight" },
        behavior: "Returns up to 20 insight artifacts ordered by updated_at DESC",
      },
    ],
  },

  search_artifacts: {
    name: "search_artifacts" as const,
    annotations: READ_ONLY_OPEN,
    description:
      "Hybrid semantic + keyword search across knowledge artifacts using Reciprocal Rank Fusion. " +
      "Same RRF approach as search_entries but scoped to artifacts only.",
    params: z.object({
      query: z.string().min(1).describe("Search query"),
      kind: z.enum(["insight", "reference", "note", "project", "review"]).nullable().optional().describe("Filter by artifact kind"),
      source: z.enum(["web", "obsidian", "mcp", "telegram"]).nullable().optional().describe("Filter by source"),
      limit: limitParam(10, 50),
    }),
    examples: [
      {
        input: { query: "dopamine regulation" },
        behavior: "Returns artifacts about dopamine regulation ranked by RRF score",
      },
    ],
  },

  search_content: {
    name: "search_content" as const,
    annotations: READ_ONLY_OPEN,
    description:
      "Unified search across both journal entries and knowledge artifacts using Reciprocal Rank Fusion. " +
      "Returns results with a content_type discriminator. Use this when you want to search across all content types.",
    params: z.object({
      query: z.string().min(1).describe("Search query"),
      content_types: z.array(z.enum(["journal_entry", "knowledge_artifact"])).nullable().optional()
        .describe("Content types to include (default: both)"),
      date_from: dateString.nullable().optional().describe("Filter entries from this date"),
      date_to: dateString.nullable().optional().describe("Filter entries up to this date"),
      city: z.string().nullable().optional().describe("Filter entries by city"),
      artifact_kind: z.enum(["insight", "reference", "note", "project", "review"]).nullable().optional()
        .describe("Filter artifacts by kind"),
      artifact_source: z.enum(["web", "obsidian", "mcp", "telegram"]).nullable().optional()
        .describe("Filter artifacts by source"),
      limit: limitParam(10, 50),
    }),
    examples: [
      {
        input: { query: "sleep quality" },
        behavior: "Returns both journal entries and artifacts about sleep quality, merged by RRF score",
      },
      {
        input: { query: "dopamine", content_types: ["knowledge_artifact"] },
        behavior: "Searches only knowledge artifacts for dopamine content",
      },
    ],
  },

  remember: {
    name: "remember" as const,
    annotations: WRITE_IDEMPOTENT,
    description:
      "Store a single durable memory pattern. Use for explicit identity facts, recurring preferences, and active goals.",
    params: z.object({
      content: z.string().min(1).max(200).describe("Memory content to store"),
      kind: memoryKindParam,
      confidence: z.number().min(0).max(1).nullable().optional().describe("Optional confidence score (default: 0.8)"),
      evidence: z.string().nullable().optional().describe("Why this should be remembered"),
      entry_uuids: z.array(z.string()).nullable().optional().describe("Related journal entry UUIDs"),
      temporal: z.object({
        date: dateString.nullable().optional(),
        relevance: z.enum(["upcoming", "ongoing"]).nullable().optional(),
      }).nullable().optional().describe("Optional temporal metadata for future-relevant memories"),
    }),
    examples: [
      {
        input: { content: "Lives in Barcelona", kind: "identity", confidence: 0.95 },
        behavior: "Stores or reinforces a durable identity memory",
      },
      {
        input: { content: "Wants to reach B2 Spanish by June", kind: "goal" },
        behavior: "Stores an active intention for future recall",
      },
    ],
  },

  save_chat: {
    name: "save_chat" as const,
    annotations: WRITE_ADDITIVE,
    description:
      "Extract and store up to 5 memory patterns from a conversation transcript using memory-v2 quality gates.",
    params: z.object({
      messages: z.string().min(1).describe("Conversation transcript"),
      context: z.string().nullable().optional().describe("Optional extraction context hint"),
    }),
    examples: [
      {
        input: {
          messages: "User: I live in Barcelona now. User: My goal is B2 Spanish by June.",
          context: "Spanish coaching session",
        },
        behavior: "Extracts identity/goal patterns and stores or reinforces them",
      },
    ],
  },

  recall: {
    name: "recall" as const,
    annotations: READ_ONLY,
    description:
      "Search memory patterns using hybrid semantic + text retrieval with memory-aware ranking.",
    params: z.object({
      query: z.string().min(1).describe("Memory search query"),
      kinds: z.array(memoryKindParam).nullable().optional().describe("Optional kind filters"),
      limit: limitParam(10, 20),
    }),
    examples: [
      {
        input: { query: "language preferences", kinds: ["preference"] },
        behavior: "Returns relevant preference memories about language use",
      },
    ],
  },

  reflect: {
    name: "reflect" as const,
    annotations: WRITE_IDEMPOTENT,
    description:
      "Memory maintenance utility: review stats, stale memories, or run consolidation on overlapping patterns.",
    params: z.object({
      action: z.enum(["consolidate", "review_stale", "stats"]),
      kind: memoryKindParam.nullable().optional().describe("Optional kind scope"),
    }),
    examples: [
      {
        input: { action: "stats" },
        behavior: "Returns memory counts by kind/status and confidence summary",
      },
      {
        input: { action: "review_stale", kind: "goal" },
        behavior: "Lists stale goals not seen in 90+ days",
      },
    ],
  },

  list_todos: {
    name: "list_todos" as const,
    annotations: READ_ONLY,
    description:
      "List todos with filtering by status, Eisenhower quadrant (urgent/important), parent, or focus. " +
      "Supports include_children to load subtasks inline.",
    params: z.object({
      status: z.enum(["active", "waiting", "done", "someday"]).nullable().optional().describe("Filter by status"),
      urgent: z.boolean().nullable().optional().describe("Filter by urgency"),
      important: z.boolean().nullable().optional().describe("Filter by importance"),
      parent_id: z.string().nullable().optional().describe("Filter by parent ID, or 'root' for top-level only"),
      focus_only: z.boolean().nullable().optional().describe("Only return the current focus todo"),
      include_children: z.boolean().nullable().optional().describe("Include child todos inline"),
      limit: limitParam(20, 100),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    }),
    examples: [
      {
        input: { urgent: true, important: true, status: "active" },
        behavior: "Returns 'Do First' quadrant items that are active",
      },
      {
        input: { focus_only: true },
        behavior: "Returns the current 'One Thing' focus todo",
      },
      {
        input: { include_children: true, parent_id: "root" },
        behavior: "Returns top-level todos with their subtasks",
      },
    ],
  },

  create_todo: {
    name: "create_todo" as const,
    annotations: WRITE_ADDITIVE,
    description:
      "Create a new todo with optional Eisenhower urgency/importance flags and parent for subtasks. " +
      "Max 2 levels deep (parent must be root-level).",
    params: z.object({
      title: z.string().min(1).max(300).describe("Todo title"),
      status: z.enum(["active", "waiting", "done", "someday"]).nullable().optional().describe("Status (default: active)"),
      next_step: z.string().max(500).nullable().optional().describe("Current action step"),
      body: z.string().nullable().optional().describe("Markdown notes/context"),
      urgent: z.boolean().nullable().optional().describe("Is urgent (Eisenhower)"),
      important: z.boolean().nullable().optional().describe("Is important (Eisenhower)"),
      parent_id: z.string().nullable().optional().describe("Parent todo ID for subtasks"),
    }),
    examples: [
      {
        input: { title: "File Spanish taxes", urgent: true, important: true },
        behavior: "Creates a Do First quadrant todo",
      },
      {
        input: { title: "Send modelo 720 forms", parent_id: "abc-123" },
        behavior: "Creates a subtask under the parent todo",
      },
    ],
  },

  update_todo: {
    name: "update_todo" as const,
    annotations: WRITE_IDEMPOTENT,
    description:
      "Update a todo's fields. Auto-sets completed_at when status → done, clears it otherwise.",
    params: z.object({
      id: z.string().min(1).describe("Todo ID"),
      title: z.string().min(1).max(300).nullable().optional().describe("New title"),
      status: z.enum(["active", "waiting", "done", "someday"]).nullable().optional().describe("New status"),
      next_step: z.string().max(500).nullable().optional().describe("New next step (null to clear)"),
      body: z.string().nullable().optional().describe("New body"),
      urgent: z.boolean().nullable().optional().describe("Update urgency"),
      important: z.boolean().nullable().optional().describe("Update importance"),
    }),
    examples: [
      {
        input: { id: "abc-123", status: "done" },
        behavior: "Marks todo as done and auto-sets completed_at",
      },
    ],
  },

  complete_todo: {
    name: "complete_todo" as const,
    annotations: WRITE_IDEMPOTENT,
    description:
      "Mark a todo as done, set completed_at, and clear focus if it was the focus item. " +
      "Convenience shortcut for the common case.",
    params: z.object({
      id: z.string().min(1).describe("Todo ID to complete"),
    }),
    examples: [
      {
        input: { id: "abc-123" },
        behavior: "Sets status=done, completed_at=now, clears is_focus",
      },
    ],
  },

  sync_obsidian_vault: {
    name: "sync_obsidian_vault" as const,
    annotations: WRITE_IDEMPOTENT,
    description: "Manually trigger Obsidian vault sync from R2. Optionally sync a single file by path.",
    params: z.object({
      file_path: z.string().nullable().optional().describe("Sync only this vault-relative file path"),
    }),
    examples: [
      { input: {}, behavior: "Full vault sync, returns summary of files synced/deleted/errors" },
    ],
  },

  get_obsidian_sync_status: {
    name: "get_obsidian_sync_status" as const,
    annotations: READ_ONLY,
    description: "Get Obsidian vault sync status: last run, file count, pending embeddings",
    params: z.object({}),
    examples: [
      { input: {}, behavior: "Returns sync status with last run info, counts, pending embeddings" },
    ],
  },

  set_todo_focus: {
    name: "set_todo_focus" as const,
    annotations: WRITE_IDEMPOTENT,
    description:
      "Set or clear 'The One Thing' focus. Only one todo can be focus at a time. " +
      "Call with id to set, or with clear=true to unset.",
    params: z.object({
      id: z.string().nullable().optional().describe("Todo ID to set as focus"),
      clear: z.boolean().nullable().optional().describe("Set to true to clear focus without setting a new one"),
    }),
    examples: [
      {
        input: { id: "abc-123" },
        behavior: "Clears previous focus and sets this todo as The One Thing",
      },
      {
        input: { clear: true },
        behavior: "Clears the current focus without setting a new one",
      },
    ],
  },

  save_evening_review: {
    name: "save_evening_review" as const,
    annotations: WRITE_IDEMPOTENT,
    description:
      "Save the evening review entry as a knowledge artifact (kind: review). " +
      "If a review already exists for the given date, updates it instead of creating a duplicate. " +
      "Generates an embedding for semantic search after saving.",
    params: z.object({
      text: z.string().min(1).describe("The final evening review markdown text"),
      date: dateString.nullable().optional().describe(
        "Date for the review title (YYYY-MM-DD). Defaults to today. " +
        "Use yesterday's date if the session started before midnight but it's now past midnight."
      ),
    }),
    examples: [
      {
        input: { text: "**Nervous system**\nTired but grounded..." },
        behavior: "Creates a review artifact titled 'YYYY-MM-DD — Evening Checkin' with status pending, source mcp",
      },
      {
        input: { text: "Updated review text...", date: "2026-03-27" },
        behavior: "Upserts: updates existing review for 2026-03-27 if one exists, otherwise creates new",
      },
    ],
  },

} as const;

// ============================================================================
// Artifact result types
// ============================================================================

export interface ArtifactResult {
  id: string;
  kind: string;
  title: string;
  body: string;
  has_embedding: boolean;
  source_entry_uuids: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ArtifactSearchResult {
  id: string;
  kind: string;
  title: string;
  body: string;
  has_embedding: boolean;
  rrf_score: number;
  match_sources: ("semantic" | "fulltext")[];
  created_at: string;
  updated_at: string;
}

export interface UnifiedSearchResult {
  content_type: "journal_entry" | "knowledge_artifact";
  id: string;
  title_or_label: string;
  snippet: string;
  rrf_score: number;
  match_sources: ("semantic" | "fulltext")[];
}

// ============================================================================
// Type helpers for implementation
// ============================================================================

/** Union type of all tool names */
export type ToolName = keyof typeof toolSpecs;

/** Extract the params schema for a given tool */
export type ToolParams<T extends ToolName> = z.infer<
  (typeof toolSpecs)[T]["params"]
>;

/** Get all tool names as an array (useful for registration loops) */
export const allToolNames = Object.keys(toolSpecs) as ToolName[];

/**
 * Convert a tool spec to the MCP SDK's tool registration format.
 * Used by src/server.ts to register tools.
 */
export function toMcpToolDefinition(name: ToolName) {
  const spec = toolSpecs[name];
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: zodToJsonSchema(spec.params),
  };
}

/**
 * Convert a tool spec to the Anthropic SDK's tool definition format.
 * Used by the agent module to register tools with Claude.
 */
export function toAnthropicToolDefinition(name: ToolName): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
} {
  const spec = toolSpecs[name];
  return {
    name: spec.name,
    description: spec.description,
    input_schema: zodToJsonSchema(spec.params),
  };
}

/**
 * Recursively strip null values from an input object (null keys are omitted).
 * MCP clients send null for omitted optional params, but zod .optional()
 * rejects null. The schemas accept null via .nullable() for SDK validation,
 * but we strip nulls here so handlers receive clean T | undefined types.
 */
function stripNulls(input: unknown): unknown {
  if (input === null || input === undefined) return undefined;
  if (Array.isArray(input)) return input.map(stripNulls);
  if (typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>
    )) {
      if (value !== null) {
        result[key] =
          typeof value === "object" ? stripNulls(value) : value;
      }
    }
    return result;
  }
  return input;
}

/** Recursively strip null from a type at all levels. */
type DeepStripNull<T> = T extends null
  ? never
  : T extends (infer U)[]
    ? DeepStripNull<U>[]
    : T extends object
      ? { [K in keyof T]: DeepStripNull<T[K]> }
      : T;

/**
 * Validate tool input at runtime using the spec's zod schema.
 * Strips null values before parsing so handlers receive clean T | undefined types.
 * Throws ZodError with actionable messages if validation fails.
 */
export function validateToolInput<T extends ToolName>(
  name: T,
  input: unknown
): DeepStripNull<ToolParams<T>> {
  return toolSpecs[name].params.parse(stripNulls(input)) as DeepStripNull<
    ToolParams<T>
  >;
}

// ============================================================================
// Zod → JSON Schema conversion (minimal, for MCP SDK registration)
// ============================================================================

/**
 * Lightweight zod-to-JSON-Schema converter.
 *
 * The MCP SDK expects JSON Schema for tool inputSchema. Rather than pulling
 * in a full zod-to-json-schema library, this handles the subset we use:
 * objects, strings, numbers, booleans, arrays, optional fields, defaults,
 * descriptions, and regex patterns.
 *
 * If this becomes insufficient, replace with `zod-to-json-schema` package.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap ZodDefault
  if (schema instanceof z.ZodDefault) {
    const inner = zodToJsonSchema(schema._def.innerType);
    return { ...inner, default: schema._def.defaultValue() };
  }

  // Unwrap ZodOptional
  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema._def.innerType);
  }

  // Unwrap ZodNullable
  if (schema instanceof z.ZodNullable) {
    return zodToJsonSchema(schema._def.innerType);
  }

  // ZodObject
  if (schema instanceof z.ZodObject) {
    const shape = schema._def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodTypeAny);
      // A field is required if it's not optional and has no default
      if (
        !(value instanceof z.ZodOptional) &&
        !(value instanceof z.ZodDefault)
      ) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  // ZodString
  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: "string" };
    if (schema.description) result.description = schema.description;
    for (const check of schema._def.checks) {
      if (check.kind === "regex") result.pattern = check.regex.source;
      if (check.kind === "min") result.minLength = check.value;
    }
    return result;
  }

  // ZodNumber
  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: "number" };
    if (schema.description) result.description = schema.description;
    for (const check of schema._def.checks) {
      if (check.kind === "min") result.minimum = check.value;
      if (check.kind === "max") result.maximum = check.value;
      if (check.kind === "int") result.type = "integer";
    }
    return result;
  }

  // ZodBoolean
  if (schema instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: "boolean" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  // ZodEnum
  if (schema instanceof z.ZodEnum) {
    const result: Record<string, unknown> = {
      type: "string",
      enum: schema._def.values,
    };
    if (schema.description) result.description = schema.description;
    return result;
  }

  // ZodArray
  if (schema instanceof z.ZodArray) {
    return {
      type: "array",
      items: zodToJsonSchema(schema._def.type),
      ...(schema.description ? { description: schema.description } : {}),
    };
  }

  // Fallback
  return {};
}
