import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("create_todo spec", () => {
  it("validates minimal input", () => {
    const result = validateToolInput("create_todo", { title: "Test" });
    expect(result.title).toBe("Test");
  });

  it("validates all fields", () => {
    const result = validateToolInput("create_todo", {
      title: "Test",
      status: "waiting",
      next_step: "Do something",
      body: "Details",
      tags: ["admin"],
      urgent: true,
      important: true,
      parent_id: "abc-123",
    });
    expect(result.urgent).toBe(true);
    expect(result.parent_id).toBe("abc-123");
  });

  it("rejects empty title", () => {
    expect(() => validateToolInput("create_todo", { title: "" })).toThrow();
  });

  it("rejects missing title", () => {
    expect(() => validateToolInput("create_todo", {})).toThrow();
  });

  it("has correct tool name", () => {
    expect(toolSpecs.create_todo.name).toBe("create_todo");
  });
});
