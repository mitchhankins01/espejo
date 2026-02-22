import { describe, it, expect, vi } from "vitest";
import {
  getTotalApiCostSince,
  getLastCostNotificationTime,
  getTopPatterns,
  pruneExpiredEventPatterns,
  countStaleEventPatterns,
  insertSoulQualitySignal,
  insertPulseCheck,
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

  it("maps soul quality signal metadata to {} when row metadata is nullish", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 1,
          chat_id: "100",
          assistant_message_id: null,
          signal_type: "felt_personal",
          soul_version: 1,
          pattern_count: 0,
          metadata: undefined,
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
    const pool = {
      query,
    } as unknown as Parameters<typeof insertSoulQualitySignal>[0];

    const result = await insertSoulQualitySignal(pool, {
      chatId: "100",
      assistantMessageId: null,
      signalType: "felt_personal",
      soulVersion: 1,
      patternCount: 0,
      metadata: {},
    });

    expect(result.metadata).toEqual({});
  });

  it("maps pulse check nullish JSON fields to empty defaults", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 7,
          chat_id: "100",
          status: "stale",
          personal_ratio: "0.1",
          correction_rate: "0.2",
          signal_counts: undefined,
          repairs_applied: undefined,
          soul_version_before: 1,
          soul_version_after: 1,
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
    const pool = { query } as unknown as Parameters<typeof insertPulseCheck>[0];

    const result = await insertPulseCheck(pool, {
      chatId: "100",
      status: "stale",
      personalRatio: 0.1,
      correctionRate: 0.2,
      signalCounts: {},
      repairsApplied: [],
      soulVersionBefore: 1,
      soulVersionAfter: 1,
    });

    expect(result.signal_counts).toEqual({});
    expect(result.repairs_applied).toEqual([]);
  });
});
