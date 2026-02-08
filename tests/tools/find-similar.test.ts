import { describe, it, expect } from "vitest";
import { validateToolInput } from "../../specs/tools.spec.js";

describe("find_similar spec", () => {
  it("validates valid UUID", () => {
    const result = validateToolInput("find_similar", { uuid: "ABC-123" });
    expect(result.uuid).toBe("ABC-123");
    expect(result.limit).toBe(5); // default
  });

  it("accepts custom limit", () => {
    const result = validateToolInput("find_similar", {
      uuid: "ABC-123",
      limit: 10,
    });
    expect(result.limit).toBe(10);
  });

  it("rejects empty UUID", () => {
    expect(() =>
      validateToolInput("find_similar", { uuid: "" })
    ).toThrow();
  });

  it("rejects limit over 20", () => {
    expect(() =>
      validateToolInput("find_similar", { uuid: "ABC", limit: 21 })
    ).toThrow();
  });
});
