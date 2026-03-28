import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("search_content spec", () => {
  it("validates a valid query with defaults", () => {
    const result = validateToolInput("search_content", {
      query: "sleep quality",
    });
    expect(result.query).toBe("sleep quality");
    expect(result.limit).toBe(10);
    expect(result.content_types).toBeUndefined();
  });

  it("rejects empty query", () => {
    expect(() =>
      validateToolInput("search_content", { query: "" })
    ).toThrow();
  });

  it("accepts content_types filter", () => {
    const result = validateToolInput("search_content", {
      query: "test",
      content_types: ["knowledge_artifact"],
    });
    expect(result.content_types).toEqual(["knowledge_artifact"]);
  });

  it("accepts all optional filters", () => {
    const result = validateToolInput("search_content", {
      query: "test",
      content_types: ["journal_entry", "knowledge_artifact"],
      date_from: "2024-01-01",
      date_to: "2024-12-31",
      city: "Barcelona",
      artifact_kind: "insight",
      limit: 20,
    });
    expect(result.date_from).toBe("2024-01-01");
    expect(result.artifact_kind).toBe("insight");
    expect(result.limit).toBe(20);
  });

  it("rejects invalid content_types", () => {
    expect(() =>
      validateToolInput("search_content", {
        query: "test",
        content_types: ["invalid"],
      })
    ).toThrow();
  });

  it("has correct tool name", () => {
    expect(toolSpecs.search_content.name).toBe("search_content");
    expect(toolSpecs.search_content.description).toContain("Unified");
  });
});
