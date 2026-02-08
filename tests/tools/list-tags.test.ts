import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("list_tags spec", () => {
  it("validates with empty input", () => {
    const result = validateToolInput("list_tags", {});
    expect(result).toEqual({});
  });

  it("has correct description", () => {
    expect(toolSpecs.list_tags.description).toContain("tags");
    expect(toolSpecs.list_tags.description).toContain("counts");
  });
});
