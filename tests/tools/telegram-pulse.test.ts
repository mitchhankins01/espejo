import { describe, it, expect } from "vitest";
import {
  diagnoseQuality,
  applySoulRepairs,
  buildSoulCompactionContext,
  type PulseDiagnosis,
  type SoulRepairAction,
} from "../../src/telegram/pulse.js";
import type { SoulQualityStats } from "../../src/db/queries.js";
import type { SoulStateSnapshot } from "../../src/telegram/soul.js";

// ---------------------------------------------------------------------------
// diagnoseQuality
// ---------------------------------------------------------------------------

describe("diagnoseQuality", () => {
  it("returns stale when total signals < 5", () => {
    const stats: SoulQualityStats = {
      felt_personal: 1,
      felt_generic: 0,
      correction: 1,
      positive_reaction: 0,
      total: 2,
      personal_ratio: 1.0,
    };

    const diagnosis = diagnoseQuality(stats);

    expect(diagnosis.status).toBe("stale");
    expect(diagnosis.repairs).toHaveLength(0);
    expect(diagnosis.recommendation).toContain("Not enough feedback signals");
  });

  it("returns healthy when personal_ratio >= 60%", () => {
    const stats: SoulQualityStats = {
      felt_personal: 5,
      felt_generic: 1,
      correction: 1,
      positive_reaction: 3,
      total: 10,
      personal_ratio: 0.73, // (5+3)/(5+1+3) ≈ 0.73
    };

    const diagnosis = diagnoseQuality(stats);

    expect(diagnosis.status).toBe("healthy");
    expect(diagnosis.repairs).toHaveLength(0);
    expect(diagnosis.recommendation).toContain("look good");
  });

  it("returns healthy with monitoring note when ratio is 40-60%", () => {
    const stats: SoulQualityStats = {
      felt_personal: 2,
      felt_generic: 2,
      correction: 1,
      positive_reaction: 1,
      total: 6,
      personal_ratio: 0.5, // (2+1)/(2+2+1) = 0.5
    };

    const diagnosis = diagnoseQuality(stats);

    expect(diagnosis.status).toBe("healthy");
    expect(diagnosis.recommendation).toContain("could improve");
  });

  it("returns drifting when personal_ratio < 40%", () => {
    const stats: SoulQualityStats = {
      felt_personal: 1,
      felt_generic: 5,
      correction: 1,
      positive_reaction: 0,
      total: 7,
      personal_ratio: 0.14, // (1+0)/(1+5+0) ≈ 0.14
    };

    const diagnosis = diagnoseQuality(stats);

    expect(diagnosis.status).toBe("drifting");
    expect(diagnosis.repairs.length).toBeGreaterThan(0);
    expect(diagnosis.repairs.some((r) => r.type === "add_growth_note")).toBe(true);
    expect(diagnosis.recommendation).toContain("generic");
  });

  it("returns overcorrecting when correction_rate > 50%", () => {
    const stats: SoulQualityStats = {
      felt_personal: 1,
      felt_generic: 1,
      correction: 8,
      positive_reaction: 0,
      total: 10,
      personal_ratio: 0.5,
    };

    const diagnosis = diagnoseQuality(stats);

    expect(diagnosis.status).toBe("overcorrecting");
    expect(diagnosis.repairs.length).toBeGreaterThan(0);
    const growthNote = diagnosis.repairs.find(
      (r) => r.type === "add_growth_note"
    );
    expect(growthNote).toBeDefined();
    expect(growthNote?.value).toContain("stabilizing");
  });

  it("overcorrecting takes priority over drifting", () => {
    const stats: SoulQualityStats = {
      felt_personal: 0,
      felt_generic: 3,
      correction: 6,
      positive_reaction: 0,
      total: 9,
      personal_ratio: 0.0,
    };

    const diagnosis = diagnoseQuality(stats);

    // correction_rate = 6/9 ≈ 0.67 > 0.5, so overcorrecting
    expect(diagnosis.status).toBe("overcorrecting");
  });

  it("drifting repairs are capped at max 2", () => {
    const stats: SoulQualityStats = {
      felt_personal: 0,
      felt_generic: 10,
      correction: 1,
      positive_reaction: 0,
      total: 11,
      personal_ratio: 0.0,
    };

    const diagnosis = diagnoseQuality(stats);

    expect(diagnosis.repairs.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// applySoulRepairs
// ---------------------------------------------------------------------------

describe("applySoulRepairs", () => {
  const baseSoul: SoulStateSnapshot = {
    identitySummary:
      "A steady companion that is warm, direct, and emotionally present.",
    relationalCommitments: [
      "stay direct and emotionally present",
      "be honest about uncertainty",
    ],
    toneSignature: ["warm", "direct", "grounded"],
    growthNotes: ["initialized soul state from early conversation"],
    version: 3,
  };

  it("returns null when no repairs provided", () => {
    const result = applySoulRepairs(baseSoul, []);
    expect(result).toBeNull();
  });

  it("adds a new commitment when under capacity and not duplicated", () => {
    const repairs: SoulRepairAction[] = [
      { type: "add_commitment", value: "anchor responses in concrete examples" },
    ];

    const result = applySoulRepairs(baseSoul, repairs);

    expect(result).not.toBeNull();
    expect(result?.version).toBe(4);
    expect(result?.relationalCommitments).toContain(
      "anchor responses in concrete examples"
    );
  });

  it("adds a growth note from pulse diagnosis", () => {
    const repairs: SoulRepairAction[] = [
      {
        type: "add_growth_note",
        value: "pulse: personal ratio dropped to 30% — focusing on specifics",
      },
    ];

    const result = applySoulRepairs(baseSoul, repairs);

    expect(result).not.toBeNull();
    expect(result?.version).toBe(4);
    expect(result?.growthNotes).toContain(
      "pulse: personal ratio dropped to 30% — focusing on specifics"
    );
  });

  it("adds specificity commitment when drifting note is present", () => {
    const repairs: SoulRepairAction[] = [
      {
        type: "add_growth_note",
        value: "pulse: personal ratio dropped to 25% — focusing on specifics",
      },
    ];

    const result = applySoulRepairs(baseSoul, repairs);

    expect(result).not.toBeNull();
    expect(result?.relationalCommitments).toContain(
      "favor specifics over generic phrasing"
    );
  });

  it("does not duplicate existing commitment", () => {
    const soulWithSpecificity: SoulStateSnapshot = {
      ...baseSoul,
      relationalCommitments: [
        ...baseSoul.relationalCommitments,
        "favor specifics over generic phrasing",
      ],
    };

    const repairs: SoulRepairAction[] = [
      { type: "add_commitment", value: "favor specifics over generic phrasing" },
    ];

    const result = applySoulRepairs(soulWithSpecificity, repairs);
    expect(result).toBeNull(); // nothing changed
  });

  it("does not add commitment when at max capacity (6)", () => {
    const fullSoul: SoulStateSnapshot = {
      ...baseSoul,
      relationalCommitments: ["c1", "c2", "c3", "c4", "c5", "c6"],
    };

    const repairs: SoulRepairAction[] = [
      { type: "add_commitment", value: "new commitment" },
    ];

    const result = applySoulRepairs(fullSoul, repairs);
    expect(result).toBeNull();
  });

  it("does not duplicate growth notes", () => {
    const soulWithNote: SoulStateSnapshot = {
      ...baseSoul,
      growthNotes: ["pulse: personal ratio dropped to 30% — focusing on specifics"],
    };

    const repairs: SoulRepairAction[] = [
      {
        type: "add_growth_note",
        value: "pulse: personal ratio dropped to 30% — focusing on specifics",
      },
    ];

    const result = applySoulRepairs(soulWithNote, repairs);
    expect(result).toBeNull();
  });

  it("trims growth notes to max 8", () => {
    const soulWithManyNotes: SoulStateSnapshot = {
      ...baseSoul,
      growthNotes: ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"],
    };

    const repairs: SoulRepairAction[] = [
      { type: "add_growth_note", value: "pulse: new note" },
    ];

    const result = applySoulRepairs(soulWithManyNotes, repairs);

    expect(result).not.toBeNull();
    expect(result?.growthNotes.length).toBeLessThanOrEqual(8);
    expect(result?.growthNotes).toContain("pulse: new note");
    // Oldest note was dropped
    expect(result?.growthNotes).not.toContain("n1");
  });

  it("adds tone when add_tone repair is given", () => {
    const repairs: SoulRepairAction[] = [
      { type: "add_tone", value: "precise" },
    ];

    const result = applySoulRepairs(baseSoul, repairs);

    expect(result).not.toBeNull();
    expect(result?.toneSignature).toContain("precise");
  });

  it("does not duplicate existing tone", () => {
    const repairs: SoulRepairAction[] = [
      { type: "add_tone", value: "warm" },
    ];

    const result = applySoulRepairs(baseSoul, repairs);
    expect(result).toBeNull();
  });

  it("preserves identity summary through repairs", () => {
    const repairs: SoulRepairAction[] = [
      { type: "add_growth_note", value: "pulse: stabilizing" },
    ];

    const result = applySoulRepairs(baseSoul, repairs);

    expect(result?.identitySummary).toBe(baseSoul.identitySummary);
  });
});

// ---------------------------------------------------------------------------
// buildSoulCompactionContext
// ---------------------------------------------------------------------------

describe("buildSoulCompactionContext", () => {
  it("returns empty string when soul state is null", () => {
    expect(buildSoulCompactionContext(null)).toBe("");
  });

  it("returns empty string when commitments are empty", () => {
    const soul: SoulStateSnapshot = {
      identitySummary: "test",
      relationalCommitments: [],
      toneSignature: ["warm"],
      growthNotes: [],
      version: 1,
    };

    expect(buildSoulCompactionContext(soul)).toBe("");
  });

  it("returns empty string when commitments are blank", () => {
    const soul: SoulStateSnapshot = {
      identitySummary: "test",
      relationalCommitments: ["   ", ""],
      toneSignature: ["warm"],
      growthNotes: [],
      version: 1,
    };

    expect(buildSoulCompactionContext(soul)).toBe("");
  });

  it("includes commitments and guidance when present", () => {
    const soul: SoulStateSnapshot = {
      identitySummary: "A steady companion.",
      relationalCommitments: [
        "stay direct and avoid sugarcoating",
        "favor specifics over generic phrasing",
      ],
      toneSignature: ["warm", "direct"],
      growthNotes: [],
      version: 3,
    };

    const context = buildSoulCompactionContext(soul);

    expect(context).toContain("relational commitments");
    expect(context).toContain("stay direct and avoid sugarcoating");
    expect(context).toContain("favor specifics over generic phrasing");
    expect(context).toContain("Prioritize explicit facts");
  });
});
