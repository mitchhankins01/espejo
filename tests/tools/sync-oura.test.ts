import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

const mockSync = vi.hoisted(() => ({
  runOuraSync: vi.fn(),
}));

vi.mock("../../src/oura/sync.js", () => mockSync);

import { handleSyncOura } from "../../src/tools/sync-oura.js";

const mockPool = {} as never;

beforeEach(() => {
  mockSync.runOuraSync.mockReset();
});

describe("sync_oura spec", () => {
  it("defaults lookback_days to 2", () => {
    expect(validateToolInput("sync_oura", {}).lookback_days).toBe(2);
  });
  it("rejects out-of-range lookback_days", () => {
    expect(() => validateToolInput("sync_oura", { lookback_days: 0 })).toThrow();
    expect(() => validateToolInput("sync_oura", { lookback_days: 31 })).toThrow();
  });
  it("has the expected tool name", () => {
    expect(toolSpecs.sync_oura.name).toBe("sync_oura");
  });
});

describe("handleSyncOura", () => {
  it("returns the formatted summary from runOuraSync", async () => {
    mockSync.runOuraSync.mockResolvedValueOnce({
      runId: 42,
      total: 100,
      counts: { sleep: 3, sessions: 2, readiness: 3, activity: 3, stress: 3, workouts: 0, spo2: 3, resilience: 3, cv_age: 3, sleep_time: 3, enhanced_tags: 1, rest_mode: 0, meditation_sessions: 1, heartrate: 720, personal_info: 1, ring_configurations: 1 },
      durationMs: 1234,
    });
    const result = await handleSyncOura(mockPool, {});
    expect(result).toContain('"run_id": 42');
    expect(result).toContain('"total": 100');
    expect(result).toContain('"duration_ms": 1234');
    expect(mockSync.runOuraSync).toHaveBeenCalledWith(mockPool, 2);
  });

  it("passes a custom lookback_days", async () => {
    mockSync.runOuraSync.mockResolvedValueOnce({
      runId: 1,
      total: 0,
      counts: { sleep: 0, sessions: 0, readiness: 0, activity: 0, stress: 0, workouts: 0, spo2: 0, resilience: 0, cv_age: 0, sleep_time: 0, enhanced_tags: 0, rest_mode: 0, meditation_sessions: 0, heartrate: 0, personal_info: 0, ring_configurations: 0 },
      durationMs: 5,
    });
    await handleSyncOura(mockPool, { lookback_days: 7 });
    expect(mockSync.runOuraSync).toHaveBeenCalledWith(mockPool, 7);
  });

  it("returns a skip message when runOuraSync returns null", async () => {
    mockSync.runOuraSync.mockResolvedValueOnce(null);
    const result = await handleSyncOura(mockPool, {});
    expect(result).toContain("Oura sync skipped");
  });
});
