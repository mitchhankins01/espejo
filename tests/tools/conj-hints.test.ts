import { describe, it, expect } from "vitest";
import { buildHint } from "../../src/telegram/conj-hints.js";

function noLeak(hint: string, expected: string): boolean {
  const normHint = hint.toLowerCase().replace(/\s+/g, " ");
  const normExpected = expected.toLowerCase().replace(/\s+/g, " ");
  const re = new RegExp(
    `(^|[^a-záéíóúüñ])${normExpected.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}([^a-záéíóúüñ]|$)`
  );
  return !re.test(normHint);
}

describe("buildHint", () => {
  it("present_yo_go (tener · 1ps) reveals the yo stem 'teng-' but not 'tengo'", () => {
    const hint = buildHint({
      pattern: "present_yo_go",
      tense: "present_indicative",
      person: "yo",
      expected_form: "tengo",
    });
    expect(hint).toContain("teng-");
    expect(noLeak(hint, "tengo")).toBe(true);
  });

  it("preterite_strong (decir · 3pp) reveals 'dij-' stem, not 'dijeron'", () => {
    const hint = buildHint({
      pattern: "preterite_strong",
      tense: "preterite",
      person: "ellos",
      expected_form: "dijeron",
    });
    expect(hint).toContain("dij-");
    expect(noLeak(hint, "dijeron")).toBe(true);
  });

  it("present_perfect reveals aux paradigm without full form", () => {
    const hint = buildHint({
      pattern: "present_perfect",
      tense: "present_perfect",
      person: "yo",
      expected_form: "he comido",
    });
    expect(hint).toContain("he/has/ha");
    expect(noLeak(hint, "he comido")).toBe(true);
  });

  it("imperative_affirmative_tu_irreg (tener · tu) does not reveal 'ten'", () => {
    const hint = buildHint({
      pattern: "imperative_affirmative_tu_irreg",
      tense: "imperative_affirmative",
      person: "tu",
      expected_form: "ten",
    });
    // 'ten' as a substring sneaks into "tener"; whole-word checker handles it.
    expect(noLeak(hint, "ten")).toBe(true);
  });

  it("imperfect_irregular (ser · yo · era) does not reveal 'era'", () => {
    const hint = buildHint({
      pattern: "imperfect_irregular",
      tense: "imperfect",
      person: "yo",
      expected_form: "era",
    });
    expect(noLeak(hint, "era")).toBe(true);
  });

  it("imperative_negative returns the subjuntivo rule", () => {
    const hint = buildHint({
      pattern: "imperative_negative",
      tense: "imperative_negative",
      person: "tu",
      expected_form: "hables",
    });
    expect(hint).toContain("subjuntivo");
    expect(noLeak(hint, "hables")).toBe(true);
  });

  it("unknown pattern returns 'sin pista disponible' without throwing", () => {
    const hint = buildHint({
      pattern: "no_such_pattern",
      tense: "preterite",
      person: "yo",
      expected_form: "tuve",
    });
    expect(hint).toBe("sin pista disponible");
  });

  it("returns a non-empty hint for every defined pattern", () => {
    const patterns = [
      "present_regular_ar",
      "present_regular_er",
      "present_regular_ir",
      "present_stem_eie",
      "present_stem_oue",
      "present_stem_ei",
      "present_yo_go",
      "present_yo_zco",
      "present_irregular",
      "preterite_regular_ar",
      "preterite_regular_er_ir",
      "preterite_strong",
      "preterite_stem_iu",
      "imperfect_regular",
      "imperfect_irregular",
      "future_regular",
      "future_irregular_stem",
      "conditional_regular",
      "conditional_irregular_stem",
      "present_perfect",
      "pluperfect",
      "future_perfect",
      "conditional_perfect",
      "present_subj_regular",
      "present_subj_yo_irreg_derived",
      "present_subj_irregular",
      "imperfect_subj_regular",
      "imperfect_subj_strong_stem",
      "present_perfect_subj",
      "pluperfect_subj",
      "imperative_affirmative_regular",
      "imperative_affirmative_tu_irreg",
      "imperative_negative",
    ];
    for (const p of patterns) {
      const hint = buildHint({
        pattern: p,
        tense: "preterite",
        person: "yo",
        expected_form: "tuve",
      });
      expect(hint.length).toBeGreaterThan(0);
      expect(hint).not.toBe("");
    }
  });

  it("preterite_regular_ar gives the -ar ending pattern", () => {
    const hint = buildHint({
      pattern: "preterite_regular_ar",
      tense: "preterite",
      person: "tu",
      expected_form: "hablaste",
    });
    expect(hint.toLowerCase()).toContain("-ar");
    expect(noLeak(hint, "hablaste")).toBe(true);
  });

  it("future_regular hint references the ending pattern", () => {
    const hint = buildHint({
      pattern: "future_regular",
      tense: "future_indicative",
      person: "ellos",
      expected_form: "hablarán",
    });
    expect(hint).toContain("infinitivo");
    expect(noLeak(hint, "hablarán")).toBe(true);
  });
});
