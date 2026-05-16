import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import {
  importConjugations,
  stripPronouns,
} from "../../scripts/import-conjugations.js";

describe("importConjugations", () => {
  it("normalizes raw verbecc forms and classifies into patterns", async () => {
    const rawCells = [
      {
        lemma: "tener",
        tense: "preterite",
        person: "yo",
        raw_form: "yo tuve",
        template: "ten:er",
      },
      {
        lemma: "tener",
        tense: "preterite",
        person: "él",
        raw_form: "él tuvo",
        template: "ten:er",
      },
      {
        lemma: "comer",
        tense: "imperfect",
        person: "yo",
        raw_form: "yo comía",
        template: "com:er",
      },
      {
        lemma: "comer",
        tense: "imperfect",
        person: "ellos",
        raw_form: "ellos comían",
        template: "com:er",
      },
      {
        lemma: "hablar",
        tense: "present_perfect",
        person: "yo",
        raw_form: "yo he hablado",
        template: "habl:ar",
      },
      {
        lemma: "levantarse",
        tense: "present_indicative",
        person: "yo",
        raw_form: "yo me levanto",
        template: "levant:ar",
      },
      // imperative_affirmative for yo should be dropped
      {
        lemma: "hablar",
        tense: "imperative_affirmative",
        person: "yo",
        raw_form: "yo habla",
        template: "habl:ar",
      },
      {
        lemma: "tener",
        tense: "imperative_affirmative",
        person: "tu",
        raw_form: "tú ten",
        template: "ten:er",
      },
      {
        lemma: "hablar",
        tense: "imperative_negative",
        person: "tu",
        raw_form: "tú hables",
        template: "habl:ar",
      },
      // voseo dropped
      {
        lemma: "hablar",
        tense: "present_indicative",
        person: "vos",
        raw_form: "vos hablás",
        template: "habl:ar",
      },
    ];
    const frequency = new Map<string, number>([
      ["ser", 1],
      ["tener", 2],
      ["hacer", 3],
      ["comer", 4],
      ["hablar", 5],
    ]);

    const summary = await importConjugations(pool, rawCells, frequency);
    expect(summary.inserted).toBeGreaterThan(0);
    expect(summary.skipped).toBeGreaterThanOrEqual(2); // vos + imperative yo

    // tener · preterite · yo
    const t1 = await pool.query<{
      form: string;
      pattern: string;
      frequency_rank: number | null;
    }>(
      `SELECT form, pattern, frequency_rank FROM conjugations
        WHERE lemma='tener' AND tense='preterite' AND person='yo'`
    );
    expect(t1.rows.length).toBe(1);
    expect(t1.rows[0].form).toBe("tuve");
    expect(t1.rows[0].pattern).toBe("preterite_strong");
    expect(t1.rows[0].frequency_rank).toBe(2);

    // comer · imperfect rows all imperfect_regular
    const t2 = await pool.query<{ pattern: string }>(
      `SELECT pattern FROM conjugations
        WHERE lemma='comer' AND tense='imperfect'`
    );
    expect(t2.rows.length).toBe(2);
    expect(t2.rows.every((r) => r.pattern === "imperfect_regular")).toBe(true);

    // hablar · present_perfect · yo
    const t3 = await pool.query<{ form: string; pattern: string }>(
      `SELECT form, pattern FROM conjugations
        WHERE lemma='hablar' AND tense='present_perfect' AND person='yo'`
    );
    expect(t3.rows[0].form).toBe("he hablado");
    expect(t3.rows[0].pattern).toBe("present_perfect");

    // levantarse · present · yo → reflexive clitic stripped
    const t4 = await pool.query<{ form: string }>(
      `SELECT form FROM conjugations
        WHERE lemma='levantarse' AND tense='present_indicative' AND person='yo'`
    );
    expect(t4.rows[0].form).toBe("levanto");

    // imperative_affirmative · yo should not exist
    const t5 = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM conjugations
        WHERE tense LIKE 'imperative%' AND person='yo'`
    );
    expect(Number(t5.rows[0].count)).toBe(0);

    // tener · imperative_affirmative · tu → 'ten'
    const t6 = await pool.query<{ form: string; pattern: string }>(
      `SELECT form, pattern FROM conjugations
        WHERE lemma='tener' AND tense='imperative_affirmative' AND person='tu'`
    );
    expect(t6.rows[0].form).toBe("ten");
    expect(t6.rows[0].pattern).toBe("imperative_affirmative_tu_irreg");

    // hablar · imperative_negative · tu → 'hables' (bare subjuntivo)
    const t7 = await pool.query<{ form: string; pattern: string }>(
      `SELECT form, pattern FROM conjugations
        WHERE lemma='hablar' AND tense='imperative_negative' AND person='tu'`
    );
    expect(t7.rows[0].form).toBe("hables");
    expect(t7.rows[0].pattern).toBe("imperative_negative");

    // vos dropped
    const t8 = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM conjugations
        WHERE lemma='hablar' AND tense='present_indicative'`
    );
    // vos was filtered, but no other persons for hablar.present were inserted
    expect(Number(t8.rows[0].count)).toBe(0);
  });

  it("is idempotent on re-run; frequency rank is refreshed", async () => {
    const rawCells = [
      {
        lemma: "hablar",
        tense: "present_indicative",
        person: "yo",
        raw_form: "yo hablo",
        template: "habl:ar",
      },
    ];
    const freq1 = new Map<string, number>([["hablar", 100]]);
    await importConjugations(pool, rawCells, freq1);
    const r1 = await pool.query<{ count: string; frequency_rank: number }>(
      `SELECT COUNT(*)::text AS count,
              (SELECT frequency_rank FROM conjugations WHERE lemma='hablar' LIMIT 1) AS frequency_rank
         FROM conjugations WHERE lemma='hablar'`
    );
    expect(Number(r1.rows[0].count)).toBe(1);
    expect(r1.rows[0].frequency_rank).toBe(100);

    // Re-run with a different rank — row count stable, rank refreshed.
    const freq2 = new Map<string, number>([["hablar", 17]]);
    await importConjugations(pool, rawCells, freq2);
    const r2 = await pool.query<{ count: string; frequency_rank: number }>(
      `SELECT COUNT(*)::text AS count,
              (SELECT frequency_rank FROM conjugations WHERE lemma='hablar' LIMIT 1) AS frequency_rank
         FROM conjugations WHERE lemma='hablar'`
    );
    expect(Number(r2.rows[0].count)).toBe(1);
    expect(r2.rows[0].frequency_rank).toBe(17);
  });

  it("absent-from-frequency lemmas get frequency_rank=NULL", async () => {
    const rawCells = [
      {
        lemma: "zucudir",
        tense: "present_indicative",
        person: "yo",
        raw_form: "yo zucudo",
        template: "zucud:ir",
      },
    ];
    const frequency = new Map<string, number>();
    await importConjugations(pool, rawCells, frequency);
    const r = await pool.query<{ frequency_rank: number | null }>(
      `SELECT frequency_rank FROM conjugations WHERE lemma='zucudir'`
    );
    expect(r.rows[0].frequency_rank).toBeNull();
  });
});

describe("stripPronouns", () => {
  it("strips a leading subject pronoun", () => {
    expect(stripPronouns("yo tuve")).toBe("tuve");
    expect(stripPronouns("él va")).toBe("va");
    expect(stripPronouns("nosotros comemos")).toBe("comemos");
  });

  it("strips a reflexive clitic after subject pronoun", () => {
    expect(stripPronouns("yo me levanto")).toBe("levanto");
    expect(stripPronouns("tú te duermes")).toBe("duermes");
  });

  it("passes through forms with no leading pronoun", () => {
    expect(stripPronouns("hablo")).toBe("hablo");
  });
});
