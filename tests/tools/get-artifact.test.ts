import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("get_artifact spec", () => {
  it("validates a valid id", () => {
    const result = validateToolInput("get_artifact", { id: "abc-123" });
    expect(result.id).toBe("abc-123");
  });

  it("rejects empty id", () => {
    expect(() => validateToolInput("get_artifact", { id: "" })).toThrow();
  });

  it("rejects missing id", () => {
    expect(() => validateToolInput("get_artifact", {})).toThrow();
  });

  it("has correct tool name and description", () => {
    expect(toolSpecs.get_artifact.name).toBe("get_artifact");
    expect(toolSpecs.get_artifact.description).toContain("knowledge artifact");
  });
});
