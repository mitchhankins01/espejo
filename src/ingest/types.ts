import type { AgentSessionRow, SessionSurface, SessionCategory } from "../db/queries/agent-sessions.js";

export type { AgentSessionRow, SessionSurface, SessionCategory };

export interface ToolCall {
  name: string;
  args: unknown; // truncated if needed
  ok: boolean;
  ts: string; // ISO 8601
  error?: string;
  truncated?: boolean;
}

export interface Prompt {
  ts: string;
  text: string;
}

export const MAX_TOOL_ARG_BYTES = 8 * 1024;
export const MAX_ERROR_BYTES = 500;
export const MAX_PROMPT_BYTES = 8 * 1024;

// ─── categorization ─────────────────────────────────────────────────────────

const ESPEJO_USE_TOOLS = new Set([
  "search_content",
  "search_entries",
  "search_artifacts",
  "get_entry",
  "get_artifact",
  "list_artifacts",
  "save_evening_review",
  "sync_obsidian_vault",
  "get_obsidian_sync_status",
  "log_weights",
  "find_similar",
  "get_entries_by_date",
  "on_this_day",
  "entry_stats",
  "get_oura_summary",
  "get_oura_weekly",
  "get_oura_trends",
  "get_oura_analysis",
  "oura_compare_periods",
  "oura_correlate",
]);

const DEV_PATH_RE = /\/(src|tests|specs|node_modules)\/|\/(package\.json|tsconfig|vitest|eslint|docker-compose)/;
const AUTOMATION_SIGNATURES_RE =
  /INPUT DATA|classification rubric|classify candidate|Output ONE JSON|---- INPUT|<INSTRUCTIONS>|# AGENTS\.md instructions/i;

/**
 * Classify a session row by intent. Used to filter at ingest so the table
 * stores reflection/self-exploration sessions, not dev work or automation noise.
 *
 * - reflection: vault-root, fired espejo MCP tools, or touched Artifacts/ in human conversation
 * - dev:        touched src/tests/specs and never Artifacts/, no espejo MCP calls
 * - automation: single huge prompt with classification/instructions language (council leg, programmatic invocation)
 * - throwaway:  near-empty (no tools + < 500 bytes of prompt text, or 0 prompts)
 * - mixed:      everything else (default)
 */
export function categorizeSession(input: {
  project_path: string;
  prompts: Prompt[];
  tool_calls: ToolCall[];
  tools_used: string[];
  message_count: number;
  tool_call_count: number;
}): SessionCategory {
  const totalPromptBytes = input.prompts.reduce((s, p) => s + p.text.length, 0);
  const promptCount = input.prompts.length;
  const firstPrompt = input.prompts[0]?.text ?? "";

  // Throwaway: barely any content
  if (promptCount === 0) return "throwaway";
  if (input.tool_call_count === 0 && totalPromptBytes < 500) return "throwaway";

  // Automation: programmatic invocation (one huge prompt with no follow-ups,
  // matches structured-output language)
  if (
    promptCount === 1 &&
    firstPrompt.length > 5000 &&
    AUTOMATION_SIGNATURES_RE.test(firstPrompt)
  ) {
    return "automation";
  }

  // Vault-root sessions are reflection by definition
  if (/\/Documents\/Artifacts/.test(input.project_path)) return "reflection";

  // Tool-pattern analysis for espejo-project sessions
  const toolsStr = JSON.stringify(input.tool_calls);
  const touchedArtifacts = /Artifacts\//.test(toolsStr);
  const touchedDev = DEV_PATH_RE.test(toolsStr);
  const calledEspejoMcp = input.tools_used.some((t) => {
    if (t.startsWith("mcp__claude_ai_Espejo") || t.startsWith("mcp__claude_ai_Oura")) return true;
    return ESPEJO_USE_TOOLS.has(t);
  });

  if (calledEspejoMcp) return "reflection";
  if (touchedArtifacts && !touchedDev) return "reflection";
  if (touchedDev && !touchedArtifacts) return "dev";
  if (touchedDev && touchedArtifacts) return "mixed";

  return "mixed";
}

/**
 * Serialize args to JSON; if over the cap, replace with a marker so the
 * row is bounded but the truncation is visible. Caller sets `truncated: true`
 * on the ToolCall.
 */
export function truncateArgs(
  args: unknown
): { value: unknown; truncated: boolean } {
  if (args === undefined || args === null) return { value: null, truncated: false };
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    return { value: { __unserializable: true }, truncated: true };
  }
  if (json.length <= MAX_TOOL_ARG_BYTES) return { value: args, truncated: false };
  return {
    value: { __truncated: true, original_bytes: json.length, preview: json.slice(0, MAX_TOOL_ARG_BYTES) },
    truncated: true,
  };
}

export function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[+${s.length - max} chars]`;
}

/**
 * Standard espejo-relevance filter: any path containing "espejo" or "Artifacts".
 * Used by both Claude Code (project dir name) and OpenCode (project.worktree / session.directory).
 */
export function isEspejoPath(path: string): boolean {
  return /espejo|Artifacts/i.test(path);
}
