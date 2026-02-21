import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("search_entries spec", () => {
  it("validates a valid query", () => {
    const result = validateToolInput("search_entries", {
      query: "feeling overwhelmed",
    });
    expect(result.query).toBe("feeling overwhelmed");
    expect(result.limit).toBe(10); // default
  });

  it("rejects empty query", () => {
    expect(() =>
      validateToolInput("search_entries", { query: "" })
    ).toThrow();
  });

  it("rejects missing query", () => {
    expect(() => validateToolInput("search_entries", {})).toThrow();
  });

  it("accepts all optional filters", () => {
    const result = validateToolInput("search_entries", {
      query: "test",
      date_from: "2024-01-01",
      date_to: "2024-12-31",
      tags: ["work", "health"],
      city: "Barcelona",
      limit: 20,
    });
    expect(result.date_from).toBe("2024-01-01");
    expect(result.date_to).toBe("2024-12-31");
    expect(result.tags).toEqual(["work", "health"]);
    expect(result.city).toBe("Barcelona");
    expect(result.limit).toBe(20);
  });

  it("rejects invalid date format", () => {
    expect(() =>
      validateToolInput("search_entries", {
        query: "test",
        date_from: "01-01-2024",
      })
    ).toThrow();
  });

  it("rejects limit over max", () => {
    expect(() =>
      validateToolInput("search_entries", {
        query: "test",
        limit: 51,
      })
    ).toThrow();
  });

  it("rejects limit under min", () => {
    expect(() =>
      validateToolInput("search_entries", {
        query: "test",
        limit: 0,
      })
    ).toThrow();
  });

  it("has correct tool name and description", () => {
    expect(toolSpecs.search_entries.name).toBe("search_entries");
    expect(toolSpecs.search_entries.description).toContain("Hybrid");
    expect(toolSpecs.search_entries.description).toContain("Reciprocal Rank Fusion");
  });
});
