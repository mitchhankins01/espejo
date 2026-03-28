import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("update_todo spec", () => {
  it("validates with id only", () => {
    const result = validateToolInput("update_todo", { id: "abc" });
    expect(result.id).toBe("abc");
  });

  it("validates all optional fields", () => {
    const result = validateToolInput("update_todo", {
      id: "abc",
      title: "New title",
      status: "done",
      next_step: null,
      body: "Updated",
      urgent: false,
      important: true,
    });
    expect(result.status).toBe("done");
    expect(result.urgent).toBe(false);
  });

  it("rejects empty id", () => {
    expect(() => validateToolInput("update_todo", { id: "" })).toThrow();
  });

  it("has correct tool name", () => {
    expect(toolSpecs.update_todo.name).toBe("update_todo");
  });
});
