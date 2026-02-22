import { describe, it, expect } from "vitest";
import { buildSoulPromptSection } from "../../src/telegram/soul.js";

describe("buildSoulPromptSection", () => {
  it("includes charter and bootstrap guidance when state is missing", () => {
    const prompt = buildSoulPromptSection(null);

    expect(prompt).toContain("Steady Companion charter:");
    expect(prompt).toContain("Soul state: no prior state yet.");
  });

  it("renders normalized soul-state sections and limits list sizes", () => {
    const prompt = buildSoulPromptSection({
      identitySummary: "  Learns your cadence and follows through.  ",
      relationalCommitments: [
        " stay direct ",
        "ask one useful follow-up",
        "",
        "mirror your language lightly",
        "keep it practical",
        "this should be trimmed by max items",
      ],
      toneSignature: ["calm", "clear", "low-ego", "grounded", "too many"],
      growthNotes: ["noticed you prefer specifics", " "],
      version: 3,
    });

    expect(prompt).toContain(
      "Soul identity summary: Learns your cadence and follows through."
    );
    expect(prompt).toContain("Relational commitments:");
    expect(prompt).toContain("- stay direct");
    expect(prompt).toContain("- ask one useful follow-up");
    expect(prompt).toContain("- keep it practical");
    expect(prompt).not.toContain("this should be trimmed by max items");
    expect(prompt).toContain("Tone signature:");
    expect(prompt).toContain("- low-ego");
    expect(prompt).not.toContain("- too many");
    expect(prompt).toContain("Recent growth notes:");
    expect(prompt).toContain("- noticed you prefer specifics");
    expect(prompt).toContain("Soul state version: v3");
  });

  it("omits empty sections and clamps version to at least 1", () => {
    const prompt = buildSoulPromptSection({
      identitySummary: "   ",
      relationalCommitments: [],
      toneSignature: [],
      growthNotes: [],
      version: 0,
    });

    expect(prompt).not.toContain("Soul identity summary:");
    expect(prompt).not.toContain("Relational commitments:");
    expect(prompt).not.toContain("Tone signature:");
    expect(prompt).not.toContain("Recent growth notes:");
    expect(prompt).toContain("Soul state version: v1");
  });
});
