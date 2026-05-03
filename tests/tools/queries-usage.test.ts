import { describe, it, expect, vi } from "vitest";
import type pg from "pg";

import {
  bulkInsertUsageLogs,
  latestUsageLogTs,
  logUsage,
} from "../../src/db/queries.js";

function fakePool(query: ReturnType<typeof vi.fn>): pg.Pool {
  return { query } as unknown as pg.Pool;
}

describe("logUsage", () => {
  it("fires INSERT with all fields populated", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = fakePool(query);

    logUsage(pool, {
      source: "mcp",
      surface: "mcp-stdio",
      actor: "claude-desktop",
      action: "search_entries",
      args: { query: "stress" },
      ok: true,
      durationMs: 42,
      meta: { rrf_k: 60 },
    });

    // Helper is fire-and-forget; flush microtasks so the query call lands.
    await new Promise((r) => setImmediate(r));

    expect(query).toHaveBeenCalledTimes(1);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([
      "mcp",
      "mcp-stdio",
      "claude-desktop",
      "search_entries",
      JSON.stringify({ query: "stress" }),
      true,
      null,
      42,
      JSON.stringify({ rrf_k: 60 }),
    ]);
  });

  it("nulls optional fields when omitted", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = fakePool(query);

    logUsage(pool, { source: "cron", action: "oura-sync", ok: true });
    await new Promise((r) => setImmediate(r));

    const [, params] = query.mock.calls[0];
    expect(params).toEqual([
      "cron",
      null,
      null,
      "oura-sync",
      null,
      true,
      null,
      null,
      null,
    ]);
  });

  it("captures error string when ok is false", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = fakePool(query);

    logUsage(pool, {
      source: "telegram",
      action: "log_weights",
      ok: false,
      error: "OpenAI vision call failed",
    });
    await new Promise((r) => setImmediate(r));

    const [, params] = query.mock.calls[0];
    expect(params[5]).toBe(false);
    expect(params[6]).toBe("OpenAI vision call failed");
  });

  it("replaces oversized payload with truncation marker", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = fakePool(query);

    const huge = "x".repeat(1_500_000);
    logUsage(pool, {
      source: "http",
      action: "POST /test",
      ok: true,
      args: { body: huge },
    });
    await new Promise((r) => setImmediate(r));

    const [, params] = query.mock.calls[0];
    const argsJson = JSON.parse(params[4] as string);
    expect(argsJson).toMatchObject({ __truncated: true });
    expect(argsJson.original_bytes).toBeGreaterThan(1_500_000);
  });

  it("handles unserializable args gracefully", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = fakePool(query);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    logUsage(pool, {
      source: "script",
      action: "weird-args",
      ok: true,
      args: cyclic,
    });
    await new Promise((r) => setImmediate(r));

    const [, params] = query.mock.calls[0];
    const argsJson = JSON.parse(params[4] as string);
    expect(argsJson).toEqual({ __unserializable: true });
  });

  it("swallows DB errors so the caller never sees them", async () => {
    const query = vi.fn().mockRejectedValue(new Error("usage_logs is down"));
    const pool = fakePool(query);
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      logUsage(pool, { source: "mcp", action: "x", ok: true })
    ).not.toThrow();

    await new Promise((r) => setImmediate(r));
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("inserts a leading ts column when ts is provided (backdating)", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = fakePool(query);
    const ts = new Date("2026-04-01T12:00:00Z");

    logUsage(pool, {
      source: "shell",
      surface: "mitch-mbp",
      actor: "/Users/mitch",
      action: "git",
      ok: true,
      ts,
    });
    await new Promise((r) => setImmediate(r));

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO usage_logs[\s\S]*\(ts,/);
    expect(params[0]).toBe(ts);
    expect(params[1]).toBe("shell");
  });
});

describe("bulkInsertUsageLogs", () => {
  it("no-ops when input is empty", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    await bulkInsertUsageLogs(fakePool(query), []);
    expect(query).not.toHaveBeenCalled();
  });

  it("issues one multi-row INSERT with backdated ts on every row", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });
    const pool = fakePool(query);
    const t1 = new Date("2026-04-01T00:00:00Z");
    const t2 = new Date("2026-04-02T00:00:00Z");

    await bulkInsertUsageLogs(pool, [
      { source: "shell", action: "ls", ok: true, ts: t1 },
      { source: "shell", action: "pwd", ok: true, ts: t2 },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO usage_logs");
    expect(sql).toContain("$1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb");
    expect(sql).toContain("$11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20::jsonb");
    expect(params[0]).toBe(t1);
    expect(params[10]).toBe(t2);
    // Cols per row: ts, source, surface, actor, action, args, ok, error, duration_ms, meta
    expect(params[4]).toBe("ls");
    expect(params[14]).toBe("pwd");
  });

  it("propagates DB errors to the caller (unlike logUsage)", async () => {
    const query = vi
      .fn()
      .mockRejectedValue(new Error("connection terminated"));
    await expect(
      bulkInsertUsageLogs(fakePool(query), [
        {
          source: "shell",
          action: "ls",
          ok: true,
          ts: new Date(),
        },
      ])
    ).rejects.toThrow(/connection terminated/);
  });
});

describe("latestUsageLogTs", () => {
  it("returns the MAX(ts) for the given source", async () => {
    const ts = new Date("2026-05-02T03:04:05Z");
    const query = vi.fn().mockResolvedValue({ rows: [{ ts }] });
    const out = await latestUsageLogTs(fakePool(query), "shell");
    expect(out).toBe(ts);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("MAX(ts)");
    expect(params).toEqual(["shell"]);
  });

  it("returns null when nothing has been ingested for that source", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ts: null }] });
    const out = await latestUsageLogTs(fakePool(query), "shell");
    expect(out).toBeNull();
  });
});
