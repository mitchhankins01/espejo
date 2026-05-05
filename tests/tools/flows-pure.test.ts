import { describe, it, expect, beforeEach, vi } from "vitest";

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
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  },
}));

import { isSoloHnUrl } from "../../src/telegram/flows/distill-hn.js";
import {
  parseWeightSlashArgs,
} from "../../src/telegram/flows/weight-slash.js";
import {
  parseRenphoCsv,
  isWeightCsvDocument,
} from "../../src/telegram/flows/weight-csv.js";
import { truncateToolResult } from "../../src/telegram/truncation.js";
import {
  setFlow,
  getFlow,
  clearFlow,
  isFlowActive,
  clearAllFlows,
} from "../../src/telegram/flow-state.js";

beforeEach(() => {
  clearAllFlows();
});

describe("isSoloHnUrl", () => {
  it("matches a bare HN URL", () => {
    expect(isSoloHnUrl("https://news.ycombinator.com/item?id=12345")).toBe(true);
    expect(isSoloHnUrl("  https://news.ycombinator.com/item?id=42&p=2  ")).toBe(true);
  });
  it("rejects URLs with surrounding text", () => {
    expect(isSoloHnUrl("thoughts? https://news.ycombinator.com/item?id=1")).toBe(false);
    expect(isSoloHnUrl("https://news.ycombinator.com/item?id=1 wow")).toBe(false);
  });
  it("rejects non-HN URLs", () => {
    expect(isSoloHnUrl("https://example.com/item?id=1")).toBe(false);
    expect(isSoloHnUrl("hello world")).toBe(false);
  });
});

describe("parseWeightSlashArgs", () => {
  const tz = "Europe/Madrid";
  it("parses a bare value as today", () => {
    const out = parseWeightSlashArgs("78.2", tz);
    expect(typeof out).toBe("object");
    if (typeof out === "string") return;
    expect(out.weightKg).toBe(78.2);
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("parses a value with a YYYY-MM-DD date", () => {
    const out = parseWeightSlashArgs("78.5 2026-05-03", tz);
    if (typeof out === "string") throw new Error("unexpected error");
    expect(out.weightKg).toBe(78.5);
    expect(out.date).toBe("2026-05-03");
  });
  it("supports comma decimal", () => {
    const out = parseWeightSlashArgs("78,2", tz);
    if (typeof out === "string") throw new Error("unexpected error");
    expect(out.weightKg).toBe(78.2);
  });
  it("returns an error string for missing value", () => {
    expect(parseWeightSlashArgs("nope", tz)).toMatch(/Usage/);
  });
  it("returns an error for invalid date token", () => {
    const out = parseWeightSlashArgs("78.2 lasty mondayy", tz);
    expect(typeof out).toBe("string");
  });
  it("supports yesterday", () => {
    const out = parseWeightSlashArgs("78.2 yesterday", tz);
    if (typeof out === "string") throw new Error("unexpected error");
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("supports N days ago", () => {
    const out = parseWeightSlashArgs("78.2 3 days ago", tz);
    if (typeof out === "string") throw new Error("unexpected error");
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("rejects negative weights", () => {
    expect(parseWeightSlashArgs("-5", tz)).toMatch(/positive number/);
  });
});

describe("parseRenphoCsv", () => {
  it("parses a RENPHO-style CSV with M/D/YY dates", () => {
    const csv = [
      "Date,Time,Weight(kg),BMI",
      "5/3/26,07:42:00,78.2,24.1",
      "5/4/26,08:13:00,78.0,24.0",
    ].join("\n");
    const rows = parseRenphoCsv(csv);
    expect(rows).toEqual([
      { date: "2026-05-03", weight_kg: 78.2 },
      { date: "2026-05-04", weight_kg: 78.0 },
    ]);
  });

  it("returns empty for unrecognized header", () => {
    expect(parseRenphoCsv("foo,bar\n1,2")).toEqual([]);
  });

  it("dedups duplicate dates keeping the last", () => {
    const csv = [
      "Date,Weight(kg)",
      "5/3/26,78.0",
      "5/3/26,78.4",
    ].join("\n");
    const rows = parseRenphoCsv(csv);
    expect(rows).toEqual([{ date: "2026-05-03", weight_kg: 78.4 }]);
  });

  it("isWeightCsvDocument matches mime + extension", () => {
    expect(isWeightCsvDocument({ mimeType: "text/csv" })).toBe(true);
    expect(isWeightCsvDocument({ fileName: "weights.CSV" })).toBe(true);
    expect(isWeightCsvDocument({ mimeType: "image/png" })).toBe(false);
  });
});

describe("truncateToolResult", () => {
  it("returns short results unchanged", () => {
    expect(truncateToolResult("any", "short")).toBe("short");
  });
  it("truncates long generic results with ellipsis", () => {
    const long = "x".repeat(800);
    const out = truncateToolResult("any", long);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(503);
  });
  it("truncates search_entries results line-by-line", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}: ` + "x".repeat(60));
    const result = lines.join("\n");
    const out = truncateToolResult("search_entries", result);
    expect(out.split("\n").length).toBeLessThan(20);
  });
});

describe("flow-state", () => {
  it("set/get/clear/isFlowActive round-trip", () => {
    expect(getFlow("c1")).toBeUndefined();
    setFlow("c1", { flow: "checkpoint", step: "awaiting_pull", data: {}, startedAt: 0 });
    expect(getFlow("c1")?.flow).toBe("checkpoint");
    expect(isFlowActive("c1", "checkpoint")).toBe(true);
    expect(isFlowActive("c1", "chat")).toBe(false);
    const cleared = clearFlow("c1");
    expect(cleared?.flow).toBe("checkpoint");
    expect(getFlow("c1")).toBeUndefined();
  });
  it("clearAllFlows wipes everything", () => {
    setFlow("a", { flow: "practice", sessionId: "x", startedAt: 0 });
    setFlow("b", { flow: "vault-prompt", name: "hilo", conversation: [], startedAt: 0 });
    clearAllFlows();
    expect(getFlow("a")).toBeUndefined();
    expect(getFlow("b")).toBeUndefined();
  });
});
