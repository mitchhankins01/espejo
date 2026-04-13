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
      city: "Barcelona",
      limit: 20,
    });
    expect(result.date_from).toBe("2024-01-01");
    expect(result.date_to).toBe("2024-12-31");
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

  it("accepts null for optional string, date, and city params", () => {
    const result = validateToolInput("search_entries", {
      query: "test",
      date_from: null,
      date_to: null,
      city: null,
    });
    expect(result.query).toBe("test");
    expect(result.date_from).toBeUndefined();
    expect(result.date_to).toBeUndefined();
    expect(result.city).toBeUndefined();
  });

  it("has correct tool name and description", () => {
    expect(toolSpecs.search_entries.name).toBe("search_entries");
    expect(toolSpecs.search_entries.description).toContain("Hybrid");
    expect(toolSpecs.search_entries.description).toContain("Reciprocal Rank Fusion");
  });
});

describe("null handling across param types", () => {
  it("strips null from optional boolean and enum params", () => {
    const result = validateToolInput("search_entries", {
      query: "test",
      city: null,
      from: null,
    });
    expect(result.city).toBeUndefined();
    expect(result.from).toBeUndefined();
  });

  it("strips null from optional array params", () => {
    const result = validateToolInput("search_content", {
      query: "test",
      content_types: null,
    });
    expect(result.content_types).toBeUndefined();
  });

  it("strips null from optional nested object params", () => {
    const result = validateToolInput("save_evening_review", {
      text: "test review",
      date: null,
    });
    expect(result.date).toBeUndefined();
  });
});
