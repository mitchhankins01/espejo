import { describe, it, expect } from "vitest";
import {
  truncateArgs,
  truncateString,
  isEspejoPath,
  categorizeSession,
  MAX_TOOL_ARG_BYTES,
  type Prompt,
  type ToolCall,
} from "../../src/ingest/types.js";

function input(overrides: Partial<{
  project_path: string;
  prompts: Prompt[];
  tool_calls: ToolCall[];
  tools_used: string[];
  message_count: number;
  tool_call_count: number;
}> = {}) {
  return {
    project_path: "/Users/mitch/Projects/espejo",
    prompts: [{ ts: "2026-04-26", text: "hi" }] as Prompt[],
    tool_calls: [] as ToolCall[],
    tools_used: [] as string[],
    message_count: 2,
    tool_call_count: 0,
    ...overrides,
  };
}

describe("truncateArgs", () => {
  it("returns null for null/undefined", () => {
    expect(truncateArgs(null)).toEqual({ value: null, truncated: false });
    expect(truncateArgs(undefined)).toEqual({ value: null, truncated: false });
  });

  it("passes small payloads through unchanged", () => {
    const args = { foo: "bar", n: 1 };
    expect(truncateArgs(args)).toEqual({ value: args, truncated: false });
  });

  it("truncates payloads larger than MAX_TOOL_ARG_BYTES", () => {
    const big = { huge: "x".repeat(MAX_TOOL_ARG_BYTES * 2) };
    const r = truncateArgs(big);
    expect(r.truncated).toBe(true);
    const v = r.value as { __truncated: boolean; original_bytes: number; preview: string };
    expect(v.__truncated).toBe(true);
    expect(v.original_bytes).toBeGreaterThan(MAX_TOOL_ARG_BYTES);
    expect(v.preview.length).toBeLessThanOrEqual(MAX_TOOL_ARG_BYTES);
  });

  it("marks unserializable values as such", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = truncateArgs(circular);
    expect(r.truncated).toBe(true);
    expect((r.value as { __unserializable: boolean }).__unserializable).toBe(true);
  });
});

describe("truncateString", () => {
  it("passes short strings through", () => {
    expect(truncateString("hello", 10)).toBe("hello");
  });
  it("truncates long strings with marker", () => {
    const r = truncateString("abcdefghij", 5);
    expect(r.startsWith("abcde")).toBe(true);
    expect(r).toContain("[+5 chars]");
  });
});

describe("isEspejoPath", () => {
  it.each([
    ["/Users/mitch/Projects/espejo", true],
    ["/Users/mitch/Documents/Artifacts", true],
    ["/Users/mitch/Documents/Artifacts/Insight/foo.md", true],
    ["/Users/mitch/Projects/greenline", false],
    ["/Users/mitch/Desktop", false],
    ["", false],
  ])("isEspejoPath(%s) = %s", (path, expected) => {
    expect(isEspejoPath(path)).toBe(expected);
  });
});

describe("categorizeSession", () => {
  it("throwaway: no prompts", () => {
    expect(categorizeSession(input({ prompts: [] }))).toBe("throwaway");
  });

  it("throwaway: no tools and tiny prompt", () => {
    expect(categorizeSession(input({ prompts: [{ ts: "x", text: "hi" }] }))).toBe("throwaway");
  });

  it("automation: single huge prompt with classification language", () => {
    expect(
      categorizeSession(
        input({
          prompts: [
            {
              ts: "x",
              text: "You are classifying candidate insight pairs. Output ONE JSON array. " + "x".repeat(6000),
            },
          ],
          message_count: 1,
        })
      )
    ).toBe("automation");
  });

  it("automation: AGENTS.md auto-injected first prompt", () => {
    expect(
      categorizeSession(
        input({
          prompts: [
            {
              ts: "x",
              text: "# AGENTS.md instructions for /Users/mitch/Projects/espejo\n<INSTRUCTIONS>\n" + "y".repeat(5000),
            },
          ],
          message_count: 1,
        })
      )
    ).toBe("automation");
  });

  it("reflection: vault-root project path", () => {
    expect(
      categorizeSession(
        input({
          project_path: "/Users/mitch/Documents/Artifacts",
          prompts: [{ ts: "x", text: "load context for nicotine regulation".padEnd(600, " ") }],
          tool_call_count: 5,
        })
      )
    ).toBe("reflection");
  });

  it("reflection: espejo MCP tool fired", () => {
    expect(
      categorizeSession(
        input({
          tools_used: ["mcp__claude_ai_Espejo__search_entries"],
          tool_calls: [
            { name: "mcp__claude_ai_Espejo__search_entries", args: {}, ok: true, ts: "x" },
          ],
          tool_call_count: 1,
          message_count: 4,
        })
      )
    ).toBe("reflection");
  });

  it("reflection: touched Artifacts/ in tool calls, no src/", () => {
    expect(
      categorizeSession(
        input({
          tool_calls: [
            { name: "Read", args: { file_path: "/Users/mitch/Projects/espejo/Artifacts/Insight/foo.md" }, ok: true, ts: "x" },
          ],
          tools_used: ["Read"],
          tool_call_count: 1,
          message_count: 4,
        })
      )
    ).toBe("reflection");
  });

  it("dev: touched src/ only, no Artifacts/", () => {
    expect(
      categorizeSession(
        input({
          tool_calls: [
            { name: "Edit", args: { file_path: "/Users/mitch/Projects/espejo/src/server.ts" }, ok: true, ts: "x" },
          ],
          tools_used: ["Edit"],
          tool_call_count: 1,
          message_count: 4,
        })
      )
    ).toBe("dev");
  });

  it("mixed: touched both src/ and Artifacts/", () => {
    expect(
      categorizeSession(
        input({
          tool_calls: [
            { name: "Edit", args: { file_path: "/x/src/foo.ts" }, ok: true, ts: "x" },
            { name: "Read", args: { file_path: "/x/Artifacts/Insight/y.md" }, ok: true, ts: "x" },
          ],
          tools_used: ["Edit", "Read"],
          tool_call_count: 2,
          message_count: 4,
        })
      )
    ).toBe("mixed");
  });

  it("mixed: human-driven session with no clear src/Artifacts marker", () => {
    expect(
      categorizeSession(
        input({
          prompts: [
            { ts: "x", text: "what is the most underrated technical-writing quality" },
            { ts: "y", text: "explain more" },
          ],
          tool_calls: [{ name: "WebSearch", args: { query: "x" }, ok: true, ts: "x" }],
          tools_used: ["WebSearch"],
          tool_call_count: 1,
          message_count: 4,
        })
      )
    ).toBe("mixed");
  });
});
