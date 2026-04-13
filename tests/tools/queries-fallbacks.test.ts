import { describe, it, expect, vi } from "vitest";
import {
  isObservableDbTableName,
  listObservableTables,
  listObservableTableRows,
  listRecentDbChanges,
} from "../../src/db/queries.js";

describe("queries defensive fallbacks", () => {
  it("validates observable DB table names", () => {
    expect(isObservableDbTableName("knowledge_artifacts")).toBe(true);
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
        rows: [{ id: "art-1", title: "Test artifact", kind: "note" }],
      })
      .mockResolvedValueOnce({
        rows: [{ count: 1 }],
      });
    const pool = { query } as unknown as Parameters<typeof listObservableTableRows>[0];

    const result = await listObservableTableRows(pool, "knowledge_artifacts", {
      limit: 50,
      offset: 0,
      q: "Test",
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
      listObservableTableRows(pool, "knowledge_artifacts", {
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
