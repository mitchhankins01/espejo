import { describe, it, expect } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

describe("list_artifacts spec", () => {
  it("accepts empty params with defaults", () => {
    const result = validateToolInput("list_artifacts", {});
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  it("accepts kind filter", () => {
    const result = validateToolInput("list_artifacts", { kind: "insight" });
    expect(result.kind).toBe("insight");
  });

  it("rejects invalid kind", () => {
    expect(() =>
      validateToolInput("list_artifacts", { kind: "invalid" })
    ).toThrow();
  });

  it("rejects limit over max", () => {
    expect(() =>
      validateToolInput("list_artifacts", { limit: 101 })
    ).toThrow();
  });

  it("has correct tool name", () => {
    expect(toolSpecs.list_artifacts.name).toBe("list_artifacts");
  });
});
