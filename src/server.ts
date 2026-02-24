import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { toolSpecs } from "../specs/tools.spec.js";
import { handleSearchEntries } from "./tools/search.js";
import { handleGetEntry } from "./tools/get-entry.js";
import { handleGetEntriesByDate } from "./tools/get-entries-by-date.js";
import { handleOnThisDay } from "./tools/on-this-day.js";
import { handleFindSimilar } from "./tools/find-similar.js";
import { handleListTags } from "./tools/list-tags.js";
import { handleEntryStats } from "./tools/entry-stats.js";
import { handleLogWeight } from "./tools/log-weight.js";
import { handleConjugateVerb } from "./tools/conjugate-verb.js";
import { handleLogVocabulary } from "./tools/log-vocabulary.js";
import { handleSpanishQuiz } from "./tools/spanish-quiz.js";
import { handleGetOuraSummary } from "./tools/get-oura-summary.js";
import { handleGetOuraWeekly } from "./tools/get-oura-weekly.js";
import { handleGetOuraTrends } from "./tools/get-oura-trends.js";
import { handleGetOuraAnalysis } from "./tools/get-oura-analysis.js";
import { handleOuraComparePeriods } from "./tools/oura-compare-periods.js";
import { handleOuraCorrelate } from "./tools/oura-correlate.js";

export type ToolHandler = (pool: pg.Pool, input: unknown) => Promise<string>;

export const toolHandlers: Record<string, ToolHandler> = {
  search_entries: handleSearchEntries,
  get_entry: handleGetEntry,
  get_entries_by_date: handleGetEntriesByDate,
  on_this_day: handleOnThisDay,
  find_similar: handleFindSimilar,
  list_tags: handleListTags,
  entry_stats: handleEntryStats,
  log_weight: handleLogWeight,
  conjugate_verb: handleConjugateVerb,
  log_vocabulary: handleLogVocabulary,
  spanish_quiz: handleSpanishQuiz,
  get_oura_summary: handleGetOuraSummary,
  get_oura_weekly: handleGetOuraWeekly,
  get_oura_trends: handleGetOuraTrends,
  get_oura_analysis: handleGetOuraAnalysis,
  oura_compare_periods: handleOuraComparePeriods,
  oura_correlate: handleOuraCorrelate,
};

export function createServer(pool: pg.Pool, version: string): McpServer {
  const server = new McpServer({
    name: "espejo-mcp",
    version,
  });

  // Register each tool from the spec
  for (const [name, spec] of Object.entries(toolSpecs)) {
    const handler = toolHandlers[name];
    /* v8 ignore next -- defensive: all specs have handlers */
    if (!handler) continue;

    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.params,
      },
      async (args: Record<string, unknown>) => {
        try {
          const text = await handler(pool, args);
          return {
            content: [{ type: "text" as const, text }],
          };
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Unknown error occurred";
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}
