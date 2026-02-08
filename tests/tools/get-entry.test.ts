import { describe, it, expect } from "vitest";
import { validateToolInput } from "../../specs/tools.spec.js";

describe("get_entry spec", () => {
  it("validates a valid UUID", () => {
    const result = validateToolInput("get_entry", { uuid: "ABC-123" });
    expect(result.uuid).toBe("ABC-123");
  });

  it("rejects empty UUID", () => {
    expect(() => validateToolInput("get_entry", { uuid: "" })).toThrow();
  });

  it("rejects missing UUID", () => {
    expect(() => validateToolInput("get_entry", {})).toThrow();
  });
});
