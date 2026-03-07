import { describe, it, expect } from "vitest";
import { normalizeTags } from "../../src/db/queries.js";

describe("normalizeTags", () => {
  it("lowercases tags", () => {
    expect(normalizeTags(["Sleep", "HEALTH"])).toEqual(["health", "sleep"]);
  });

  it("trims whitespace", () => {
    expect(normalizeTags(["  sleep ", " health"])).toEqual(["health", "sleep"]);
  });

  it("deduplicates", () => {
    expect(normalizeTags(["sleep", "Sleep", "SLEEP"])).toEqual(["sleep"]);
  });

  it("sorts stably", () => {
    expect(normalizeTags(["zzz", "aaa", "mmm"])).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("filters empty strings", () => {
    expect(normalizeTags(["", "  ", "valid"])).toEqual(["valid"]);
  });

  it("handles empty array", () => {
    expect(normalizeTags([])).toEqual([]);
  });
});
