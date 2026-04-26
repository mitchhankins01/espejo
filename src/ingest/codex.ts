import { existsSync, statSync, createReadStream, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline";
import {
  type AgentSessionRow,
  type Prompt,
  type ToolCall,
  truncateArgs,
  truncateString,
  isEspejoPath,
  MAX_ERROR_BYTES,
  MAX_PROMPT_BYTES,
} from "./types.js";

export const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

/**
 * Walk ~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl and yield paths
 * with their mtime, optionally filtered to those newer than `sinceMtime`.
 */
export function listCodexSessionFiles(opts: {
  sessionsDir?: string;
  sinceMtime?: Date | null;
}): { path: string; mtime: Date }[] {
  const root = opts.sessionsDir ?? CODEX_SESSIONS_DIR;
  if (!existsSync(root)) return [];
  const out: { path: string; mtime: Date }[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        const st = statSync(p);
        if (opts.sinceMtime && st.mtimeMs <= opts.sinceMtime.getTime()) continue;
        out.push({ path: p, mtime: st.mtime });
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Parse a single codex rollout jsonl into an AgentSessionRow.
 * Returns null if the file isn't a session rollout (no session_meta line)
 * OR if the session's cwd isn't espejo-relevant.
 *
 * Codex line shape: {timestamp, type, payload}
 *   type='session_meta' → start of session, has id + cwd
 *   type='response_item', payload.type='message' → user/assistant text
 *   type='response_item', payload.type='function_call' → tool call
 *   type='response_item', payload.type='function_call_output' → tool result
 */
export async function parseCodexSessionFile(
  filePath: string,
  fileMtime: Date
): Promise<AgentSessionRow | null> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | null = null;
  let projectPath: string | null = null;
  let firstTs: Date | null = null;
  let lastTs: Date | null = null;
  let messageCount = 0;
  let userMsgCount = 0;
  const prompts: Prompt[] = [];
  const toolCalls: ToolCall[] = [];
  const callIdIndex = new Map<string, number>();
  const tools = new Set<string>();
  const models = new Set<string>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;

    if (typeof o.timestamp === "string") {
      const ts = new Date(o.timestamp);
      if (!Number.isNaN(ts.getTime())) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (!lastTs || ts > lastTs) lastTs = ts;
      }
    }

    const payload = o.payload as Record<string, unknown> | undefined;
    if (o.type === "session_meta" && payload) {
      if (typeof payload.id === "string") sessionId = payload.id;
      if (typeof payload.cwd === "string") projectPath = payload.cwd;
    } else if (o.type === "turn_context" && payload) {
      if (typeof payload.model === "string") models.add(payload.model);
    } else if (o.type === "response_item" && payload) {
      const ptype = payload.type;
      if (ptype === "message") {
        messageCount++;
        const role = payload.role;
        const content = payload.content;
        if (role === "user" && Array.isArray(content)) {
          // content is an array of {type, text} blocks
          for (const c of content) {
            if (
              c &&
              typeof c === "object" &&
              (c as Record<string, unknown>).type === "input_text" &&
              typeof (c as Record<string, unknown>).text === "string"
            ) {
              userMsgCount++;
              const text = (c as Record<string, unknown>).text as string;
              const ts = typeof o.timestamp === "string" ? o.timestamp : new Date().toISOString();
              prompts.push({ ts, text: truncateString(text, MAX_PROMPT_BYTES) });
            }
          }
        }
      } else if (ptype === "function_call") {
        const name = typeof payload.name === "string" ? payload.name : "(unknown)";
        const callId = typeof payload.call_id === "string" ? payload.call_id : null;
        // Codex passes args as a JSON string in the OpenAI function-call style
        let args: unknown = payload.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            // Keep as string if not parseable
          }
        }
        const { value, truncated } = truncateArgs(args);
        const ts = typeof o.timestamp === "string" ? o.timestamp : new Date().toISOString();
        if (callId) callIdIndex.set(callId, toolCalls.length);
        toolCalls.push({
          name,
          args: value,
          ok: true,
          ts,
          ...(truncated ? { truncated: true } : {}),
        });
        tools.add(name);
      } else if (ptype === "function_call_output") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : null;
        if (callId !== null) {
          const idx = callIdIndex.get(callId);
          if (idx !== undefined) {
            const output = payload.output;
            // Codex output is often `{ output: string, metadata? }` or just a string.
            // Treat it as success unless we see an explicit error marker.
            if (typeof output === "string") {
              // Look for typical error markers
              if (/^error:|Error:/.test(output)) {
                toolCalls[idx].ok = false;
                toolCalls[idx].error = truncateString(output, MAX_ERROR_BYTES);
              }
            } else if (output && typeof output === "object") {
              const o2 = output as Record<string, unknown>;
              if (o2.error || o2.is_error) {
                toolCalls[idx].ok = false;
                toolCalls[idx].error = truncateString(JSON.stringify(o2), MAX_ERROR_BYTES);
              }
            }
          }
        }
      }
    }
  }

  if (!sessionId) return null;
  if (!projectPath || !isEspejoPath(projectPath)) return null;

  if (!firstTs) firstTs = fileMtime;
  if (!lastTs) lastTs = fileMtime;

  return {
    surface: "codex",
    session_id: sessionId,
    project_path: projectPath,
    started_at: firstTs,
    ended_at: lastTs,
    message_count: messageCount,
    user_msg_count: userMsgCount,
    tool_call_count: toolCalls.length,
    tools_used: [...tools].sort(),
    tool_calls: toolCalls,
    prompts,
    models: [...models].sort(),
    transcript_uri: filePath,
    source_mtime: fileMtime,
  };
}
