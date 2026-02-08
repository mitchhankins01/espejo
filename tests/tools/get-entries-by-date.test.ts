import { describe, it, expect } from "vitest";
import { validateToolInput } from "../../specs/tools.spec.js";

describe("get_entries_by_date spec", () => {
  it("validates valid date range", () => {
    const result = validateToolInput("get_entries_by_date", {
      date_from: "2024-01-01",
      date_to: "2024-01-31",
    });
    expect(result.date_from).toBe("2024-01-01");
    expect(result.date_to).toBe("2024-01-31");
    expect(result.limit).toBe(20); // default
  });

  it("rejects missing date_from", () => {
    expect(() =>
      validateToolInput("get_entries_by_date", { date_to: "2024-01-31" })
    ).toThrow();
  });

  it("rejects missing date_to", () => {
    expect(() =>
      validateToolInput("get_entries_by_date", { date_from: "2024-01-01" })
    ).toThrow();
  });

  it("rejects invalid date format", () => {
    expect(() =>
      validateToolInput("get_entries_by_date", {
        date_from: "Jan 1 2024",
        date_to: "2024-01-31",
      })
    ).toThrow();
  });

  it("accepts custom limit", () => {
    const result = validateToolInput("get_entries_by_date", {
      date_from: "2024-01-01",
      date_to: "2024-01-31",
      limit: 5,
    });
    expect(result.limit).toBe(5);
  });

  it("rejects limit over 50", () => {
    expect(() =>
      validateToolInput("get_entries_by_date", {
        date_from: "2024-01-01",
        date_to: "2024-01-31",
        limit: 51,
      })
    ).toThrow();
  });
});
