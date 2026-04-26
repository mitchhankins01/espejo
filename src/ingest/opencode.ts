import Database from "better-sqlite3";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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

export const OPENCODE_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");

interface OcSession {
  id: string;
  directory: string;
  worktree: string | null;
  title: string | null;
  time_created: number;
  time_updated: number;
}

interface OcMessage {
  id: string;
  role: string;
  time_created: number;
  time_updated: number;
}

interface OcPart {
  message_id: string;
  message_role: string;
  message_time: number;
  data: string; // JSON
}

/**
 * Read sessions from opencode.db filtered to espejo-relevant paths.
 * Closes the DB before returning. Read-only.
 */
export function readOpencodeSessions(opts: {
  dbPath?: string;
  sinceUpdated?: Date | null;
}): AgentSessionRow[] {
  const dbPath = opts.dbPath ?? OPENCODE_DB_PATH;
  if (!existsSync(dbPath)) return [];

  const stat = statSync(dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const sinceMs = opts.sinceUpdated ? opts.sinceUpdated.getTime() : 0;

    const sessions = db
      .prepare(
        `SELECT s.id, s.directory, p.worktree, s.title, s.time_created, s.time_updated
           FROM session s
      LEFT JOIN project p ON s.project_id = p.id
          WHERE (s.directory LIKE '%espejo%' OR s.directory LIKE '%Artifacts%'
              OR p.worktree LIKE '%espejo%' OR p.worktree LIKE '%Artifacts%')
            AND s.time_updated > ?
       ORDER BY s.time_created`
      )
      .all(sinceMs) as OcSession[];

    if (sessions.length === 0) return [];

    const partsStmt = db.prepare<[string], OcPart>(
      `SELECT p.message_id        AS message_id,
              json_extract(m.data, '$.role') AS message_role,
              m.time_created       AS message_time,
              p.data               AS data
         FROM part p
         JOIN message m ON p.message_id = m.id
        WHERE p.session_id = ?
     ORDER BY p.time_created`
    );

    const rows: AgentSessionRow[] = [];
    for (const s of sessions) {
      const projectPath =
        (s.worktree && isEspejoPath(s.worktree) ? s.worktree : s.directory) ||
        s.directory ||
        "(unknown)";
      const startedAt = new Date(s.time_created);
      const endedAt = new Date(s.time_updated);

      const prompts: Prompt[] = [];
      const toolCalls: ToolCall[] = [];
      const tools = new Set<string>();
      const models = new Set<string>();
      let messageCount = 0;
      let userMsgCount = 0;
      const seenMessages = new Set<string>();

      const parts = partsStmt.all(s.id);
      for (const p of parts) {
        if (!seenMessages.has(p.message_id)) {
          seenMessages.add(p.message_id);
          messageCount++;
          if (p.message_role === "user") userMsgCount++;
        }

        let pd: Record<string, unknown>;
        try {
          pd = JSON.parse(p.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const ptype = pd.type;
        if (ptype === "text" && typeof pd.text === "string" && p.message_role === "user") {
          prompts.push({
            ts: new Date(p.message_time).toISOString(),
            text: truncateString(pd.text, MAX_PROMPT_BYTES),
          });
        } else if (ptype === "tool" && typeof pd.tool === "string") {
          const state = (pd.state ?? {}) as Record<string, unknown>;
          const status = typeof state.status === "string" ? state.status : "unknown";
          const ok = status === "completed";
          const { value, truncated } = truncateArgs(state.input);
          const ts = new Date(p.message_time).toISOString();
          toolCalls.push({
            name: pd.tool,
            args: value,
            ok,
            ts,
            ...(!ok && typeof state.output === "string"
              ? { error: truncateString(state.output, MAX_ERROR_BYTES) }
              : {}),
            ...(truncated ? { truncated: true } : {}),
          });
          tools.add(pd.tool);
        }
      }

      // Per-message model from message.data — fetch separately to keep parts
      // query simple. Use a single query per session.
      const msgs = db
        .prepare<[string], OcMessage>(
          `SELECT id,
                  json_extract(data, '$.role')  AS role,
                  json_extract(data, '$.model') AS model,
                  time_created,
                  time_updated
             FROM message
            WHERE session_id = ?`
        )
        .all(s.id);
      for (const m of msgs) {
        const model = (m as unknown as { model?: string }).model;
        if (typeof model === "string" && model) models.add(model);
      }

      rows.push({
        surface: "opencode",
        session_id: s.id,
        project_path: projectPath,
        started_at: startedAt,
        ended_at: endedAt,
        message_count: messageCount,
        user_msg_count: userMsgCount,
        tool_call_count: toolCalls.length,
        tools_used: [...tools].sort(),
        tool_calls: toolCalls,
        prompts,
        models: [...models].sort(),
        transcript_uri: `${dbPath}#session=${s.id}`,
        source_mtime: stat.mtime,
      });
    }

    return rows;
  } finally {
    db.close();
  }
}
