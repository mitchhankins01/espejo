import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import {
  upsertSession,
  latestSourceMtime,
  latestIngestedAt,
  type AgentSessionRow,
} from "../../src/db/queries/agent-sessions.js";

function makeRow(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    surface: "claude-code",
    session_id: "session-1",
    project_path: "/Users/mitch/Projects/espejo",
    started_at: new Date("2026-04-26T10:00:00.000Z"),
    ended_at: new Date("2026-04-26T10:30:00.000Z"),
    message_count: 5,
    user_msg_count: 2,
    tool_call_count: 3,
    tools_used: ["Read", "Bash"],
    tool_calls: [
      { name: "Read", args: { file_path: "/x" }, ok: true, ts: "2026-04-26T10:01:00.000Z" },
    ],
    prompts: [{ ts: "2026-04-26T10:00:00.000Z", text: "hi" }],
    models: ["claude-opus-4-7"],
    transcript_uri: "/tmp/session.jsonl",
    source_mtime: new Date("2026-04-26T10:30:00.000Z"),
    ...overrides,
  };
}

describe("agent_sessions queries", () => {
  it("upsertSession inserts a new row", async () => {
    await upsertSession(pool, makeRow());
    const r = await pool.query("SELECT * FROM agent_sessions WHERE session_id = $1", ["session-1"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].surface).toBe("claude-code");
    expect(r.rows[0].message_count).toBe(5);
    expect(r.rows[0].tools_used).toEqual(["Read", "Bash"]);
  });

  it("upsertSession updates on conflict (same surface + session_id)", async () => {
    await upsertSession(pool, makeRow({ message_count: 5 }));
    await upsertSession(
      pool,
      makeRow({ message_count: 10, ended_at: new Date("2026-04-26T11:00:00.000Z") })
    );
    const r = await pool.query("SELECT * FROM agent_sessions WHERE session_id = $1", ["session-1"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].message_count).toBe(10);
    expect(new Date(r.rows[0].ended_at).toISOString()).toBe("2026-04-26T11:00:00.000Z");
  });

  it("upsertSession differentiates by surface", async () => {
    await upsertSession(pool, makeRow({ surface: "claude-code", session_id: "shared-id" }));
    await upsertSession(pool, makeRow({ surface: "opencode", session_id: "shared-id" }));
    await upsertSession(pool, makeRow({ surface: "codex", session_id: "shared-id" }));
    const r = await pool.query("SELECT surface FROM agent_sessions WHERE session_id = $1 ORDER BY surface", ["shared-id"]);
    expect(r.rows.map((x) => x.surface)).toEqual(["claude-code", "codex", "opencode"]);
  });

  it("latestSourceMtime returns the newest source_mtime per surface", async () => {
    await upsertSession(pool, makeRow({ session_id: "s-old", source_mtime: new Date("2026-04-01") }));
    await upsertSession(pool, makeRow({ session_id: "s-new", source_mtime: new Date("2026-04-26") }));
    await upsertSession(pool, makeRow({ surface: "opencode", session_id: "oc-1", source_mtime: new Date("2026-04-15") }));

    const cc = await latestSourceMtime(pool, "claude-code");
    expect(cc?.toISOString()).toBe("2026-04-26T00:00:00.000Z");
    const oc = await latestSourceMtime(pool, "opencode");
    expect(oc?.toISOString()).toBe("2026-04-15T00:00:00.000Z");
    const cx = await latestSourceMtime(pool, "codex");
    expect(cx).toBeNull();
  });

  it("latestIngestedAt returns the newest ingest across all surfaces", async () => {
    expect(await latestIngestedAt(pool)).toBeNull();
    await upsertSession(pool, makeRow());
    const after = await latestIngestedAt(pool);
    expect(after).toBeInstanceOf(Date);
    expect(after!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});
