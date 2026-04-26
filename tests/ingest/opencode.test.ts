import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readOpencodeSessions } from "../../src/ingest/opencode.js";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "oc-test-"));
  dbPath = join(tmp, "opencode.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  // Espejo project + session
  db.prepare("INSERT INTO project VALUES (?, ?, ?, ?)").run(
    "p1",
    "/Users/mitch/Projects/espejo",
    Date.now(),
    Date.now()
  );
  // Non-espejo project
  db.prepare("INSERT INTO project VALUES (?, ?, ?, ?)").run(
    "p2",
    "/Users/mitch/Projects/greenline",
    Date.now(),
    Date.now()
  );
  db.prepare(
    "INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)"
  ).run("s1", "p1", "/Users/mitch/Projects/espejo", "test", 1700000000000, 1700000060000);
  db.prepare(
    "INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)"
  ).run("s2", "p2", "/Users/mitch/Projects/greenline", "ignore", 1700000000000, 1700000060000);
  // user message + tool part
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "m1",
    "s1",
    1700000010000,
    1700000010000,
    JSON.stringify({ role: "user", model: "claude-haiku-4-5" })
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "pt1",
    "m1",
    "s1",
    1700000011000,
    1700000011000,
    JSON.stringify({ type: "text", text: "hi opencode" })
  );
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "m2",
    "s1",
    1700000020000,
    1700000020000,
    JSON.stringify({ role: "assistant", model: "claude-haiku-4-5" })
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "pt2",
    "m2",
    "s1",
    1700000021000,
    1700000021000,
    JSON.stringify({
      type: "tool",
      tool: "glob",
      callID: "c1",
      state: { status: "completed", input: { pattern: "**/*.md" }, output: "5 files" },
    })
  );
  // failed tool
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "pt3",
    "m2",
    "s1",
    1700000022000,
    1700000022000,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      callID: "c2",
      state: { status: "error", input: { command: "false" }, output: "exit 1" },
    })
  );
  // malformed part — should be tolerated
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "pt4",
    "m2",
    "s1",
    1700000023000,
    1700000023000,
    "not json"
  );
  db.close();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readOpencodeSessions", () => {
  it("returns empty when db doesn't exist", () => {
    expect(readOpencodeSessions({ dbPath: join(tmp, "missing.db") })).toEqual([]);
  });

  it("filters to espejo sessions and parses tool calls", () => {
    const rows = readOpencodeSessions({ dbPath });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.surface).toBe("opencode");
    expect(r.session_id).toBe("s1");
    expect(r.project_path).toBe("/Users/mitch/Projects/espejo");
    expect(r.user_msg_count).toBe(1);
    expect(r.message_count).toBe(2);
    expect(r.tool_call_count).toBe(2);
    expect(r.tools_used.sort()).toEqual(["bash", "glob"]);
    expect(r.models).toEqual(["claude-haiku-4-5"]);
    expect(r.prompts).toHaveLength(1);
    const okFlags = r.tool_calls.map((c) => (c as { ok: boolean }).ok);
    expect(okFlags).toEqual([true, false]);
    expect(r.transcript_uri).toContain("session=s1");
  });

  it("respects sinceUpdated watermark", () => {
    const all = readOpencodeSessions({ dbPath });
    expect(all).toHaveLength(1);
    const empty = readOpencodeSessions({ dbPath, sinceUpdated: new Date(2_000_000_000_000) });
    expect(empty).toEqual([]);
  });
});
