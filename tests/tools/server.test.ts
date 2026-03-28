import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRegisterTool, mockRegisterPrompt, mockHandlers } = vi.hoisted(() => ({
  mockRegisterTool: vi.fn(),
  mockRegisterPrompt: vi.fn(),
  mockHandlers: {
    handleSearchEntries: vi.fn(),
    handleGetEntry: vi.fn(),
    handleGetEntriesByDate: vi.fn(),
    handleOnThisDay: vi.fn(),
    handleFindSimilar: vi.fn(),
    handleEntryStats: vi.fn(),
    handleGetArtifact: vi.fn(),
    handleListArtifacts: vi.fn(),
    handleSearchArtifacts: vi.fn(),
    handleSearchContent: vi.fn(),
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: mockRegisterTool,
    registerPrompt: mockRegisterPrompt,
  })),
}));

vi.mock("../../src/sessions/context.js", () => ({
  buildMorningContext: vi.fn(),
  buildEveningContext: vi.fn(),
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
vi.mock("../../src/tools/entry-stats.js", () => ({
  handleEntryStats: mockHandlers.handleEntryStats,
}));
vi.mock("../../src/tools/get-artifact.js", () => ({
  handleGetArtifact: mockHandlers.handleGetArtifact,
}));
vi.mock("../../src/tools/list-artifacts.js", () => ({
  handleListArtifacts: mockHandlers.handleListArtifacts,
}));
vi.mock("../../src/tools/search-artifacts.js", () => ({
  handleSearchArtifacts: mockHandlers.handleSearchArtifacts,
}));
vi.mock("../../src/tools/search-content.js", () => ({
  handleSearchContent: mockHandlers.handleSearchContent,
}));
vi.mock("../../src/tools/save-evening-review.js", () => ({
  handleSaveEveningReview: vi.fn(),
}));
vi.mock("../../src/prompts/evening-review.js", () => ({
  handleEveningReviewPrompt: vi.fn(),
}));
import { createServer, toolHandlers } from "../../src/server.js";
import type { ToolHandler } from "../../src/server.js";
import { toolSpecs } from "../../specs/tools.spec.js";

describe("createServer", () => {
  beforeEach(() => {
    mockRegisterTool.mockClear();
    mockRegisterPrompt.mockClear();
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
    mockHandlers.handleEntryStats.mockRejectedValue("string error");
    createServer({} as any, "1.0.0");

    const entryStatsCall = mockRegisterTool.mock.calls.find(
      (call) => call[0] === "entry_stats"
    );
    const handler = entryStatsCall![2];
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

  it("passes tool annotations from spec to registerTool", () => {
    createServer({} as any, "1.0.0");
    const searchCall = mockRegisterTool.mock.calls.find(
      (call) => call[0] === "search_entries"
    );
    expect(searchCall![1].annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("passes through rich CallToolResult from handler", async () => {
    const richResult = {
      content: [
        { type: "text" as const, text: "visible", annotations: { audience: ["user" as const] } },
        { type: "text" as const, text: "instructions", annotations: { audience: ["assistant" as const] } },
      ],
    };
    mockHandlers.handleSearchEntries.mockResolvedValue(richResult);
    createServer({} as any, "1.0.0");

    const searchCall = mockRegisterTool.mock.calls.find(
      (call) => call[0] === "search_entries"
    );
    const handler = searchCall![2];
    const result = await handler({ query: "test" });

    expect(result).toBe(richResult);
  });

});
