import { describe, it, expect, vi } from "vitest";
import type pg from "pg";

import { deleteWeight, getWeightPatterns, listWeights } from "../../src/db/queries.js";

describe("weight query parsing", () => {
  it("parses string timestamps from postgres rows", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            date: "2026-02-21",
            weight_kg: "82.3",
            created_at: "2026-02-21T08:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ count: 1 }],
      });
    const pool = { query } as unknown as pg.Pool;

    const result = await listWeights(pool);

    expect(result.count).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].date.toISOString()).toBe("2026-02-21T00:00:00.000Z");
    expect(result.rows[0].created_at).toBeInstanceOf(Date);
    expect(result.rows[0].created_at.toISOString()).toBe("2026-02-21T08:00:00.000Z");
    expect(result.rows[0].weight_kg).toBe(82.3);
  });

  it("increments streak for consecutive daily logs", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            date: "2026-02-10",
            weight_kg: "81.4",
            created_at: "2026-02-10T08:00:00.000Z",
          },
          {
            date: "2026-02-09",
            weight_kg: "81.5",
            created_at: "2026-02-09T08:00:00.000Z",
          },
          {
            date: "2026-02-08",
            weight_kg: "81.6",
            created_at: "2026-02-08T08:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ count: 3 }],
      });
    const pool = { query } as unknown as pg.Pool;

    const patterns = await getWeightPatterns(pool);

    expect(patterns.streak_days).toBe(3);
    expect(patterns.logged_days).toBe(3);
  });

  it("treats null rowCount as not deleted", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: null });
    const pool = { query } as unknown as pg.Pool;

    const deleted = await deleteWeight(pool, "2026-02-10");

    expect(deleted).toBe(false);
  });
});
