import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("search_artifacts spec", () => {
  it("validates a valid query", () => {
    const result = validateToolInput("search_artifacts", {
      query: "dopamine regulation",
    });
    expect(result.query).toBe("dopamine regulation");
    expect(result.limit).toBe(10);
  });

  it("rejects empty query", () => {
    expect(() =>
      validateToolInput("search_artifacts", { query: "" })
    ).toThrow();
  });

  it("accepts optional filters", () => {
    const result = validateToolInput("search_artifacts", {
      query: "test",
      kind: "reference",
      limit: 20,
    });
    expect(result.kind).toBe("reference");
    expect(result.limit).toBe(20);
  });

  it("rejects limit over max", () => {
    expect(() =>
      validateToolInput("search_artifacts", { query: "test", limit: 51 })
    ).toThrow();
  });

  it("has correct tool name", () => {
    expect(toolSpecs.search_artifacts.name).toBe("search_artifacts");
    expect(toolSpecs.search_artifacts.description).toContain("RRF");
  });
});
