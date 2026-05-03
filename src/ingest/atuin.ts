import Database from "better-sqlite3";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const ATUIN_DB_PATH = join(
  homedir(),
  ".local",
  "share",
  "atuin",
  "history.db"
);

export const ATUIN_SOURCE = "shell";

/**
 * Drop any command whose text matches a likely-secret pattern. We can't see
 * what's safe vs. an inline `--token=...`, so the conservative move is to
 * skip the row entirely (we lose the verb but never log the secret).
 */
const SECRET_PATTERN = /(api[_-]?key|token|password|secret|bearer)\s*[=:]/i;

/** Cap on the recorded `cmd` field to keep the args JSONB payload bounded. */
const MAX_CMD_BYTES = 4096;

export interface AtuinShellRow {
  ts: Date;
  hostname: string;
  cwd: string;
  verb: string;
  cmd: string;
  exit: number;
  durationMs: number;
  atuinId: string;
  session: string;
}

export interface ReadAtuinHistoryOpts {
  dbPath?: string;
  /** Only return commands with ts strictly greater than this. */
  since?: Date | null;
}

interface AtuinHistoryDbRow {
  id: string;
  timestamp: number; // nanoseconds since epoch
  duration: number; // nanoseconds (can be -1 for unfinished commands)
  exit: number;
  command: string;
  cwd: string;
  session: string;
  hostname: string;
  deleted_at: number | null;
}

/**
 * Read shell history from atuin's local SQLite store. Read-only.
 *
 * Returns one row per command, with secret-bearing commands and
 * tombstoned (`deleted_at` set) rows filtered out.
 */
export function readAtuinHistory(
  opts: ReadAtuinHistoryOpts = {}
): AtuinShellRow[] {
  const dbPath = opts.dbPath ?? ATUIN_DB_PATH;
  if (!existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // atuin stores `timestamp` and `duration` as nanoseconds. The since filter
    // is applied in SQL so we don't pull the entire history into memory.
    const sinceNs = opts.since
      ? BigInt(opts.since.getTime()) * 1_000_000n
      : null;

    const stmt = sinceNs
      ? db.prepare(
          `SELECT id, timestamp, duration, exit, command, cwd, session, hostname, deleted_at
             FROM history
            WHERE deleted_at IS NULL AND timestamp > ?
         ORDER BY timestamp ASC`
        )
      : db.prepare(
          `SELECT id, timestamp, duration, exit, command, cwd, session, hostname, deleted_at
             FROM history
            WHERE deleted_at IS NULL
         ORDER BY timestamp ASC`
        );

    const rows = (
      sinceNs ? stmt.all(sinceNs.toString()) : stmt.all()
    ) as AtuinHistoryDbRow[];

    const out: AtuinShellRow[] = [];
    for (const r of rows) {
      const cmdRaw = r.command ?? "";
      if (!cmdRaw.trim()) continue;
      if (SECRET_PATTERN.test(cmdRaw)) continue;

      const ts = new Date(Number(BigInt(r.timestamp) / 1_000_000n));
      if (Number.isNaN(ts.getTime())) continue;

      // duration of -1 means the command never recorded an end (still running
      // or shell exited). Treat as 0 rather than a negative duration_ms.
      const durationMs =
        r.duration && r.duration > 0 ? Math.round(r.duration / 1_000_000) : 0;

      const cmd =
        cmdRaw.length > MAX_CMD_BYTES ? cmdRaw.slice(0, MAX_CMD_BYTES) : cmdRaw;
      const verb = cmdRaw.trim().split(/\s+/)[0] ?? "";

      out.push({
        ts,
        hostname: r.hostname ?? "",
        cwd: r.cwd ?? "",
        verb,
        cmd,
        exit: r.exit ?? 0,
        durationMs,
        atuinId: r.id,
        session: r.session ?? "",
      });
    }

    return out;
  } finally {
    db.close();
  }
}
