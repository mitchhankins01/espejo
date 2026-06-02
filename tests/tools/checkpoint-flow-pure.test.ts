import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    timezone: "Europe/Madrid",
    database: { url: "postgresql://test:test@localhost:5433/journal_test" },
    anthropic: { apiKey: "sk-test", model: "claude-sonnet-4-6" },
    openai: { apiKey: "sk-test", chatModel: "gpt-5-mini", embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536 },
    telegram: { voiceModel: "gpt-4o-mini-tts", voiceName: "alloy" },
    r2: { accountId: "x", accessKeyId: "x", secretAccessKey: "x", bucketName: "x", publicUrl: "https://x" },
    gmail: {},
    server: {},
  },
}));

vi.mock("../../src/db/client.js", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

import { assignCheckpointSlots } from "../../src/telegram/flows/checkpoint.js";

describe("assignCheckpointSlots", () => {
  it("maps trigger / body / voice from three pieces, no comment", () => {
    const r = assignCheckpointSlots(["Nic", "head", "keep moving"]);
    expect(r).toEqual({
      trigger: "Nic",
      bodySignal: "head",
      partVoice: "keep moving",
      comment: null,
    });
  });

  it("routes the 4th piece into comment", () => {
    const r = assignCheckpointSlots([
      "ritalin",
      "a slow brain",
      "i want to start the day",
      "i took 10mg today instead of 30",
    ]);
    expect(r).toEqual({
      trigger: "ritalin",
      bodySignal: "a slow brain",
      partVoice: "i want to start the day",
      comment: "i took 10mg today instead of 30",
    });
  });

  it("folds pieces past the 4th into comment, joined by '. '", () => {
    const r = assignCheckpointSlots(["a", "b", "c", "d", "e"]);
    expect(r.partVoice).toBe("c");
    expect(r.comment).toBe("d. e");
  });

  it("respects prefilled trigger + body so the message fills voice then comment", () => {
    const r = assignCheckpointSlots(["just one", "felt fine"], {
      trigger: "Nic",
      bodySignal: "throat",
    });
    expect(r).toEqual({
      trigger: "Nic",
      bodySignal: "throat",
      partVoice: "just one",
      comment: "felt fine",
    });
  });

  it("logs a bare blob as the trigger alone", () => {
    const r = assignCheckpointSlots(["just nic"]);
    expect(r).toEqual({
      trigger: "just nic",
      bodySignal: null,
      partVoice: null,
      comment: null,
    });
  });
});
