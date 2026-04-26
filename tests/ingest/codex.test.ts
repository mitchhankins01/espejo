import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listCodexSessionFiles,
  parseCodexSessionFile,
} from "../../src/ingest/codex.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cx-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeRollout(name: string, lines: unknown[]): string {
  const dir = join(tmp, "2026", "04", "26");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("listCodexSessionFiles", () => {
  it("returns empty for missing root", () => {
    expect(listCodexSessionFiles({ sessionsDir: join(tmp, "missing") })).toEqual([]);
  });

  it("walks year/month/day and returns jsonls only", () => {
    writeRollout("rollout-1", [{ type: "session_meta", payload: { id: "a", cwd: "/x" } }]);
    writeFileSync(join(tmp, "2026", "04", "26", "notes.txt"), "ignore");
    const r = listCodexSessionFiles({ sessionsDir: tmp });
    expect(r).toHaveLength(1);
    expect(r[0].path.endsWith("rollout-1.jsonl")).toBe(true);
  });
});

describe("parseCodexSessionFile", () => {
  it("parses an espejo session with one tool call", async () => {
    const path = writeRollout("rollout-x", [
      {
        type: "session_meta",
        timestamp: "2026-04-26T10:00:00.000Z",
        payload: { id: "session-uuid", cwd: "/Users/mitch/Projects/espejo" },
      },
      {
        type: "turn_context",
        timestamp: "2026-04-26T10:00:00.500Z",
        payload: { model: "gpt-5.5" },
      },
      {
        type: "response_item",
        timestamp: "2026-04-26T10:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello codex" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-04-26T10:00:02.000Z",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "call_1",
          arguments: '{"command":"ls"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2026-04-26T10:00:03.000Z",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "file1\nfile2",
        },
      },
    ]);
    const row = await parseCodexSessionFile(path, new Date("2026-04-26T10:00:04.000Z"));
    expect(row).not.toBeNull();
    expect(row!.surface).toBe("codex");
    expect(row!.session_id).toBe("session-uuid");
    expect(row!.project_path).toBe("/Users/mitch/Projects/espejo");
    expect(row!.tool_call_count).toBe(1);
    expect(row!.tools_used).toEqual(["shell"]);
    expect(row!.models).toEqual(["gpt-5.5"]);
    expect(row!.user_msg_count).toBe(1);
    expect((row!.tool_calls[0] as { ok: boolean }).ok).toBe(true);
  });

  it("returns null for non-espejo sessions", async () => {
    const path = writeRollout("rollout-other", [
      {
        type: "session_meta",
        timestamp: "2026-04-26T10:00:00.000Z",
        payload: { id: "other", cwd: "/Users/mitch/Projects/greenline" },
      },
    ]);
    const row = await parseCodexSessionFile(path, new Date());
    expect(row).toBeNull();
  });

  it("returns null when session_meta is missing", async () => {
    const path = writeRollout("rollout-no-meta", [
      { type: "event_msg", payload: { type: "task_started" } },
    ]);
    const row = await parseCodexSessionFile(path, new Date());
    expect(row).toBeNull();
  });

  it("flags errored tool output", async () => {
    const path = writeRollout("rollout-err", [
      {
        type: "session_meta",
        timestamp: "2026-04-26T10:00:00.000Z",
        payload: { id: "s2", cwd: "/Users/mitch/Projects/espejo" },
      },
      {
        type: "response_item",
        timestamp: "2026-04-26T10:00:01.000Z",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "c",
          arguments: '{"command":"false"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2026-04-26T10:00:02.000Z",
        payload: { type: "function_call_output", call_id: "c", output: "Error: nope" },
      },
    ]);
    const row = await parseCodexSessionFile(path, new Date());
    expect((row!.tool_calls[0] as { ok: boolean }).ok).toBe(false);
  });

  it("tolerates malformed args (non-JSON string)", async () => {
    const path = writeRollout("rollout-badargs", [
      {
        type: "session_meta",
        timestamp: "2026-04-26T10:00:00.000Z",
        payload: { id: "s3", cwd: "/Users/mitch/Documents/Artifacts" },
      },
      {
        type: "response_item",
        timestamp: "2026-04-26T10:00:01.000Z",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "c",
          arguments: "not-json",
        },
      },
    ]);
    const row = await parseCodexSessionFile(path, new Date());
    expect(row!.tool_call_count).toBe(1);
    expect(row!.tool_calls[0]).toMatchObject({ name: "shell", args: "not-json" });
  });
});
