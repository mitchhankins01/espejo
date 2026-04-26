import type { AgentSessionRow, SessionSurface } from "../db/queries/agent-sessions.js";

export type { AgentSessionRow, SessionSurface };

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
