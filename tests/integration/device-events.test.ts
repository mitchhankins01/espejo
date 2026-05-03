import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import {
  upsertDeviceEvent,
  upsertDeviceEvents,
  latestStartedAt,
  latestDeviceEventIngestedAt,
} from "../../src/db/queries/device-events.js";

describe("device_events queries", () => {
  it("upsertDeviceEvent inserts a new row", async () => {
    await upsertDeviceEvent(pool, {
      source: "activitywatch",
      sourceEventId: "aw-watcher-window_h/1",
      bucket: "window",
      startedAt: new Date("2026-05-02T10:00:00Z"),
      endedAt: new Date("2026-05-02T10:02:00Z"),
      durationMs: 120000,
      app: "Code",
      title: "main.ts",
      hostname: "h",
      data: { kind: "window" },
    });
    const r = await pool.query(
      "SELECT app, title, duration_ms FROM device_events WHERE source_event_id = $1",
      ["aw-watcher-window_h/1"]
    );
    expect(r.rows[0].app).toBe("Code");
    expect(r.rows[0].title).toBe("main.ts");
    expect(r.rows[0].duration_ms).toBe(120000);
  });

  it("upsertDeviceEvent updates on (source, source_event_id) conflict", async () => {
    const ev = {
      source: "activitywatch",
      sourceEventId: "aw-watcher-window_h/2",
      bucket: "window" as const,
      startedAt: new Date("2026-05-02T10:00:00Z"),
      endedAt: new Date("2026-05-02T10:01:00Z"),
      durationMs: 60000,
      app: "Code",
      title: "first.ts",
      hostname: "h",
    };
    await upsertDeviceEvent(pool, ev);
    await upsertDeviceEvent(pool, {
      ...ev,
      title: "second.ts",
      durationMs: 120000,
      endedAt: new Date("2026-05-02T10:02:00Z"),
    });
    const r = await pool.query(
      "SELECT title, duration_ms FROM device_events WHERE source_event_id = $1",
      ["aw-watcher-window_h/2"]
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].title).toBe("second.ts");
    expect(r.rows[0].duration_ms).toBe(120000);
  });

  it("upsertDeviceEvents handles empty + batched rows transactionally", async () => {
    await upsertDeviceEvents(pool, []);
    await upsertDeviceEvents(pool, [
      {
        source: "activitywatch",
        sourceEventId: "batch/a",
        bucket: "window",
        startedAt: new Date("2026-05-02T10:00:00Z"),
      },
      {
        source: "activitywatch",
        sourceEventId: "batch/b",
        bucket: "afk",
        startedAt: new Date("2026-05-02T10:05:00Z"),
      },
    ]);
    const r = await pool.query(
      "SELECT bucket FROM device_events WHERE source_event_id LIKE 'batch/%' ORDER BY source_event_id"
    );
    expect(r.rows.map((x) => x.bucket)).toEqual(["window", "afk"]);
  });

  it("latestStartedAt returns the max watermark per source/bucket", async () => {
    await upsertDeviceEvent(pool, {
      source: "activitywatch",
      sourceEventId: "wm/1",
      bucket: "window",
      startedAt: new Date("2026-05-02T09:00:00Z"),
    });
    await upsertDeviceEvent(pool, {
      source: "activitywatch",
      sourceEventId: "wm/2",
      bucket: "window",
      startedAt: new Date("2026-05-02T11:00:00Z"),
    });
    await upsertDeviceEvent(pool, {
      source: "activitywatch",
      sourceEventId: "wm/3",
      bucket: "afk",
      startedAt: new Date("2026-05-03T11:00:00Z"),
    });

    const allMax = await latestStartedAt(pool, "activitywatch");
    expect(allMax?.toISOString()).toBe("2026-05-03T11:00:00.000Z");

    const windowMax = await latestStartedAt(pool, "activitywatch", "window");
    expect(windowMax?.toISOString()).toBe("2026-05-02T11:00:00.000Z");

    const noneMax = await latestStartedAt(pool, "activitywatch", "focus");
    expect(noneMax).toBeNull();
  });

  it("latestDeviceEventIngestedAt returns max ingested_at", async () => {
    await upsertDeviceEvent(pool, {
      source: "activitywatch",
      sourceEventId: "ing/1",
      bucket: "window",
      startedAt: new Date("2026-05-02T10:00:00Z"),
    });
    const ts = await latestDeviceEventIngestedAt(pool);
    expect(ts).toBeInstanceOf(Date);
  });
});
