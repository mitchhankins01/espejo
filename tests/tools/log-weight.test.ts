import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  upsertDailyMetric: vi.fn(),
}));

const mockConfig = vi.hoisted(() => ({
  config: {
    timezone: "Europe/Madrid",
  },
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => mockConfig);

import { handleLogWeight } from "../../src/tools/log-weight.js";

const mockPool = {} as any;

beforeEach(() => {
  mockQueries.upsertDailyMetric.mockReset();
});

describe("handleLogWeight", () => {
  it("logs weight with explicit date", async () => {
    const result = await handleLogWeight(mockPool, {
      weight_kg: 76.5,
      date: "2025-03-15",
    });

    expect(mockQueries.upsertDailyMetric).toHaveBeenCalledWith(
      mockPool,
      "2025-03-15",
      76.5
    );
    expect(result).toContain("76.5");
    expect(result).toContain("2025-03-15");
  });

  it("defaults date to today in configured timezone", async () => {
    const result = await handleLogWeight(mockPool, { weight_kg: 80.0 });

    expect(mockQueries.upsertDailyMetric).toHaveBeenCalledWith(
      mockPool,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      80.0
    );
    expect(result).toContain("80");
  });

  it("rejects negative weight", async () => {
    await expect(
      handleLogWeight(mockPool, { weight_kg: -5 })
    ).rejects.toThrow();
  });

  it("rejects zero weight", async () => {
    await expect(
      handleLogWeight(mockPool, { weight_kg: 0 })
    ).rejects.toThrow();
  });

  it("rejects missing weight_kg", async () => {
    await expect(handleLogWeight(mockPool, {})).rejects.toThrow();
  });

  it("rejects invalid date format", async () => {
    await expect(
      handleLogWeight(mockPool, { weight_kg: 75, date: "March 15" })
    ).rejects.toThrow();
  });
});
