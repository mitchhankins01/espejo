import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type pg from "pg";
import { toolSpecs } from "../specs/tools.spec.js";
import { handleSearchEntries } from "./tools/search.js";
import { handleGetEntry } from "./tools/get-entry.js";
import { handleGetEntriesByDate } from "./tools/get-entries-by-date.js";
import { handleOnThisDay } from "./tools/on-this-day.js";
import { handleFindSimilar } from "./tools/find-similar.js";
import { handleEntryStats } from "./tools/entry-stats.js";
import { handleGetOuraSummary } from "./tools/get-oura-summary.js";
import { handleGetOuraWeekly } from "./tools/get-oura-weekly.js";
import { handleGetOuraTrends } from "./tools/get-oura-trends.js";
import { handleGetOuraAnalysis } from "./tools/get-oura-analysis.js";
import { handleOuraComparePeriods } from "./tools/oura-compare-periods.js";
import { handleOuraCorrelate } from "./tools/oura-correlate.js";
import { handleGetArtifact } from "./tools/get-artifact.js";
import { handleListArtifacts } from "./tools/list-artifacts.js";
import { handleSearchArtifacts } from "./tools/search-artifacts.js";
import { handleSearchContent } from "./tools/search-content.js";
import { handleSyncObsidianVault } from "./tools/sync-obsidian-vault.js";
import { handleGetObsidianSyncStatus } from "./tools/get-obsidian-sync-status.js";
import { handleSaveEveningReview } from "./tools/save-evening-review.js";
import { handleLogWeights } from "./tools/log-weights.js";
import { handleEveningReviewPrompt } from "./prompts/evening-review.js";

/** Tool handlers can return a plain string or a rich CallToolResult with audience annotations. */
export type ToolResult = string | CallToolResult;
export type ToolHandler = (pool: pg.Pool, input: unknown) => Promise<ToolResult>;

export const toolHandlers: Record<string, ToolHandler> = {
  search_entries: handleSearchEntries,
  get_entry: handleGetEntry,
  get_entries_by_date: handleGetEntriesByDate,
  on_this_day: handleOnThisDay,
  find_similar: handleFindSimilar,
  entry_stats: handleEntryStats,
  get_oura_summary: handleGetOuraSummary,
  get_oura_weekly: handleGetOuraWeekly,
  get_oura_trends: handleGetOuraTrends,
  get_oura_analysis: handleGetOuraAnalysis,
  oura_compare_periods: handleOuraComparePeriods,
  oura_correlate: handleOuraCorrelate,
  get_artifact: handleGetArtifact,
  list_artifacts: handleListArtifacts,
  search_artifacts: handleSearchArtifacts,
  search_content: handleSearchContent,
  sync_obsidian_vault: handleSyncObsidianVault,
  get_obsidian_sync_status: handleGetObsidianSyncStatus,
  save_evening_review: handleSaveEveningReview,
  log_weights: handleLogWeights,
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
        annotations: spec.annotations,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await handler(pool, args);
          // Rich result: handler already built content with audience annotations
          if (typeof result !== "string") return result;
          return {
            content: [{ type: "text" as const, text: result }],
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

  // Register prompts
  server.registerPrompt(
    "evening-review",
    {
      title: "Evening Review",
      description:
        "Start an evening review session with 7 days of journal context, past reviews, Oura biometrics, and weight data.",
    },
    async () => handleEveningReviewPrompt(pool)
  );

  return server;
}
