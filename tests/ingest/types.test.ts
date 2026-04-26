import { describe, it, expect } from "vitest";
import {
  truncateArgs,
  truncateString,
  isEspejoPath,
  MAX_TOOL_ARG_BYTES,
} from "../../src/ingest/types.js";

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
