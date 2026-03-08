import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("set_todo_focus spec", () => {
  it("validates with id", () => {
    const result = validateToolInput("set_todo_focus", { id: "abc-123" });
    expect(result.id).toBe("abc-123");
  });

  it("validates with clear=true", () => {
    const result = validateToolInput("set_todo_focus", { clear: true });
    expect(result.clear).toBe(true);
  });

  it("validates with no params", () => {
    const result = validateToolInput("set_todo_focus", {});
    expect(result.id).toBeUndefined();
    expect(result.clear).toBeUndefined();
  });

  it("has correct tool name", () => {
    expect(toolSpecs.set_todo_focus.name).toBe("set_todo_focus");
    expect(toolSpecs.set_todo_focus.description).toContain("One Thing");
  });
});
