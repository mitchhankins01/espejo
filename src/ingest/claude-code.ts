import { readdirSync, statSync, createReadStream, existsSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import { createInterface } from "readline";
import {
  type AgentSessionRow,
  type Prompt,
  type ToolCall,
  truncateArgs,
  truncateString,
  isEspejoPath,
  categorizeSession,
  MAX_ERROR_BYTES,
  MAX_PROMPT_BYTES,
} from "./types.js";

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Decode a Claude Code project dir name into a path. Format is
 * `-Users-mitch-Projects-espejo` for `/Users/mitch/Projects/espejo`.
 * The leading `-` becomes `/`; subsequent `-` become `/`.
 *
 * NOTE: this is a best-effort reverse — paths containing literal `-`
 * round-trip ambiguously. Sessions also carry the canonical `cwd` in
 * each line, which we prefer when present.
 */
export function decodeProjectDir(name: string): string {
  return "/" + name.replace(/^-/, "").replace(/-/g, "/");
}

/**
 * List espejo-relevant project dirs under ~/.claude/projects.
 * Returns absolute paths to dirs whose decoded name matches the espejo filter.
 */
export function listEspejoProjectDirs(projectsDir: string = CLAUDE_PROJECTS_DIR): string[] {
  if (!existsSync(projectsDir)) return [];
  const entries = readdirSync(projectsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && isEspejoPath(decodeProjectDir(e.name)))
    .map((e) => join(projectsDir, e.name));
}

/**
 * Scan a project dir for jsonl session files. Returns absolute paths plus
 * mtime, optionally filtered by `sinceMtime`.
 */
export function listSessionFiles(
  projectDir: string,
  sinceMtime?: Date | null
): { path: string; mtime: Date }[] {
  if (!existsSync(projectDir)) return [];
  const entries = readdirSync(projectDir, { withFileTypes: true });
  const files: { path: string; mtime: Date }[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const p = join(projectDir, e.name);
    const st = statSync(p);
    if (sinceMtime && st.mtimeMs <= sinceMtime.getTime()) continue;
    files.push({ path: p, mtime: st.mtime });
  }
  return files;
}

/**
 * Parse a single Claude Code jsonl session file into an AgentSessionRow.
 *
 * - Tracks `tool_use` parts in assistant messages and matches them to
 *   `tool_result` parts in subsequent user messages by `tool_use_id`.
 * - Extracts user prompts (string-content user messages, NOT tool_result arrays).
 * - Populates models, started_at, ended_at, counts.
 *
 * Streams the file line-by-line so multi-MB jsonls don't OOM.
 */
export async function parseClaudeCodeSessionFile(
  filePath: string,
  fileMtime: Date
): Promise<AgentSessionRow | null> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const sessionId = basename(filePath, ".jsonl");
  let projectPath: string | null = null;
  let firstTs: Date | null = null;
  let lastTs: Date | null = null;
  let messageCount = 0;
  let userMsgCount = 0;
  const prompts: Prompt[] = [];
  const toolCalls: ToolCall[] = [];
  const toolUseIndex = new Map<string, number>(); // tool_use_id → index in toolCalls
  const tools = new Set<string>();
  const models = new Set<string>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate single corrupt line
    }
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;

    // Track timestamps + cwd
    if (typeof o.timestamp === "string") {
      const ts = new Date(o.timestamp);
      if (!Number.isNaN(ts.getTime())) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (!lastTs || ts > lastTs) lastTs = ts;
      }
    }
    if (!projectPath && typeof o.cwd === "string") projectPath = o.cwd;

    const type = o.type;
    if (type === "assistant") {
      messageCount++;
      const message = o.message as Record<string, unknown> | undefined;
      if (message && typeof message.model === "string") models.add(message.model);
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p.type === "tool_use" && typeof p.name === "string" && typeof p.id === "string") {
            const { value, truncated } = truncateArgs(p.input);
            const ts = typeof o.timestamp === "string" ? o.timestamp : new Date().toISOString();
            toolUseIndex.set(p.id, toolCalls.length);
            toolCalls.push({
              name: p.name,
              args: value,
              ok: true, // updated when matching tool_result lands
              ts,
              ...(truncated ? { truncated: true } : {}),
            });
            tools.add(p.name);
          }
        }
      }
    } else if (type === "user") {
      messageCount++;
      const message = o.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (typeof content === "string") {
        // Real user prompt
        userMsgCount++;
        const ts = typeof o.timestamp === "string" ? o.timestamp : new Date().toISOString();
        prompts.push({ ts, text: truncateString(content, MAX_PROMPT_BYTES) });
      } else if (Array.isArray(content)) {
        // tool_result array — match each to its tool_use entry
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p.type === "tool_result" && typeof p.tool_use_id === "string") {
            const idx = toolUseIndex.get(p.tool_use_id);
            if (idx !== undefined) {
              toolCalls[idx].ok = !p.is_error;
              if (p.is_error && typeof p.content === "string") {
                toolCalls[idx].error = truncateString(p.content, MAX_ERROR_BYTES);
              }
            }
          }
        }
      }
    }
    // Other types (system, attachment, file-history-snapshot, last-prompt,
    // permission-mode, queue-operation) are intentionally ignored.
  }

  // If we never saw a usable timestamp, fall back to file mtime (better than nothing).
  if (!firstTs) firstTs = fileMtime;
  if (!lastTs) lastTs = fileMtime;

  const project_path = projectPath ?? "(unknown)";
  const tools_used = [...tools].sort();
  const category = categorizeSession({
    project_path,
    prompts,
    tool_calls: toolCalls,
    tools_used,
    message_count: messageCount,
    tool_call_count: toolCalls.length,
  });

  return {
    surface: "claude-code",
    session_id: sessionId,
    project_path,
    category,
    started_at: firstTs,
    ended_at: lastTs,
    message_count: messageCount,
    user_msg_count: userMsgCount,
    tool_call_count: toolCalls.length,
    tools_used,
    tool_calls: toolCalls,
    prompts,
    models: [...models].sort(),
    transcript_uri: filePath,
    source_mtime: fileMtime,
  };
}
