import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("list_todos spec", () => {
  it("validates with no params (all defaults)", () => {
    const result = validateToolInput("list_todos", {});
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  it("validates with all filters", () => {
    const result = validateToolInput("list_todos", {
      status: "active",
      urgent: true,
      important: false,
      parent_id: "root",
      focus_only: true,
      include_children: true,
      limit: 10,
      offset: 5,
    });
    expect(result.status).toBe("active");
    expect(result.urgent).toBe(true);
    expect(result.important).toBe(false);
    expect(result.parent_id).toBe("root");
    expect(result.focus_only).toBe(true);
    expect(result.include_children).toBe(true);
  });

  it("validates someday status", () => {
    const result = validateToolInput("list_todos", { status: "someday" });
    expect(result.status).toBe("someday");
  });

  it("rejects invalid status", () => {
    expect(() => validateToolInput("list_todos", { status: "invalid" })).toThrow();
  });

  it("has correct tool name", () => {
    expect(toolSpecs.list_todos.name).toBe("list_todos");
    expect(toolSpecs.list_todos.description).toContain("Eisenhower");
  });
});
