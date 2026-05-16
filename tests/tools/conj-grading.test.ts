import { describe, it, expect } from "vitest";
import { gradeAnswer, raToSe } from "../../src/fsrs/conj-grading.js";

describe("gradeAnswer", () => {
  it("exact match → grade 3", () => {
    expect(gradeAnswer("tuve", "tuve")).toEqual({ kind: "exact", grade: 3 });
  });

  it("case-insensitive", () => {
    expect(gradeAnswer("TUVE", "tuve")).toEqual({ kind: "exact", grade: 3 });
    expect(gradeAnswer("Tuve", "tuve")).toEqual({ kind: "exact", grade: 3 });
  });

  it("accent miss is wrong (not 'hard')", () => {
    expect(gradeAnswer("tuvé", "tuve")).toEqual({ kind: "wrong", grade: 1 });
    expect(gradeAnswer("tuve", "tuvé")).toEqual({ kind: "wrong", grade: 1 });
  });

  it("typo / wrong form → wrong", () => {
    expect(gradeAnswer("tuvi", "tuve")).toEqual({ kind: "wrong", grade: 1 });
    expect(gradeAnswer("xyz", "tuve")).toEqual({ kind: "wrong", grade: 1 });
  });

  it("/easy → grade 4", () => {
    expect(gradeAnswer("/easy", "tuve")).toEqual({ kind: "easy", grade: 4 });
  });

  it("empty string → wrong", () => {
    expect(gradeAnswer("", "tuve")).toEqual({ kind: "wrong", grade: 1 });
  });

  it("leading/trailing whitespace tolerated", () => {
    expect(gradeAnswer("  tuve  ", "tuve")).toEqual({ kind: "exact", grade: 3 });
  });

  it("compound: 'he comido' matches itself", () => {
    expect(gradeAnswer("he comido", "he comido")).toEqual({
      kind: "exact",
      grade: 3,
    });
  });

  it("compound: double space + mixed case → exact", () => {
    expect(gradeAnswer("He  Comido", "he comido")).toEqual({
      kind: "exact",
      grade: 3,
    });
  });

  it("compound wrong infinitive → wrong", () => {
    expect(gradeAnswer("he comer", "he comido")).toEqual({
      kind: "wrong",
      grade: 1,
    });
  });

  it("-ra / -se equivalence (imperfect_subjunctive)", () => {
    expect(
      gradeAnswer("hablara", "hablara", "imperfect_subjunctive")
    ).toEqual({ kind: "exact", grade: 3 });
    expect(
      gradeAnswer("hablase", "hablara", "imperfect_subjunctive")
    ).toEqual({ kind: "exact", grade: 3 });
    expect(
      gradeAnswer("hablasen", "hablaran", "imperfect_subjunctive")
    ).toEqual({ kind: "exact", grade: 3 });
  });

  it("-se does not match in other tenses", () => {
    expect(gradeAnswer("hablase", "hablara", "preterite")).toEqual({
      kind: "wrong",
      grade: 1,
    });
    expect(gradeAnswer("hablase", "hablara")).toEqual({
      kind: "wrong",
      grade: 1,
    });
  });

  it("pluperfect_subjunctive -ra / -se equivalence on auxiliary", () => {
    expect(
      gradeAnswer(
        "hubiese hablado",
        "hubiera hablado",
        "pluperfect_subjunctive"
      )
    ).toEqual({ kind: "exact", grade: 3 });
    expect(
      gradeAnswer(
        "hubiera hablado",
        "hubiera hablado",
        "pluperfect_subjunctive"
      )
    ).toEqual({ kind: "exact", grade: 3 });
  });

  it("pluperfect (non-subjuntivo) does not honor -se equivalence", () => {
    expect(
      gradeAnswer("hubiese hablado", "hubiera hablado", "pluperfect")
    ).toEqual({ kind: "wrong", grade: 1 });
  });
});

describe("raToSe", () => {
  it("returns null for non-applicable tenses", () => {
    expect(raToSe("hablara", "preterite")).toBeNull();
    expect(raToSe("hablara")).toBeNull();
  });

  it("converts -ra to -se forms in imperfect_subjunctive", () => {
    expect(raToSe("hablara", "imperfect_subjunctive")).toBe("hablase");
    expect(raToSe("habláramos", "imperfect_subjunctive")).toBe("hablásemos");
  });

  it("converts hubiera→hubiese in pluperfect_subjunctive", () => {
    expect(raToSe("hubiera hablado", "pluperfect_subjunctive")).toBe(
      "hubiese hablado"
    );
  });

  it("returns null when no recognizable suffix matches", () => {
    expect(raToSe("hablar", "imperfect_subjunctive")).toBeNull();
    expect(raToSe("would have spoken", "pluperfect_subjunctive")).toBeNull();
  });
});
