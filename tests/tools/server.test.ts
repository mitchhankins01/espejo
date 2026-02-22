import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRegisterTool, mockHandlers } = vi.hoisted(() => ({
  mockRegisterTool: vi.fn(),
  mockHandlers: {
    handleSearchEntries: vi.fn(),
    handleGetEntry: vi.fn(),
    handleGetEntriesByDate: vi.fn(),
    handleOnThisDay: vi.fn(),
    handleFindSimilar: vi.fn(),
    handleListTags: vi.fn(),
    handleEntryStats: vi.fn(),
    handleLogWeight: vi.fn(),
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: mockRegisterTool,
  })),
}));

vi.mock("../../src/tools/search.js", () => ({
  handleSearchEntries: mockHandlers.handleSearchEntries,
}));
vi.mock("../../src/tools/get-entry.js", () => ({
  handleGetEntry: mockHandlers.handleGetEntry,
}));
vi.mock("../../src/tools/get-entries-by-date.js", () => ({
  handleGetEntriesByDate: mockHandlers.handleGetEntriesByDate,
}));
vi.mock("../../src/tools/on-this-day.js", () => ({
  handleOnThisDay: mockHandlers.handleOnThisDay,
}));
vi.mock("../../src/tools/find-similar.js", () => ({
  handleFindSimilar: mockHandlers.handleFindSimilar,
}));
vi.mock("../../src/tools/list-tags.js", () => ({
  handleListTags: mockHandlers.handleListTags,
}));
vi.mock("../../src/tools/entry-stats.js", () => ({
  handleEntryStats: mockHandlers.handleEntryStats,
}));
vi.mock("../../src/tools/log-weight.js", () => ({
  handleLogWeight: mockHandlers.handleLogWeight,
}));

import { createServer, toolHandlers } from "../../src/server.js";
import type { ToolHandler } from "../../src/server.js";
import { toolSpecs } from "../../specs/tools.spec.js";

describe("createServer", () => {
  beforeEach(() => {
    mockRegisterTool.mockClear();
    Object.values(mockHandlers).forEach((fn) => fn.mockReset());
  });

  it("registers all tools from the spec", () => {
    createServer({} as any, "1.0.0");
    expect(mockRegisterTool).toHaveBeenCalledTimes(
      Object.keys(toolSpecs).length
    );
  });

  it("registers tools with correct names", () => {
    createServer({} as any, "1.0.0");
    const registeredNames = mockRegisterTool.mock.calls.map(
      (call) => call[0]
    );
    for (const name of Object.keys(toolSpecs)) {
      expect(registeredNames).toContain(name);
    }
  });

  it("wraps handler success in MCP content response", async () => {
    mockHandlers.handleSearchEntries.mockResolvedValue("test results");
    createServer({} as any, "1.0.0");

    const searchCall = mockRegisterTool.mock.calls.find(
      (call) => call[0] === "search_entries"
    );
    const handler = searchCall![2];
    const result = await handler({ query: "test" });

    expect(result).toEqual({
      content: [{ type: "text", text: "test results" }],
    });
  });

  it("returns isError when handler throws an Error", async () => {
    mockHandlers.handleGetEntry.mockRejectedValue(new Error("Not found"));
    createServer({} as any, "1.0.0");

    const getEntryCall = mockRegisterTool.mock.calls.find(
      (call) => call[0] === "get_entry"
    );
    const handler = getEntryCall![2];
    const result = await handler({ uuid: "test" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Not found");
  });

  it("handles non-Error throws with fallback message", async () => {
    mockHandlers.handleListTags.mockRejectedValue("string error");
    createServer({} as any, "1.0.0");

    const listTagsCall = mockRegisterTool.mock.calls.find(
      (call) => call[0] === "list_tags"
    );
    const handler = listTagsCall![2];
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown error");
  });

  it("exports toolHandlers map with all spec keys", () => {
    for (const name of Object.keys(toolSpecs)) {
      expect(toolHandlers).toHaveProperty(name);
    }
  });

  it("exports ToolHandler type (compile-time check)", () => {
    const handler: ToolHandler = toolHandlers.search_entries;
    expect(typeof handler).toBe("function");
  });
});
