import { describe, it, expect } from "vitest";
import {
  classifyPattern,
  type Tense,
  type Person,
} from "../../scripts/lib/pattern-classifier.js";

function classify(
  lemma: string,
  tense: Tense,
  person: Person,
  form = "x"
): string {
  return classifyPattern({ lemma, tense, person, form });
}

describe("classifyPattern", () => {
  it("tener · present · yo → present_yo_go", () => {
    expect(classify("tener", "present_indicative", "yo")).toBe(
      "present_yo_go"
    );
  });

  it("tener · present · tu → present_stem_eie", () => {
    expect(classify("tener", "present_indicative", "tu")).toBe(
      "present_stem_eie"
    );
  });

  it("tener · present · nosotros → present_regular_er", () => {
    expect(classify("tener", "present_indicative", "nosotros")).toBe(
      "present_regular_er"
    );
  });

  it("tener · preterite · yo → preterite_strong", () => {
    expect(classify("tener", "preterite", "yo")).toBe("preterite_strong");
  });

  it("tener · preterite · ellos → preterite_strong (strong wins over stem)", () => {
    expect(classify("tener", "preterite", "ellos")).toBe("preterite_strong");
  });

  it("pedir · preterite · yo → preterite_regular_er_ir", () => {
    expect(classify("pedir", "preterite", "yo")).toBe(
      "preterite_regular_er_ir"
    );
  });

  it("pedir · preterite · el → preterite_stem_iu", () => {
    expect(classify("pedir", "preterite", "el")).toBe("preterite_stem_iu");
  });

  it("pedir · preterite · ellos → preterite_stem_iu", () => {
    expect(classify("pedir", "preterite", "ellos")).toBe("preterite_stem_iu");
  });

  it("pensar · present · tu → present_stem_eie", () => {
    expect(classify("pensar", "present_indicative", "tu")).toBe(
      "present_stem_eie"
    );
  });

  it("pensar · present · nosotros → present_regular_ar", () => {
    expect(classify("pensar", "present_indicative", "nosotros")).toBe(
      "present_regular_ar"
    );
  });

  it("poder · present · el → present_stem_oue", () => {
    expect(classify("poder", "present_indicative", "el")).toBe(
      "present_stem_oue"
    );
  });

  it("servir · present · ellos → present_stem_ei", () => {
    expect(classify("servir", "present_indicative", "ellos")).toBe(
      "present_stem_ei"
    );
  });

  it("conocer · present · yo → present_yo_zco", () => {
    expect(classify("conocer", "present_indicative", "yo")).toBe(
      "present_yo_zco"
    );
  });

  it("salir · present · yo → present_yo_go", () => {
    expect(classify("salir", "present_indicative", "yo")).toBe(
      "present_yo_go"
    );
  });

  it("comer · imperfect · yo → imperfect_regular", () => {
    expect(classify("comer", "imperfect", "yo")).toBe("imperfect_regular");
  });

  it("ser · imperfect · yo → imperfect_irregular", () => {
    expect(classify("ser", "imperfect", "yo")).toBe("imperfect_irregular");
  });

  it("ir · imperfect · ellos → imperfect_irregular", () => {
    expect(classify("ir", "imperfect", "ellos")).toBe("imperfect_irregular");
  });

  it("ver · imperfect · tu → imperfect_irregular", () => {
    expect(classify("ver", "imperfect", "tu")).toBe("imperfect_irregular");
  });

  it("tener · future_indicative · yo → future_irregular_stem", () => {
    expect(classify("tener", "future_indicative", "yo")).toBe(
      "future_irregular_stem"
    );
  });

  it("hablar · future_indicative · yo → future_regular", () => {
    expect(classify("hablar", "future_indicative", "yo")).toBe(
      "future_regular"
    );
  });

  it("saber · conditional · ellos → conditional_irregular_stem", () => {
    expect(classify("saber", "conditional", "ellos")).toBe(
      "conditional_irregular_stem"
    );
  });

  it("hablar · conditional · yo → conditional_regular", () => {
    expect(classify("hablar", "conditional", "yo")).toBe(
      "conditional_regular"
    );
  });

  it("hablar · present_perfect → present_perfect (lumping, regardless of participle)", () => {
    expect(classify("hablar", "present_perfect", "yo")).toBe("present_perfect");
  });

  it("decir · present_perfect → present_perfect (irregular participle still in one bucket)", () => {
    expect(classify("decir", "present_perfect", "yo")).toBe("present_perfect");
  });

  it("hablar · pluperfect → pluperfect", () => {
    expect(classify("hablar", "pluperfect", "el")).toBe("pluperfect");
  });

  it("hablar · future_perfect → future_perfect", () => {
    expect(classify("hablar", "future_perfect", "el")).toBe("future_perfect");
  });

  it("hablar · conditional_perfect → conditional_perfect", () => {
    expect(classify("hablar", "conditional_perfect", "el")).toBe(
      "conditional_perfect"
    );
  });

  it("ser · present_subjunctive → present_subj_irregular", () => {
    expect(classify("ser", "present_subjunctive", "yo")).toBe(
      "present_subj_irregular"
    );
  });

  it("tener · present_subjunctive → present_subj_yo_irreg_derived", () => {
    expect(classify("tener", "present_subjunctive", "yo")).toBe(
      "present_subj_yo_irreg_derived"
    );
  });

  it("conocer · present_subjunctive → present_subj_yo_irreg_derived", () => {
    expect(classify("conocer", "present_subjunctive", "yo")).toBe(
      "present_subj_yo_irreg_derived"
    );
  });

  it("hablar · present_subjunctive → present_subj_regular", () => {
    expect(classify("hablar", "present_subjunctive", "yo")).toBe(
      "present_subj_regular"
    );
  });

  it("hablar · imperfect_subjunctive → imperfect_subj_regular", () => {
    expect(classify("hablar", "imperfect_subjunctive", "yo")).toBe(
      "imperfect_subj_regular"
    );
  });

  it("tener · imperfect_subjunctive → imperfect_subj_strong_stem", () => {
    expect(classify("tener", "imperfect_subjunctive", "yo")).toBe(
      "imperfect_subj_strong_stem"
    );
  });

  it("hablar · present_perfect_subjunctive → present_perfect_subj", () => {
    expect(classify("hablar", "present_perfect_subjunctive", "yo")).toBe(
      "present_perfect_subj"
    );
  });

  it("hablar · pluperfect_subjunctive → pluperfect_subj", () => {
    expect(classify("hablar", "pluperfect_subjunctive", "el")).toBe(
      "pluperfect_subj"
    );
  });

  it("tener · imperative_affirmative · tu → imperative_affirmative_tu_irreg (form: ten)", () => {
    expect(
      classifyPattern({
        lemma: "tener",
        tense: "imperative_affirmative",
        person: "tu",
        form: "ten",
      })
    ).toBe("imperative_affirmative_tu_irreg");
  });

  it("hablar · imperative_affirmative · tu → imperative_affirmative_regular", () => {
    expect(classify("hablar", "imperative_affirmative", "tu")).toBe(
      "imperative_affirmative_regular"
    );
  });

  it("hablar · imperative_affirmative · vosotros → imperative_affirmative_regular", () => {
    expect(classify("hablar", "imperative_affirmative", "vosotros")).toBe(
      "imperative_affirmative_regular"
    );
  });

  it("hablar · imperative_negative · tu → imperative_negative (form: hables)", () => {
    expect(
      classifyPattern({
        lemma: "hablar",
        tense: "imperative_negative",
        person: "tu",
        form: "hables",
      })
    ).toBe("imperative_negative");
  });

  it("tener · imperative_negative · tu → imperative_negative (form: tengas)", () => {
    expect(
      classifyPattern({
        lemma: "tener",
        tense: "imperative_negative",
        person: "tu",
        form: "tengas",
      })
    ).toBe("imperative_negative");
  });

  it("regular -ir fallback for unknown lemma", () => {
    expect(classify("zucudir", "present_indicative", "tu")).toBe(
      "present_regular_ir"
    );
  });
});
