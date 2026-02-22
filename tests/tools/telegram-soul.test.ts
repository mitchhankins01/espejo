import { describe, it, expect } from "vitest";
import {
  buildSoulPromptSection,
  evolveSoulState,
} from "../../src/telegram/soul.js";

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

describe("evolveSoulState", () => {
  it("bootstraps state when no previous soul exists", () => {
    const next = evolveSoulState(null, "hello there");

    expect(next).not.toBeNull();
    expect(next?.version).toBe(1);
    expect(next?.identitySummary).toContain("A steady companion");
    expect(next?.relationalCommitments.length).toBeGreaterThan(0);
    expect(next?.toneSignature.length).toBeGreaterThan(0);
    expect(next?.growthNotes[0]).toContain("initialized soul state");
  });

  it("returns null when existing state has no new signal", () => {
    const next = evolveSoulState(
      {
        identitySummary: "A steady companion that is warm, direct, and emotionally present.",
        relationalCommitments: ["stay direct and emotionally present"],
        toneSignature: ["warm", "direct", "grounded"],
        growthNotes: ["initialized soul state from early conversation"],
        version: 2,
      },
      "what did I eat yesterday?"
    );

    expect(next).toBeNull();
  });

  it("merges user preference signals into the existing state", () => {
    const next = evolveSoulState(
      {
        identitySummary: "A steady companion that is warm, direct, and emotionally present.",
        relationalCommitments: ["stay direct and emotionally present"],
        toneSignature: ["warm", "direct", "grounded"],
        growthNotes: ["initialized soul state from early conversation"],
        version: 2,
      },
      "be more direct and concise, and challenge me with specifics"
    );

    expect(next).not.toBeNull();
    expect(next?.version).toBe(3);
    expect(next?.relationalCommitments).toContain(
      "stay direct and avoid sugarcoating"
    );
    expect(next?.relationalCommitments).toContain(
      "keep replies concise and practical"
    );
    expect(next?.relationalCommitments).toContain(
      "favor specifics over generic phrasing"
    );
    expect(next?.growthNotes.join(" | ")).toContain("directness");
    expect(next?.growthNotes.join(" | ")).toContain("shorter responses");
  });

  it("captures the full signal set from user feedback", () => {
    const next = evolveSoulState(
      {
        identitySummary: "",
        relationalCommitments: [],
        toneSignature: [],
        growthNotes: [],
        version: 1,
      },
      "be more direct and concise with specifics, challenge me, ask one question, stay warm and calm, and feel more human"
    );

    expect(next).not.toBeNull();
    expect(next?.relationalCommitments).toContain(
      "stay direct and avoid sugarcoating"
    );
    expect(next?.relationalCommitments).toContain(
      "keep replies concise and practical"
    );
    expect(next?.relationalCommitments).toContain(
      "favor specifics over generic phrasing"
    );
    expect(next?.relationalCommitments).toContain(
      "offer gentle challenge when useful"
    );
    expect(next?.relationalCommitments).toContain(
      "ask one useful follow-up when helpful"
    );
    expect(next?.toneSignature).toContain("warm");
    expect(next?.toneSignature).toContain("grounded");
    expect(next?.toneSignature).toContain("human");
    expect(next?.growthNotes.join(" | ")).toContain("stronger follow-up");
    expect(next?.growthNotes.join(" | ")).toContain("warmer tone");
    expect(next?.growthNotes.join(" | ")).toContain("more human voice");
  });

  it("returns null when inferred update matches current state exactly", () => {
    const next = evolveSoulState(
      {
        identitySummary:
          "A steady companion that is warm, direct, and emotionally present. Keeps replies concise and practical. Stays grounded and calm when things feel heavy.",
        relationalCommitments: [
          "stay direct and emotionally present",
          "be honest about uncertainty",
          "build on what matters to the user over time",
          "keep replies concise and practical",
        ],
        toneSignature: ["warm", "direct", "grounded", "concise"],
        growthNotes: ["user asked for shorter responses"],
        version: 7,
      },
      "please be concise"
    );

    expect(next).toBeNull();
  });

  it("handles empty values and max-item truncation in merge logic", () => {
    const next = evolveSoulState(
      {
        identitySummary:
          "A steady companion that is warm, direct, and emotionally present.",
        relationalCommitments: [
          "c1",
          "c2",
          "c3",
          "c4",
          "c5",
          "c6",
          "   ",
          "c7",
        ],
        toneSignature: ["t1", "t2", "t3", "t4", "t5", "t6", "   ", "t7"],
        growthNotes: [],
        version: 3,
      },
      "be more direct"
    );

    expect(next).not.toBeNull();
    expect(next?.relationalCommitments.length).toBeLessThanOrEqual(6);
    expect(next?.toneSignature.length).toBeLessThanOrEqual(6);
    expect(next?.relationalCommitments.join(" ")).not.toContain("   ");
    expect(next?.toneSignature.join(" ")).not.toContain("   ");
  });

  it("ignores blank pre-existing entries before merging new signals", () => {
    const next = evolveSoulState(
      {
        identitySummary:
          "A steady companion that is warm, direct, and emotionally present.",
        relationalCommitments: ["   "],
        toneSignature: ["   "],
        growthNotes: ["   "],
        version: 2,
      },
      "be direct"
    );

    expect(next).not.toBeNull();
    expect(next?.relationalCommitments).not.toContain("   ");
    expect(next?.toneSignature).not.toContain("   ");
  });

  it("evolves when identity matches but commitment lengths differ", () => {
    const next = evolveSoulState(
      {
        identitySummary:
          "A steady companion that is warm, direct, and emotionally present. Stays grounded and calm when things feel heavy.",
        relationalCommitments: [],
        toneSignature: ["grounded"],
        growthNotes: [],
        version: 2,
      },
      "be more direct"
    );

    expect(next).not.toBeNull();
  });

  it("evolves when identity matches but commitment values differ", () => {
    const next = evolveSoulState(
      {
        identitySummary:
          "A steady companion that is warm, direct, and emotionally present.",
        relationalCommitments: ["stay direct and avoid sugarcoating  "],
        toneSignature: ["direct"],
        growthNotes: ["user asked for more directness"],
        version: 2,
      },
      "be more direct"
    );

    expect(next).not.toBeNull();
  });
});
