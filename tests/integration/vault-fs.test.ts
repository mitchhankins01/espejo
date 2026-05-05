import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import {
  insertVaultFsEvent,
  insertVaultFsEvents,
} from "../../src/db/queries/vault-fs.js";

describe("vault_fs_events queries", () => {
  it("inserts a single event with full attribution", async () => {
    await insertVaultFsEvent(pool, {
      source: "eslogger",
      eventType: "unlink",
      path: "/vault/Note/Foo.md",
      processName: "Obsidian",
      pid: 123,
      ppid: 1,
      raw: { extra: "info" },
    });
    const r = await pool.query(
      `SELECT source, event_type, path, process_name, pid, ppid, raw
       FROM vault_fs_events WHERE path = $1`,
      ["/vault/Note/Foo.md"]
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      source: "eslogger",
      event_type: "unlink",
      path: "/vault/Note/Foo.md",
      process_name: "Obsidian",
      pid: 123,
      ppid: 1,
    });
    expect(r.rows[0].raw).toEqual({ extra: "info" });
  });

  it("inserts a single event without optional attribution", async () => {
    await insertVaultFsEvent(pool, {
      source: "fswatch",
      eventType: "create",
      path: "/vault/Note/Bar.md",
    });
    const r = await pool.query(
      `SELECT process_name, pid, ppid, raw FROM vault_fs_events WHERE path = $1`,
      ["/vault/Note/Bar.md"]
    );
    expect(r.rows[0]).toMatchObject({
      process_name: null,
      pid: null,
      ppid: null,
      raw: null,
    });
  });

  it("respects an explicit ts when provided", async () => {
    const ts = new Date("2026-01-01T12:00:00Z");
    await insertVaultFsEvent(pool, {
      source: "manual",
      eventType: "modify",
      path: "/vault/Note/Tsd.md",
      ts,
    });
    const r = await pool.query(
      `SELECT ts FROM vault_fs_events WHERE path = $1`,
      ["/vault/Note/Tsd.md"]
    );
    expect(new Date(r.rows[0].ts).toISOString()).toBe(ts.toISOString());
  });

  it("bulk-inserts a batch of events", async () => {
    await insertVaultFsEvents(pool, [
      { source: "fswatch", eventType: "create", path: "/v/a.md" },
      {
        source: "eslogger",
        eventType: "unlink",
        path: "/v/b.md",
        processName: "p",
        pid: 1,
      },
    ]);
    const r = await pool.query(
      `SELECT path FROM vault_fs_events WHERE path IN ('/v/a.md', '/v/b.md') ORDER BY path`
    );
    expect(r.rows.map((row) => row.path)).toEqual(["/v/a.md", "/v/b.md"]);
  });

  it("bulk-insert mixes ts-bearing and ts-less rows in one query", async () => {
    const ts = new Date("2026-02-01T00:00:00Z");
    await insertVaultFsEvents(pool, [
      { source: "fswatch", eventType: "create", path: "/v/c.md", ts },
      { source: "fswatch", eventType: "unlink", path: "/v/d.md" },
    ]);
    const r = await pool.query(
      `SELECT path, ts FROM vault_fs_events WHERE path IN ('/v/c.md', '/v/d.md') ORDER BY path`
    );
    expect(new Date(r.rows[0].ts).toISOString()).toBe(ts.toISOString());
    expect(r.rows[1].ts).toBeInstanceOf(Date);
  });

  it("bulk-insert is a no-op for an empty batch", async () => {
    await insertVaultFsEvents(pool, []);
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM vault_fs_events`);
    expect(typeof r.rows[0].n).toBe("number");
  });

  it("truncates oversized raw payloads with a marker", async () => {
    const big = "x".repeat(100_000);
    await insertVaultFsEvent(pool, {
      source: "fswatch",
      eventType: "modify",
      path: "/vault/Note/Big.md",
      raw: { huge: big },
    });
    const r = await pool.query(
      `SELECT raw FROM vault_fs_events WHERE path = $1`,
      ["/vault/Note/Big.md"]
    );
    expect(r.rows[0].raw).toMatchObject({ __truncated: true });
  });

  it("falls back to a marker when raw cannot be JSON-serialized", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await insertVaultFsEvent(pool, {
      source: "fswatch",
      eventType: "modify",
      path: "/vault/Note/Cyclic.md",
      raw: cyclic,
    });
    const r = await pool.query(
      `SELECT raw FROM vault_fs_events WHERE path = $1`,
      ["/vault/Note/Cyclic.md"]
    );
    expect(r.rows[0].raw).toEqual({ __unserializable: true });
  });
});
