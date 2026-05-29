import { tool, type ToolSet } from "ai";
import type pg from "pg";
import { toolHandlers, type ToolResult } from "../../server.js";
import { toolSpecs, type ToolName } from "../../../specs/tools.spec.js";

/** Tools available to the chat flow. */
export const FLOW_TOOL_NAMES: ToolName[] = [
  "search_content",
  "search_artifacts",
  "search_entries",
  "get_entries_by_date",
  "find_similar",
  "list_artifacts",
  "entry_stats",
  "get_artifact",
  "get_oura_summary",
  "get_oura_weekly",
  "get_oura_trends",
  "get_oura_analysis",
  "oura_compare_periods",
  "oura_correlate",
  "get_oura_intra_night_hrv",
  "get_oura_heartrate_slice",
  "get_obsidian_sync_status",
  "sync_obsidian_vault",
  "write_vault_artifact",
  "get_recent_checkpoints",
  "get_recent_weights",
  "get_oura_day_context",
  "get_recent_agent_chats",
  "get_recent_commits",
  "sync_oura",
];

function resolveToolResultText(result: ToolResult): string {
  if (typeof result === "string") return result;
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export function buildFlowTools(pool: pg.Pool): ToolSet {
  const set: ToolSet = {};
  for (const name of FLOW_TOOL_NAMES) {
    const spec = toolSpecs[name];
    const handler = toolHandlers[name];
    if (!handler) continue;
    set[name] = tool({
      description: spec.description,
      inputSchema: spec.params,
      execute: async (args: unknown) => {
        const raw = await handler(pool, args);
        return resolveToolResultText(raw);
      },
    });
  }
  return set;
}
