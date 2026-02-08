import { describe, it, expect } from "vitest";
import { validateToolInput } from "../../specs/tools.spec.js";

describe("entry_stats spec", () => {
  it("validates with no params", () => {
    const result = validateToolInput("entry_stats", {});
    expect(result.date_from).toBeUndefined();
    expect(result.date_to).toBeUndefined();
  });

  it("accepts date range", () => {
    const result = validateToolInput("entry_stats", {
      date_from: "2024-01-01",
      date_to: "2024-12-31",
    });
    expect(result.date_from).toBe("2024-01-01");
    expect(result.date_to).toBe("2024-12-31");
  });

  it("rejects invalid date format", () => {
    expect(() =>
      validateToolInput("entry_stats", { date_from: "January 2024" })
    ).toThrow();
  });
});
