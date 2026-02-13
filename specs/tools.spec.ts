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
  starred: boolean;
  is_pinned: boolean;
  template_name?: string;
  tags: string[];
  weather?: {
    temperature?: number;
    conditions?: string;
    humidity?: number;
  };
  activity?: {
    name?: string;
    step_count?: number;
  };
  media_counts: {
    photos: number;
    videos: number;
    audios: number;
  };
  editing_time?: number;
  word_count: number;
}

export interface SearchResult {
  uuid: string;
  created_at: string;
  preview: string;
  city?: string;
  starred: boolean;
  tags: string[];
  rrf_score: number;
  match_sources: ("semantic" | "fulltext")[];
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

export interface SimilarResult {
  uuid: string;
  created_at: string;
  preview: string;
  city?: string;
  tags: string[];
  similarity_score: number;
}

// ============================================================================
// Tool definitions
// ============================================================================

export const toolSpecs = {
  search_entries: {
    name: "search_entries" as const,
    description:
      "Hybrid semantic + keyword search across journal entries using Reciprocal Rank Fusion (BM25 full-text + vector cosine similarity). " +
      "Finds entries by meaning even when exact words don't match. " +
      "Supports optional filtering by date range, tags, city, and starred status. " +
      "Entries often contain somatic check-ins, sleep/readiness scores, and body-state reflections that can be cross-referenced with health and biometric data.",
    params: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Natural language or keyword search query. Searches both semantically (meaning) and lexically (exact words)."
        ),
      date_from: dateString
        .optional()
        .describe("Filter entries from this date, inclusive"),
      date_to: dateString
        .optional()
        .describe("Filter entries up to this date, inclusive"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter to entries with any of these tags"),
      city: z.string().optional().describe("Filter by city name"),
      starred: z
        .boolean()
        .optional()
        .describe("Filter to starred entries only"),
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
        input: { query: "morning routine", tags: ["5-minute-am"] },
        behavior:
          "Searches within tagged entries for semantic match on morning routines",
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
    description:
      "Get a single journal entry by its UUID with full text, all metadata, tags, weather, location, and media counts. " +
      "Returns structured data including nested weather, activity, and location objects.",
    params: z.object({
      uuid: z.string().min(1).describe("The unique entry identifier"),
    }),
    examples: [
      {
        input: { uuid: "ABC123-DEF456" },
        behavior:
          "Returns full entry with text, location, weather, tags, media counts, and editing time",
      },
    ],
  },

  get_entries_by_date: {
    name: "get_entries_by_date" as const,
    description:
      "Get all entries within a date range, ordered chronologically. Use for reviewing a specific period. " +
      "Entries include somatic reflections and self-reported health data — consider cross-referencing with biometric sources for a complete picture.",
    params: z.object({
      date_from: dateString.describe("Start of date range, inclusive"),
      date_to: dateString.describe("End of date range, inclusive"),
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
    description:
      "Find entries written on a specific calendar day (MM-DD) across all years. " +
      "Great for year-over-year reflection and seeing how your thinking has evolved. " +
      "Returns full entry data including weather, activity, and health reflections.",
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

  list_tags: {
    name: "list_tags" as const,
    description:
      "List all unique tags used across journal entries, with usage counts, ordered by frequency (most used first).",
    params: z.object({}),
    examples: [
      {
        input: {},
        behavior:
          'Returns array of {name, count} like [{name: "morning-review", count: 342}, {name: "reflection", count: 201}, ...]',
      },
    ],
  },

  entry_stats: {
    name: "entry_stats" as const,
    description:
      "Get writing statistics: total entries, word count trends, writing frequency by day of week and month, " +
      "average entry length, longest writing streak, and current streak. " +
      "Optionally filter to a date range.",
    params: z.object({
      date_from: dateString
        .optional()
        .describe("Start of date range for stats calculation"),
      date_to: dateString
        .optional()
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
} as const;

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
 * Validate tool input at runtime using the spec's zod schema.
 * Throws ZodError with actionable messages if validation fails.
 */
export function validateToolInput<T extends ToolName>(
  name: T,
  input: unknown
): ToolParams<T> {
  return toolSpecs[name].params.parse(input) as ToolParams<T>;
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
