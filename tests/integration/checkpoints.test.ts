import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import {
  insertCheckpoint,
  insertCheckpointIdempotent,
  findRecentDuplicate,
  getCheckpointsForDate,
  getRecentCheckpoints,
} from "../../src/db/queries/checkpoints.js";

describe("checkpoints queries", () => {
  it("inserts and retrieves a substance toll", async () => {
    const row = await insertCheckpoint(pool, {
      kind: "substance",
      trigger: "Nic",
      bodySignal: "head + flutter in stomach",
      partVoice: "post-Ritalin surf",
      resolution: "pass",
      localDate: "2026-05-04",
      chatId: "chat-1",
    });
    expect(Number(row.id)).toBeGreaterThan(0);
    expect(row.trigger).toBe("Nic");
    const ld = row.local_date as unknown;
    if (ld instanceof Date) {
      expect(ld.getFullYear()).toBe(2026);
      expect(ld.getMonth()).toBe(4);
      expect(ld.getDate()).toBe(4);
    } else {
      expect(String(ld)).toBe("2026-05-04");
    }

    const found = await getCheckpointsForDate(pool, "2026-05-04", "substance");
    expect(found).toHaveLength(1);
  });

  it("round-trips a free-text comment", async () => {
    const row = await insertCheckpoint(pool, {
      kind: "substance",
      trigger: "Ritalin",
      bodySignal: "a slow brain",
      partVoice: "wants to start the day",
      comment: "took 10mg today instead of 30",
      localDate: "2026-05-04",
    });
    expect(row.comment).toBe("took 10mg today instead of 30");

    const found = await getCheckpointsForDate(pool, "2026-05-04", "substance");
    expect(found[0].comment).toBe("took 10mg today instead of 30");
  });

  it("defaults comment to null when omitted", async () => {
    const row = await insertCheckpoint(pool, {
      kind: "substance",
      trigger: "Nic",
      localDate: "2026-05-04",
    });
    expect(row.comment).toBeNull();
  });

  it("findRecentDuplicate matches case-insensitive within window", async () => {
    await insertCheckpoint(pool, {
      kind: "substance",
      trigger: "Nic",
      bodySignal: "chest pulse",
      partVoice: "wants stimulation",
      resolution: "pass",
      localDate: "2026-05-04",
    });
    const dup = await findRecentDuplicate(pool, {
      kind: "substance",
      trigger: "nic",
      bodySignal: "Chest Pulse",
      partVoice: "WANTS stimulation",
      withinMinutes: 10,
    });
    expect(dup).not.toBeNull();
    expect(dup?.trigger).toBe("Nic");
  });

  it("findRecentDuplicate ignores rows older than window", async () => {
    const old = new Date(Date.now() - 30 * 60_000);
    await insertCheckpoint(pool, {
      kind: "substance",
      trigger: "Weed",
      bodySignal: "shoulders",
      partVoice: "wants down",
      resolution: "pass",
      occurredAt: old,
      localDate: "2026-05-04",
    });
    const dup = await findRecentDuplicate(pool, {
      kind: "substance",
      trigger: "weed",
      bodySignal: "shoulders",
      partVoice: "wants down",
      withinMinutes: 10,
    });
    expect(dup).toBeNull();
  });

  it("insertCheckpointIdempotent skips duplicates with same occurred_at", async () => {
    const occurredAt = new Date("2026-05-04T08:30:00Z");
    const a = await insertCheckpointIdempotent(pool, {
      kind: "substance",
      trigger: "Nic",
      bodySignal: "chest",
      partVoice: "morning surf",
      resolution: "pass",
      occurredAt,
      localDate: "2026-05-04",
    });
    expect(a).not.toBeNull();
    const b = await insertCheckpointIdempotent(pool, {
      kind: "substance",
      trigger: "Nic",
      bodySignal: "chest",
      partVoice: "morning surf",
      resolution: "pass",
      occurredAt,
      localDate: "2026-05-04",
    });
    expect(b).toBeNull();
  });

  it("getCheckpointsForDate filters by kind when provided", async () => {
    await insertCheckpoint(pool, {
      kind: "substance",
      trigger: "Nic",
      localDate: "2026-05-04",
    });
    await insertCheckpoint(pool, {
      kind: "parts",
      trigger: "frustration",
      localDate: "2026-05-04",
    });
    const all = await getCheckpointsForDate(pool, "2026-05-04");
    const justSubstance = await getCheckpointsForDate(pool, "2026-05-04", "substance");
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(justSubstance).toHaveLength(1);
    expect(justSubstance[0].trigger).toBe("Nic");
  });

  it("getRecentCheckpoints returns rows within an inclusive local-date range", async () => {
    await insertCheckpoint(pool, {
      kind: "substance",
      trigger: "Nic",
      localDate: "2026-05-04",
    });
    await insertCheckpoint(pool, {
      kind: "substance",
      trigger: "Weed",
      localDate: "2026-05-06",
    });
    await insertCheckpoint(pool, {
      kind: "substance",
      trigger: "Caffeine",
      localDate: "2026-05-09",
    });
    const rows = await getRecentCheckpoints(pool, {
      fromDate: "2026-05-04",
      toDate: "2026-05-07",
    });
    const triggers = rows.map((r) => r.trigger);
    expect(triggers).toContain("Nic");
    expect(triggers).toContain("Weed");
    expect(triggers).not.toContain("Caffeine");
  });
});
