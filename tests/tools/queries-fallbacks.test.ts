import { describe, it, expect, vi } from "vitest";
import {
  getTotalApiCostSince,
  getLastCostNotificationTime,
  getTopPatterns,
  pruneExpiredEventPatterns,
  countStaleEventPatterns,
  isObservableDbTableName,
  listObservableTables,
  listObservableTableRows,
  listRecentDbChanges,
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

  it("validates observable DB table names", () => {
    expect(isObservableDbTableName("todos")).toBe(true);
    expect(isObservableDbTableName("not_a_table")).toBe(false);
  });

  it("lists observable table metadata with counts", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ row_count: 3, last_changed_at: new Date("2026-03-01T12:00:00Z") }],
    });
    const pool = { query } as unknown as Parameters<typeof listObservableTables>[0];

    const tables = await listObservableTables(pool);

    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0]).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        row_count: 3,
      })
    );
    expect(query).toHaveBeenCalled();
  });

  it("lists observable table rows with metadata", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: "todo-1", title: "Write tests", status: "active" }],
      })
      .mockResolvedValueOnce({
        rows: [{ count: 1 }],
      });
    const pool = { query } as unknown as Parameters<typeof listObservableTableRows>[0];

    const result = await listObservableTableRows(pool, "todos", {
      limit: 50,
      offset: 0,
      q: "Write",
      order: "desc",
    });

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.columns.some((column) => column.name === "title")).toBe(true);
  });

  it("throws for unsupported sortable column in observable table rows", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Parameters<typeof listObservableTableRows>[0];

    await expect(
      listObservableTableRows(pool, "todos", {
        limit: 10,
        offset: 0,
        sort: "does_not_exist",
      })
    ).rejects.toThrow(/Unsupported sort column/);
    expect(query).not.toHaveBeenCalled();
  });

  it("builds recent DB changes including tool_call activity", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            chat_id: "123",
            tool_calls: [{ name: "search_entries" }],
            created_at: new Date("2026-03-01T12:00:00Z"),
          },
        ],
      })
      .mockResolvedValue({
        rows: [
          {
            row_id: "artifact-1",
            changed_at: new Date("2026-03-01T11:00:00Z"),
            operation: "update",
          },
        ],
      });
    const pool = { query } as unknown as Parameters<typeof listRecentDbChanges>[0];

    const changes = await listRecentDbChanges(pool, { limit: 5 });

    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((change) => change.operation === "tool_call")).toBe(true);
  });
});
