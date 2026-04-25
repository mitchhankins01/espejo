import { describe, it, expect, vi } from "vitest";
import type pg from "pg";

import { logUsage } from "../../src/db/queries.js";

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
});
