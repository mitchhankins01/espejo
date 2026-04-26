import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  decodeProjectDir,
  listEspejoProjectDirs,
  listSessionFiles,
  parseClaudeCodeSessionFile,
} from "../../src/ingest/claude-code.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("decodeProjectDir", () => {
  it("turns dashes back into slashes with a leading slash", () => {
    expect(decodeProjectDir("-Users-mitch-Projects-espejo")).toBe(
      "/Users/mitch/Projects/espejo"
    );
  });
  it("handles vault-root variant", () => {
    expect(decodeProjectDir("-Users-mitch-Documents-Artifacts")).toBe(
      "/Users/mitch/Documents/Artifacts"
    );
  });
});

describe("listEspejoProjectDirs", () => {
  it("returns nothing when the dir does not exist", () => {
    expect(listEspejoProjectDirs(join(tmp, "missing"))).toEqual([]);
  });

  it("filters to dirs whose decoded name matches espejo or Artifacts", () => {
    mkdirSync(join(tmp, "-Users-mitch-Projects-espejo"));
    mkdirSync(join(tmp, "-Users-mitch-Documents-Artifacts"));
    mkdirSync(join(tmp, "-Users-mitch-Projects-greenline"));
    const result = listEspejoProjectDirs(tmp).map((p) => p.split("/").pop()).sort();
    expect(result).toEqual([
      "-Users-mitch-Documents-Artifacts",
      "-Users-mitch-Projects-espejo",
    ]);
  });
});

describe("listSessionFiles", () => {
  it("returns nothing for a missing dir", () => {
    expect(listSessionFiles(join(tmp, "nope"))).toEqual([]);
  });

  it("returns jsonl files with mtime, filtered by sinceMtime", () => {
    const a = join(tmp, "a.jsonl");
    const b = join(tmp, "b.jsonl");
    const ignored = join(tmp, "c.txt");
    writeFileSync(a, "");
    writeFileSync(b, "");
    writeFileSync(ignored, "");
    // Force a.mtime older than b.mtime
    utimesSync(a, new Date("2026-01-01"), new Date("2026-01-01"));
    utimesSync(b, new Date("2026-04-01"), new Date("2026-04-01"));

    const all = listSessionFiles(tmp);
    expect(all).toHaveLength(2);

    const recent = listSessionFiles(tmp, new Date("2026-02-01"));
    expect(recent).toHaveLength(1);
    expect(recent[0].path.endsWith("b.jsonl")).toBe(true);
  });
});

describe("parseClaudeCodeSessionFile", () => {
  function writeJsonl(name: string, lines: unknown[]): string {
    const path = join(tmp, `${name}.jsonl`);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }

  it("parses a minimal session", async () => {
    const path = writeJsonl("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", [
      {
        type: "user",
        timestamp: "2026-04-26T10:00:00.000Z",
        cwd: "/Users/mitch/Projects/espejo",
        message: { content: "hello" },
      },
      {
        type: "assistant",
        timestamp: "2026-04-26T10:00:01.000Z",
        message: {
          model: "claude-opus-4-7",
          content: [
            { type: "text", text: "ok" },
            {
              type: "tool_use",
              id: "tu_1",
              name: "Read",
              input: { file_path: "/x" },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-04-26T10:00:02.000Z",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "file body", is_error: false },
          ],
        },
      },
    ]);
    const row = await parseClaudeCodeSessionFile(path, new Date("2026-04-26T10:00:03.000Z"));
    expect(row).not.toBeNull();
    expect(row!.surface).toBe("claude-code");
    expect(row!.session_id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(row!.project_path).toBe("/Users/mitch/Projects/espejo");
    expect(row!.message_count).toBe(3);
    expect(row!.user_msg_count).toBe(1);
    expect(row!.tool_call_count).toBe(1);
    expect(row!.tools_used).toEqual(["Read"]);
    expect(row!.models).toEqual(["claude-opus-4-7"]);
    expect(row!.prompts).toHaveLength(1);
    expect((row!.prompts[0] as { text: string }).text).toBe("hello");
    expect(row!.tool_calls).toHaveLength(1);
    expect((row!.tool_calls[0] as { ok: boolean }).ok).toBe(true);
  });

  it("flags failed tool calls with truncated error", async () => {
    const path = writeJsonl("session-err", [
      {
        type: "assistant",
        timestamp: "2026-04-26T10:00:00.000Z",
        message: {
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", id: "tu_x", name: "Bash", input: { command: "false" } }],
        },
      },
      {
        type: "user",
        timestamp: "2026-04-26T10:00:01.000Z",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_x", content: "boom", is_error: true },
          ],
        },
      },
    ]);
    const row = await parseClaudeCodeSessionFile(path, new Date());
    const tc = row!.tool_calls[0] as { ok: boolean; error?: string };
    expect(tc.ok).toBe(false);
    expect(tc.error).toBe("boom");
  });

  it("tolerates corrupt lines and missing timestamps", async () => {
    const path = join(tmp, "session-corrupt.jsonl");
    writeFileSync(
      path,
      [
        "{not json",
        JSON.stringify({ type: "user", message: { content: "hi" } }), // no timestamp, no cwd
        "",
      ].join("\n")
    );
    const row = await parseClaudeCodeSessionFile(path, new Date("2026-04-26T10:00:00.000Z"));
    expect(row!.user_msg_count).toBe(1);
    expect(row!.project_path).toBe("(unknown)");
    expect(row!.started_at.getTime()).toBe(new Date("2026-04-26T10:00:00.000Z").getTime());
  });
});
