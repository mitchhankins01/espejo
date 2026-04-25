import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWeights = vi.hoisted(() => ({
  upsertWeight: vi.fn(),
}));

vi.mock("../../src/db/queries/weights.js", () => mockWeights);

import { handleLogWeights } from "../../src/tools/log-weights.js";

const mockPool = {} as unknown as import("pg").Pool;

beforeEach(() => {
  mockWeights.upsertWeight.mockReset().mockResolvedValue({
    date: new Date("2026-04-25T00:00:00.000Z"),
    weight_kg: 78.2,
    created_at: new Date(),
  });
});

describe("handleLogWeights", () => {
  it("returns a single weight with its date and kg value", async () => {
    const result = await handleLogWeights(mockPool, {
      measurements: [{ date: "2026-04-25", weight_kg: 78.2 }],
    });

    expect(mockWeights.upsertWeight).toHaveBeenCalledTimes(1);
    expect(mockWeights.upsertWeight).toHaveBeenCalledWith(
      mockPool,
      "2026-04-25",
      78.2
    );
    expect(result).toBe("Logged 1 weight: 2026-04-25 (78.2 kg)");
  });

  it("returns each date+weight pair, newest first", async () => {
    const result = await handleLogWeights(mockPool, {
      measurements: [
        { date: "2026-04-22", weight_kg: 78.4 },
        { date: "2026-04-25", weight_kg: 78.2 },
        { date: "2026-04-24", weight_kg: 78.1 },
      ],
    });

    expect(mockWeights.upsertWeight).toHaveBeenCalledTimes(3);
    expect(result).toBe(
      "Logged 3 weights: 2026-04-25 (78.2 kg), 2026-04-24 (78.1 kg), 2026-04-22 (78.4 kg)"
    );
  });

  it("rounds each weight to one decimal place", async () => {
    const result = await handleLogWeights(mockPool, {
      measurements: [{ date: "2026-04-25", weight_kg: 78.234 }],
    });
    expect(result).toBe("Logged 1 weight: 2026-04-25 (78.2 kg)");
  });

  it("rejects an empty measurements array", async () => {
    await expect(
      handleLogWeights(mockPool, { measurements: [] })
    ).rejects.toThrow();
  });

  it("rejects non-positive weight values", async () => {
    await expect(
      handleLogWeights(mockPool, {
        measurements: [{ date: "2026-04-25", weight_kg: 0 }],
      })
    ).rejects.toThrow();
    await expect(
      handleLogWeights(mockPool, {
        measurements: [{ date: "2026-04-25", weight_kg: -10 }],
      })
    ).rejects.toThrow();
  });

  it("rejects malformed dates", async () => {
    await expect(
      handleLogWeights(mockPool, {
        measurements: [{ date: "April 25", weight_kg: 78.2 }],
      })
    ).rejects.toThrow();
    await expect(
      handleLogWeights(mockPool, {
        measurements: [{ date: "2026-4-25", weight_kg: 78.2 }],
      })
    ).rejects.toThrow();
  });

});
