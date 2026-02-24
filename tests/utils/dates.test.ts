import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: { timezone: "Europe/Madrid" },
}));

import { todayInTimezone, daysAgoInTimezone } from "../../src/utils/dates.js";

describe("todayInTimezone", () => {
  it("returns a YYYY-MM-DD string", () => {
    const result = todayInTimezone();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("daysAgoInTimezone", () => {
  it("returns a YYYY-MM-DD string", () => {
    const result = daysAgoInTimezone(7);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a date before today", () => {
    const today = todayInTimezone();
    const past = daysAgoInTimezone(1);
    expect(past < today).toBe(true);
  });

  it("returns today when days is 0", () => {
    const today = todayInTimezone();
    const zero = daysAgoInTimezone(0);
    expect(zero).toBe(today);
  });
});
