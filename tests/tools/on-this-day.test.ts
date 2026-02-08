import { describe, it, expect } from "vitest";
import { validateToolInput } from "../../specs/tools.spec.js";

describe("on_this_day spec", () => {
  it("validates valid MM-DD format", () => {
    const result = validateToolInput("on_this_day", { month_day: "03-15" });
    expect(result.month_day).toBe("03-15");
  });

  it("rejects invalid format", () => {
    expect(() =>
      validateToolInput("on_this_day", { month_day: "3-15" })
    ).toThrow();
  });

  it("rejects YYYY-MM-DD format", () => {
    expect(() =>
      validateToolInput("on_this_day", { month_day: "2024-03-15" })
    ).toThrow();
  });

  it("rejects missing month_day", () => {
    expect(() => validateToolInput("on_this_day", {})).toThrow();
  });
});
