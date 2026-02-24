import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: { oura: { accessToken: "test-token" } },
}));

import { OuraClient } from "../../src/oura/client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function apiResponse(data: unknown[], nextToken?: string): Response {
  return {
    ok: true,
    json: () => Promise.resolve({ data, next_token: nextToken ?? null }),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

function apiError(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

let client: OuraClient;

beforeEach(() => {
  mockFetch.mockReset();
  client = new OuraClient("test-token");
});

describe("OuraClient", () => {
  describe("fetchCollection (via getDailySleep)", () => {
    it("returns data from API", async () => {
      mockFetch.mockResolvedValue(apiResponse([{ day: "2025-01-15", score: 85 }]));
      const result = await client.getDailySleep("2025-01-15", "2025-01-15");
      expect(result).toEqual([{ day: "2025-01-15", score: 85 }]);
      expect(mockFetch).toHaveBeenCalledOnce();
      const url = mockFetch.mock.calls[0][0] as URL;
      expect(url.toString()).toContain("daily_sleep");
      expect(url.searchParams.get("start_date")).toBe("2025-01-15");
    });

    it("returns empty array when no token", async () => {
      const emptyClient = new OuraClient("");
      const result = await emptyClient.getDailySleep("2025-01-15", "2025-01-15");
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws on API error", async () => {
      mockFetch.mockResolvedValue(apiError(401, "Unauthorized"));
      await expect(client.getDailySleep("2025-01-15", "2025-01-15")).rejects.toThrow(
        "Oura API daily_sleep failed (401): Unauthorized"
      );
    });

    it("handles null data in response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: null }),
        text: () => Promise.resolve(""),
      } as unknown as Response);
      const result = await client.getDailySleep("2025-01-15", "2025-01-15");
      expect(result).toEqual([]);
    });

    it("follows next_token across pages", async () => {
      mockFetch
        .mockResolvedValueOnce(apiResponse([{ day: "2025-01-15" }], "page2"))
        .mockResolvedValueOnce(apiResponse([{ day: "2025-01-16" }]));

      const result = await client.getDailySleep("2025-01-15", "2025-01-16");
      expect(result).toEqual([{ day: "2025-01-15" }, { day: "2025-01-16" }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const secondUrl = mockFetch.mock.calls[1][0] as URL;
      expect(secondUrl.searchParams.get("next_token")).toBe("page2");
    });

    it("stops paginating when next_token is null", async () => {
      mockFetch.mockResolvedValueOnce(apiResponse([{ day: "2025-01-15" }]));

      const result = await client.getDailySleep("2025-01-15", "2025-01-15");
      expect(result).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("getSleepSessions — single-date workaround", () => {
    it("expands ±1 day and filters for single-date queries", async () => {
      mockFetch.mockResolvedValue(
        apiResponse([
          { day: "2025-01-14", id: "a" },
          { day: "2025-01-15", id: "b" },
          { day: "2025-01-16", id: "c" },
        ])
      );
      const result = await client.getSleepSessions("2025-01-15", "2025-01-15");
      expect(result).toEqual([{ day: "2025-01-15", id: "b" }]);
      const url = mockFetch.mock.calls[0][0] as URL;
      expect(url.searchParams.get("start_date")).toBe("2025-01-14");
      expect(url.searchParams.get("end_date")).toBe("2025-01-16");
    });

    it("passes through for multi-date ranges", async () => {
      mockFetch.mockResolvedValue(apiResponse([{ day: "2025-01-15" }]));
      await client.getSleepSessions("2025-01-14", "2025-01-16");
      const url = mockFetch.mock.calls[0][0] as URL;
      expect(url.searchParams.get("start_date")).toBe("2025-01-14");
      expect(url.searchParams.get("end_date")).toBe("2025-01-16");
    });
  });

  describe("getDailyActivity — single-date workaround", () => {
    it("expands ±1 day and filters for single-date queries", async () => {
      mockFetch.mockResolvedValue(
        apiResponse([
          { day: "2025-01-14" },
          { day: "2025-01-15" },
        ])
      );
      const result = await client.getDailyActivity("2025-01-15", "2025-01-15");
      expect(result).toEqual([{ day: "2025-01-15" }]);
    });

    it("passes through for multi-date ranges", async () => {
      mockFetch.mockResolvedValue(apiResponse([]));
      await client.getDailyActivity("2025-01-14", "2025-01-16");
      const url = mockFetch.mock.calls[0][0] as URL;
      expect(url.searchParams.get("start_date")).toBe("2025-01-14");
    });
  });

  describe("getDailyReadiness", () => {
    it("calls daily_readiness endpoint", async () => {
      mockFetch.mockResolvedValue(apiResponse([{ day: "2025-01-15", score: 80 }]));
      const result = await client.getDailyReadiness("2025-01-15", "2025-01-15");
      expect(result).toEqual([{ day: "2025-01-15", score: 80 }]);
      const url = mockFetch.mock.calls[0][0] as URL;
      expect(url.toString()).toContain("daily_readiness");
    });
  });

  describe("getDailyStress", () => {
    it("calls daily_stress endpoint", async () => {
      mockFetch.mockResolvedValue(apiResponse([{ day: "2025-01-15" }]));
      const result = await client.getDailyStress("2025-01-15", "2025-01-15");
      expect(result).toHaveLength(1);
    });
  });

  describe("getWorkouts — single-date workaround", () => {
    it("expands ±1 day and filters for single-date queries", async () => {
      mockFetch.mockResolvedValue(
        apiResponse([
          { day: "2025-01-14" },
          { day: "2025-01-15" },
          { day: "2025-01-15" },
        ])
      );
      const result = await client.getWorkouts("2025-01-15", "2025-01-15");
      expect(result).toHaveLength(2);
    });

    it("passes through for multi-date ranges", async () => {
      mockFetch.mockResolvedValue(apiResponse([]));
      await client.getWorkouts("2025-01-14", "2025-01-16");
      const url = mockFetch.mock.calls[0][0] as URL;
      expect(url.searchParams.get("start_date")).toBe("2025-01-14");
    });
  });

  describe("single-date workaround filters out items with null day", () => {
    it("getSleepSessions filters null day", async () => {
      mockFetch.mockResolvedValue(
        apiResponse([{ id: "a" }, { day: "2025-01-15", id: "b" }])
      );
      const result = await client.getSleepSessions("2025-01-15", "2025-01-15");
      expect(result).toEqual([{ day: "2025-01-15", id: "b" }]);
    });
  });
});
