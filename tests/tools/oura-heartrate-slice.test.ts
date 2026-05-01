import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getOuraHeartrateRange: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);

import { handleGetOuraHeartrateSlice } from "../../src/tools/get-oura-heartrate-slice.js";

const mockPool = {} as never;

beforeEach(() => {
  mockQueries.getOuraHeartrateRange.mockReset();
});

describe("handleGetOuraHeartrateSlice", () => {
  it("returns formatted slice with stats", async () => {
    mockQueries.getOuraHeartrateRange.mockResolvedValue([
      { ts: new Date("2026-04-29T08:00:00Z"), bpm: 60, source: "rest" },
      { ts: new Date("2026-04-29T08:05:00Z"), bpm: 80, source: "awake" },
      { ts: new Date("2026-04-29T08:10:00Z"), bpm: 70, source: "rest" },
    ]);
    const result = await handleGetOuraHeartrateSlice(mockPool, {
      start: "2026-04-29T08:00:00Z",
      end: "2026-04-29T09:00:00Z",
    });
    const parsed = JSON.parse(result);
    expect(parsed.sample_count).toBe(3);
    expect(parsed.stats).toEqual({ min: 60, max: 80, mean: 70 });
    expect(parsed.source).toBe("all");
    expect(mockQueries.getOuraHeartrateRange).toHaveBeenCalledWith(
      mockPool, "2026-04-29T08:00:00Z", "2026-04-29T09:00:00Z", undefined
    );
  });

  it("filters by source when provided", async () => {
    mockQueries.getOuraHeartrateRange.mockResolvedValue([
      { ts: new Date("2026-04-29T08:00:00Z"), bpm: 60, source: "rest" },
    ]);
    const result = await handleGetOuraHeartrateSlice(mockPool, {
      start: "2026-04-29T08:00:00Z",
      end: "2026-04-29T09:00:00Z",
      source: "rest",
    });
    const parsed = JSON.parse(result);
    expect(parsed.source).toBe("rest");
    expect(mockQueries.getOuraHeartrateRange).toHaveBeenCalledWith(
      mockPool, "2026-04-29T08:00:00Z", "2026-04-29T09:00:00Z", "rest"
    );
  });

  it("returns no-samples message when empty", async () => {
    mockQueries.getOuraHeartrateRange.mockResolvedValue([]);
    const result = await handleGetOuraHeartrateSlice(mockPool, {
      start: "2020-01-01T00:00:00Z",
      end: "2020-01-01T01:00:00Z",
    });
    expect(result).toContain("No heart rate samples");
  });

  it("includes source in no-samples message when filtered", async () => {
    mockQueries.getOuraHeartrateRange.mockResolvedValue([]);
    const result = await handleGetOuraHeartrateSlice(mockPool, {
      start: "2020-01-01T00:00:00Z",
      end: "2020-01-01T01:00:00Z",
      source: "workout",
    });
    expect(result).toContain("source=workout");
  });
});
