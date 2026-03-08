import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("complete_todo spec", () => {
  it("validates a valid id", () => {
    const result = validateToolInput("complete_todo", { id: "abc-123" });
    expect(result.id).toBe("abc-123");
  });

  it("rejects empty id", () => {
    expect(() => validateToolInput("complete_todo", { id: "" })).toThrow();
  });

  it("rejects missing id", () => {
    expect(() => validateToolInput("complete_todo", {})).toThrow();
  });

  it("has correct tool name", () => {
    expect(toolSpecs.complete_todo.name).toBe("complete_todo");
    expect(toolSpecs.complete_todo.description).toContain("done");
  });
});
