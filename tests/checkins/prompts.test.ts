import { describe, it, expect } from "vitest";
import {
  buildCheckinPrompt,
  buildOuraAnomalyPrompt,
  buildJournalPatternPrompt,
} from "../../src/checkins/prompts.js";

describe("buildCheckinPrompt", () => {
  it("morning without context", () => {
    const result = buildCheckinPrompt("morning", null, null);
    expect(result).toContain("Buenos días");
    expect(result).toContain("mañana");
  });

  it("morning with oura context", () => {
    const result = buildCheckinPrompt("morning", "Sleep 6h, readiness 72", null);
    expect(result).toContain("Buenos días");
    expect(result).toContain("Sleep 6h");
  });

  it("afternoon without context", () => {
    const result = buildCheckinPrompt("afternoon", null, null);
    expect(result).toContain("trabajando");
  });

  it("afternoon with todo context", () => {
    const result = buildCheckinPrompt("afternoon", null, "Focus: fix migrations");
    expect(result).toContain("trabajando");
    expect(result).toContain("fix migrations");
  });

  it("evening", () => {
    const result = buildCheckinPrompt("evening", null, null);
    expect(result).toContain("cerrando");
  });

  it("event-driven fallback", () => {
    const result = buildCheckinPrompt("event", null, null);
    expect(result).toContain("checkearte");
  });
});

describe("buildOuraAnomalyPrompt", () => {
  it("formats anomalies", () => {
    const result = buildOuraAnomalyPrompt(["low sleep", "low HRV"]);
    expect(result).toContain("low sleep, low HRV");
    expect(result).toContain("Oura");
  });
});

describe("buildJournalPatternPrompt", () => {
  it("returns the pattern as-is", () => {
    expect(buildJournalPatternPrompt("recurring theme")).toBe("recurring theme");
  });
});
