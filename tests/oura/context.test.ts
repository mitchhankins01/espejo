import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getOuraSummaryByDay: vi.fn(),
}));

const mockConfig = vi.hoisted(() => ({
  config: {
    oura: { accessToken: "test-token" },
    timezone: "Europe/Madrid",
  },
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => mockConfig);

import { buildOuraContextPrompt } from "../../src/oura/context.js";

const mockPool = {} as any;

beforeEach(() => {
  mockQueries.getOuraSummaryByDay.mockReset();
  mockConfig.config.oura.accessToken = "test-token";
});

describe("buildOuraContextPrompt", () => {
  it("returns empty string when no access token", async () => {
    mockConfig.config.oura.accessToken = "";
    const result = await buildOuraContextPrompt(mockPool);
    expect(result).toBe("");
  });

  it("returns empty string when no summary data", async () => {
    mockQueries.getOuraSummaryByDay.mockResolvedValue(null);
    const result = await buildOuraContextPrompt(mockPool);
    expect(result).toBe("");
  });

  it("returns biometric context with all data", async () => {
    mockQueries.getOuraSummaryByDay.mockResolvedValue({
      day: new Date("2025-01-15"),
      sleep_score: 85,
      readiness_score: 80,
      activity_score: 75,
      steps: 8000,
      stress: "normal",
      average_hrv: 42.3,
      average_heart_rate: 60,
      sleep_duration_seconds: 28800,
      deep_sleep_duration_seconds: 7200,
      rem_sleep_duration_seconds: 5400,
      efficiency: 90,
      workout_count: 1,
    });
    const result = await buildOuraContextPrompt(mockPool);
    expect(result).toContain("Oura Ring biometrics:");
    expect(result).toContain("Sleep 85");
    expect(result).toContain("Readiness 80");
    expect(result).toContain("Activity 75");
    expect(result).toContain("HRV 42ms");
    expect(result).toMatch(/8[,.]?000/);
    expect(result).toContain("normal");
    expect(result).toContain("8h 0m");
    expect(result).toContain("efficiency 90%");
  });

  it("handles null scores gracefully", async () => {
    mockQueries.getOuraSummaryByDay.mockResolvedValue({
      day: new Date("2025-01-15"),
      sleep_score: null,
      readiness_score: null,
      activity_score: null,
      steps: null,
      stress: null,
      average_hrv: null,
      average_heart_rate: null,
      sleep_duration_seconds: null,
      deep_sleep_duration_seconds: null,
      rem_sleep_duration_seconds: null,
      efficiency: null,
      workout_count: 0,
    });
    const result = await buildOuraContextPrompt(mockPool);
    expect(result).toContain("n/a");
    // No sleep detail line when sleep_duration_seconds is null
    expect(result).not.toContain("Deep");
  });

  it("shows sleep detail with null efficiency", async () => {
    mockQueries.getOuraSummaryByDay.mockResolvedValue({
      day: new Date("2025-01-15"),
      sleep_score: 80,
      readiness_score: 75,
      activity_score: 70,
      steps: 5000,
      stress: null,
      average_hrv: 40,
      average_heart_rate: 65,
      sleep_duration_seconds: 25200,
      deep_sleep_duration_seconds: 6000,
      rem_sleep_duration_seconds: 4500,
      efficiency: null,
      workout_count: 0,
    });
    const result = await buildOuraContextPrompt(mockPool);
    expect(result).toContain("efficiency n/a%");
    expect(result).toContain("Deep");
  });
});
