import { describe, it, expect, vi } from "vitest";
import {
  getTotalApiCostSince,
  getLastCostNotificationTime,
  getTopPatterns,
  pruneExpiredEventPatterns,
  countStaleEventPatterns,
} from "../../src/db/queries.js";

describe("queries defensive fallbacks", () => {
  it("returns 0 total cost when aggregate query yields no rows", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Parameters<typeof getTotalApiCostSince>[0];

    const total = await getTotalApiCostSince(pool, new Date(0), new Date());
    expect(total).toBe(0);
  });

  it("returns null when no cost notification row exists", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Parameters<
      typeof getLastCostNotificationTime
    >[0];

    const last = await getLastCostNotificationTime(pool, "123");
    expect(last).toBeNull();
  });

  it("maps pattern row defaults for source metadata when absent", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 1,
          content: "pattern",
          kind: "behavior",
          confidence: "0.8",
          strength: "1.0",
          times_seen: 1,
          status: "active",
          temporal: null,
          canonical_hash: "abc",
          source_type: undefined,
          source_id: undefined,
          expires_at: undefined,
          first_seen: new Date("2026-01-01T00:00:00Z"),
          last_seen: new Date("2026-01-02T00:00:00Z"),
          created_at: new Date("2026-01-03T00:00:00Z"),
        },
      ],
    });
    const pool = { query } as unknown as Parameters<typeof getTopPatterns>[0];

    const results = await getTopPatterns(pool, 1);
    expect(results).toHaveLength(1);
    expect(results[0].source_type).toBe("compaction");
    expect(results[0].source_id).toBeNull();
    expect(results[0].expires_at).toBeNull();
  });

  it("returns 0 for expired-pattern pruning when rowCount is missing", async () => {
    const query = vi.fn().mockResolvedValue({});
    const pool = { query } as unknown as Parameters<
      typeof pruneExpiredEventPatterns
    >[0];

    const changed = await pruneExpiredEventPatterns(pool);
    expect(changed).toBe(0);
  });

  it("returns 0 stale events when count query yields no rows", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Parameters<
      typeof countStaleEventPatterns
    >[0];

    const count = await countStaleEventPatterns(pool);
    expect(count).toBe(0);
  });
});
