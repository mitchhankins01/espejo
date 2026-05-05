import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import { handleLogCheckpoint } from "../../src/tools/log-checkpoint.js";
import { getCheckpointsForDate } from "../../src/db/queries/checkpoints.js";

describe("handleLogCheckpoint", () => {
  it("inserts a substance toll into checkpoints table", async () => {
    const result = await handleLogCheckpoint(pool, {
      substance: "Nic",
      body: "head + flutter in stomach",
      part_voice: "post-Ritalin surf, keep moving",
      choice: "pass",
    });
    expect(result).toMatch(/^Toll logged at \d{2}:\d{2}\.$/);

    // Sample today's date in Europe/Madrid (uses config.timezone default).
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const rows = await getCheckpointsForDate(pool, today, "substance");
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("Nic");
    expect(rows[0].body_signal).toBe("head + flutter in stomach");
    expect(rows[0].resolution).toBe("pass");
    expect(rows[0].source).toBe("mcp");
  });

  it("rejects a near-duplicate within the 10-minute window", async () => {
    await handleLogCheckpoint(pool, {
      substance: "Weed",
      body: "shoulders heavy",
      part_voice: "wants the off switch",
      choice: "go",
    });
    const second = await handleLogCheckpoint(pool, {
      substance: "weed",
      body: "Shoulders heavy",
      part_voice: "WANTS the off switch",
      choice: "go",
    });
    expect(second).toMatch(/Already logged/);
  });

  it("accepts an explicit kind override", async () => {
    const result = await handleLogCheckpoint(pool, {
      substance: "frustration",
      body: "throat tight",
      part_voice: "wants quiet",
      kind: "parts",
    });
    expect(result).toMatch(/^Toll logged at /);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const rows = await getCheckpointsForDate(pool, today, "parts");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("parts");
  });
});
