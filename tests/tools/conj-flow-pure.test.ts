import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    timezone: "Europe/Madrid",
    anthropic: { apiKey: "sk-test" },
    telegram: { botToken: "x" },
    models: { anthropicFast: "claude-haiku-4-5-20251001" },
  },
}));
vi.mock("../../src/db/client.js", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

import {
  parseConjArgs,
  formatInterval,
  maskForm,
  renderCardFront,
  renderResult,
  renderSessionSummary,
} from "../../src/telegram/flows/conj.js";
import type { ConjFlowState } from "../../src/telegram/flow-state.js";

describe("parseConjArgs", () => {
  it("returns undefined for empty input", () => {
    expect(parseConjArgs("")).toEqual({ newCap: undefined });
    expect(parseConjArgs("  ")).toEqual({ newCap: undefined });
  });

  it("parses valid integers in range", () => {
    expect(parseConjArgs("30")).toEqual({ newCap: 30 });
    expect(parseConjArgs("1")).toEqual({ newCap: 1 });
    expect(parseConjArgs("100")).toEqual({ newCap: 100 });
  });

  it("rejects out-of-range integers", () => {
    expect("error" in parseConjArgs("0")).toBe(true);
    expect("error" in parseConjArgs("101")).toBe(true);
  });

  it("rejects non-integers and garbage", () => {
    expect("error" in parseConjArgs("foo")).toBe(true);
    expect("error" in parseConjArgs("5.5")).toBe(true);
    expect("error" in parseConjArgs("-3")).toBe(true);
  });
});

describe("formatInterval", () => {
  const NOW = new Date("2026-05-15T12:00:00Z");

  it("<1m for due in the past", () => {
    expect(formatInterval(new Date(NOW.getTime() - 1000), NOW)).toBe("<1m");
  });

  it("returns minute / hour / day labels", () => {
    expect(formatInterval(new Date(NOW.getTime() + 60_000), NOW)).toBe("1m");
    expect(formatInterval(new Date(NOW.getTime() + 60 * 60_000), NOW)).toBe("1h");
    expect(formatInterval(new Date(NOW.getTime() + 24 * 60 * 60_000), NOW)).toBe("1d");
  });

  it("month / year labels", () => {
    expect(
      formatInterval(new Date(NOW.getTime() + 60 * 24 * 60 * 60_000), NOW)
    ).toBe("2mo");
    expect(
      formatInterval(new Date(NOW.getTime() + 400 * 24 * 60 * 60_000), NOW)
    ).toBe("1y");
  });
});

describe("maskForm", () => {
  it("replaces a simple form with ___", () => {
    expect(maskForm("Cuando era joven, viajé.", "era")).toBe(
      "Cuando ___ joven, viajé."
    );
  });

  it("case-insensitive replace", () => {
    expect(maskForm("Era joven y feliz.", "era")).toBe("___ joven y feliz.");
  });

  it("multi-word compound form replace", () => {
    expect(maskForm("Yo he comido hoy.", "he comido")).toBe("Yo ___ hoy.");
  });

  it("imperative_negative strips leading no and renders 'no ___'", () => {
    expect(
      maskForm("No hables tan rápido.", "hables", "imperative_negative")
    ).toBe("no ___ tan rápido.");
  });
});

describe("renderCardFront", () => {
  it("includes pattern announce on first card only", () => {
    const front = renderCardFront(
      { lemma: "ser", tense: "imperfect", person: "yo", expected_form: "era" },
      "Cuando era joven, viajé.",
      "imperfect_irregular",
      0,
      12
    );
    expect(front.text).toContain("12 cartas");
    expect(front.text).toContain("___");
    expect(front.text).toContain("ser");
    expect(front.text).toContain("imperfecto");
  });

  it("omits pattern announce on subsequent cards", () => {
    const front = renderCardFront(
      { lemma: "ser", tense: "imperfect", person: "yo", expected_form: "era" },
      "Cuando era joven.",
      "imperfect_irregular",
      1,
      12
    );
    expect(front.text).not.toContain("cartas");
  });
});

describe("renderResult", () => {
  const NOW = new Date("2026-05-15T12:00:00Z");
  const DUE_4D = new Date(NOW.getTime() + 4 * 24 * 60 * 60_000);

  it("exact renders ✓", () => {
    expect(renderResult("exact", "era", "Cuando era joven.", DUE_4D, NOW)).toContain("✓");
  });

  it("easy renders ⏭", () => {
    expect(renderResult("easy", "era", "Cuando era joven.", DUE_4D, NOW)).toContain("⏭");
  });

  it("wrong renders ✗ with the filled sentence", () => {
    const out = renderResult("wrong", "tuve", "Cuando tuve niño.", DUE_4D, NOW);
    expect(out).toContain("✗");
    expect(out).toContain("Cuando tuve niño.");
  });

  it("hint_correct labels as hint→hard", () => {
    const out = renderResult("hint_correct", "tuve", "", DUE_4D, NOW);
    expect(out).toContain("hint → hard");
  });

  it("hint_easy labels as hint+easy → hard", () => {
    const out = renderResult("hint_easy", "tuve", "", DUE_4D, NOW);
    expect(out).toContain("hint+easy");
  });

  it("hint_wrong includes hint→again with filled sentence", () => {
    const out = renderResult("hint_wrong", "tuve", "Cuando tuve niño.", DUE_4D, NOW);
    expect(out).toContain("hint");
    expect(out).toContain("again");
  });
});

describe("renderSessionSummary", () => {
  it("groups grade kinds (exact+hint_correct → ✓ etc)", () => {
    const state: ConjFlowState = {
      flow: "conj",
      sessionId: "s",
      startedAt: 0,
      pattern: "preterite_strong",
      queue: [],
      queueIndex: 12,
      reviewedCount: 12,
      countsByGradeKind: {
        exact: 7,
        wrong: 2,
        easy: 1,
        hint_correct: 1,
        hint_wrong: 1,
        hint_easy: 0,
      },
      hintCount: 2,
      currentCardId: null,
      currentExpected: null,
      currentTense: null,
      currentPattern: null,
      currentPerson: null,
      currentLemma: null,
      currentSentence: null,
      currentClozeSource: null,
      hintUsed: false,
    };
    const summary = renderSessionSummary(
      "Listo",
      "preterite_strong",
      state,
      { due: 10, stalling: 3, unpromoted: 100 }
    );
    expect(summary).toContain("Listo");
    expect(summary).toContain("8 ✓"); // 7 exact + 1 hint_correct
    expect(summary).toContain("1 ⏭"); // 1 easy + 0 hint_easy
    expect(summary).toContain("3 ✗"); // 2 wrong + 1 hint_wrong
    expect(summary).toContain("2 con pista");
    expect(summary).toContain("10 pendientes");
    expect(summary).toContain("3 atascadas");
    expect(summary).toContain("100 celdas sin promover");
  });
});
