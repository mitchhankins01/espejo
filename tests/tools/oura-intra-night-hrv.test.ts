import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getOuraIntraNightHrv: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);

import { handleGetOuraIntraNightHrv } from "../../src/tools/get-oura-intra-night-hrv.js";

const mockPool = {} as never;

beforeEach(() => {
  mockQueries.getOuraIntraNightHrv.mockReset();
});

describe("handleGetOuraIntraNightHrv", () => {
  it("returns intra-night HRV/HR series with stats", async () => {
    mockQueries.getOuraIntraNightHrv.mockResolvedValue({
      day: new Date("2026-04-29"),
      bedtime_start: new Date("2026-04-29T22:00:00Z"),
      hrv_5min: { interval: 300, items: [40, 50, null, 60] },
      heart_rate_5min: { interval: 300, items: [55, 53, 52, 51] },
    });
    const result = await handleGetOuraIntraNightHrv(mockPool, { date: "2026-04-29" });
    const parsed = JSON.parse(result);
    expect(parsed.day).toBe("2026-04-29");
    expect(parsed.interval_seconds).toBe(300);
    expect(parsed.hrv_samples).toEqual([40, 50, null, 60]);
    expect(parsed.hrv_stats).toEqual({ min: 40, max: 60, mean: 50 });
    expect(parsed.hr_stats).toEqual({ min: 51 });
    expect(mockQueries.getOuraIntraNightHrv).toHaveBeenCalledWith(mockPool, "2026-04-29");
  });

  it("returns 'no long_sleep' message when query returns null", async () => {
    mockQueries.getOuraIntraNightHrv.mockResolvedValue(null);
    const result = await handleGetOuraIntraNightHrv(mockPool, { date: "2020-01-01" });
    expect(result).toContain("No long_sleep recorded for 2020-01-01");
  });

  it("handles missing HRV/HR series gracefully", async () => {
    mockQueries.getOuraIntraNightHrv.mockResolvedValue({
      day: new Date("2026-04-29"),
      bedtime_start: null,
      hrv_5min: null,
      heart_rate_5min: null,
    });
    const result = await handleGetOuraIntraNightHrv(mockPool, { date: "2026-04-29" });
    const parsed = JSON.parse(result);
    expect(parsed.hrv_stats).toBeNull();
    expect(parsed.hr_stats).toBeNull();
    expect(parsed.interval_seconds).toBe(300);
  });
});
