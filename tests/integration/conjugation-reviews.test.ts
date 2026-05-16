import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { pool } from "../../src/db/client.js";
import {
  pickPatternForSession,
  buildConjugationQueue,
  serveConjugationCard,
  rateConjugationCard,
  getConjugationReviewById,
  getConjugationSessionCounts,
  getPatternBucketCounts,
  cacheGeneratedSentence,
} from "../../src/db/queries/conjugation-reviews.js";
import {
  getConjugation,
  getCellsForLemma,
  getCellsByPattern,
  countCellsPerPattern,
} from "../../src/db/queries/conjugations.js";
import { nextState } from "../../src/fsrs/scheduler.js";

async function seedConjugationCells(
  cells: {
    lemma: string;
    tense: string;
    person: string;
    form: string;
    pattern: string;
    rank?: number | null;
  }[]
): Promise<void> {
  for (const c of cells) {
    await pool.query(
      `INSERT INTO conjugations (lemma, tense, person, form, pattern, frequency_rank)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lemma, tense, person) DO UPDATE
         SET form=EXCLUDED.form, pattern=EXCLUDED.pattern, frequency_rank=EXCLUDED.frequency_rank`,
      [c.lemma, c.tense, c.person, c.form, c.pattern, c.rank ?? null]
    );
  }
}

describe("conjugation queries", () => {
  it("getConjugation / getCellsForLemma / countCellsPerPattern", async () => {
    await seedConjugationCells([
      { lemma: "tener", tense: "preterite", person: "yo", form: "tuve", pattern: "preterite_strong", rank: 2 },
      { lemma: "tener", tense: "preterite", person: "tu", form: "tuviste", pattern: "preterite_strong", rank: 2 },
      { lemma: "hablar", tense: "preterite", person: "yo", form: "hablé", pattern: "preterite_regular_ar", rank: 5 },
    ]);

    const cell = await getConjugation(pool, "tener", "preterite", "yo");
    expect(cell?.form).toBe("tuve");

    const cells = await getCellsForLemma(pool, "tener");
    expect(cells.length).toBe(2);

    const byPattern = await getCellsByPattern(pool, "preterite_strong", 10);
    expect(byPattern.length).toBe(2);

    const counts = await countCellsPerPattern(pool);
    expect(counts.find((c) => c.pattern === "preterite_strong")?.cells).toBe(2);
    expect(counts.find((c) => c.pattern === "preterite_regular_ar")?.cells).toBe(1);
  });

  it("getConjugation returns null when missing", async () => {
    const r = await getConjugation(pool, "nope", "preterite", "yo");
    expect(r).toBeNull();
  });
});

describe("pickPatternForSession", () => {
  it("cold start: picks first bootstrap-priority pattern with ranked candidates", async () => {
    await seedConjugationCells([
      // present_irregular wins per bootstrap priority
      { lemma: "ser", tense: "present_indicative", person: "yo", form: "soy", pattern: "present_irregular", rank: 1 },
      { lemma: "ser", tense: "present_indicative", person: "tu", form: "eres", pattern: "present_irregular", rank: 1 },
      // present_yo_go (priority 2)
      { lemma: "tener", tense: "present_indicative", person: "yo", form: "tengo", pattern: "present_yo_go", rank: 2 },
      // bigger regular bucket — would win on "largest bucket" but shouldn't on bootstrap
      { lemma: "hablar", tense: "present_indicative", person: "yo", form: "hablo", pattern: "present_regular_ar", rank: 5 },
      { lemma: "hablar", tense: "present_indicative", person: "tu", form: "hablas", pattern: "present_regular_ar", rank: 5 },
      { lemma: "hablar", tense: "present_indicative", person: "el", form: "habla", pattern: "present_regular_ar", rank: 5 },
    ]);
    const pattern = await pickPatternForSession(pool);
    expect(pattern).toBe("present_irregular");
  });

  it("cold start: skips patterns with no ranked candidates", async () => {
    await seedConjugationCells([
      // No rank — should be skipped
      { lemma: "weird", tense: "present_indicative", person: "yo", form: "x", pattern: "present_irregular", rank: null },
      { lemma: "tener", tense: "present_indicative", person: "yo", form: "tengo", pattern: "present_yo_go", rank: 2 },
    ]);
    const pattern = await pickPatternForSession(pool);
    expect(pattern).toBe("present_yo_go");
  });

  it("cold start: returns null when no ranked candidates exist", async () => {
    const pattern = await pickPatternForSession(pool);
    expect(pattern).toBeNull();
  });

  it("existing reviews: most-due-cells wins", async () => {
    await seedConjugationCells([
      { lemma: "tener", tense: "preterite", person: "yo", form: "tuve", pattern: "preterite_strong", rank: 2 },
      { lemma: "tener", tense: "preterite", person: "tu", form: "tuviste", pattern: "preterite_strong", rank: 2 },
      { lemma: "hablar", tense: "preterite", person: "yo", form: "hablé", pattern: "preterite_regular_ar", rank: 5 },
    ]);
    // Promote two preterite_strong rows that are due, and one preterite_regular_ar row also due.
    await pool.query(
      `INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern, state, due)
       VALUES
         ('tener','preterite','yo','tuve','preterite_strong','review', NOW() - INTERVAL '1 day'),
         ('tener','preterite','tu','tuviste','preterite_strong','review', NOW() - INTERVAL '2 day'),
         ('hablar','preterite','yo','hablé','preterite_regular_ar','review', NOW() - INTERVAL '1 day')`
    );
    const pattern = await pickPatternForSession(pool);
    expect(pattern).toBe("preterite_strong");
  });
});

describe("buildConjugationQueue", () => {
  it("promotes ranked candidates lazily in frequency order; rare verbs last", async () => {
    await seedConjugationCells([
      { lemma: "tener", tense: "preterite", person: "yo", form: "tuve", pattern: "preterite_strong", rank: 2 },
      { lemma: "venir", tense: "preterite", person: "yo", form: "vine", pattern: "preterite_strong", rank: 15 },
      { lemma: "asir", tense: "preterite", person: "yo", form: "así", pattern: "preterite_strong", rank: null },
    ]);
    const ids = await buildConjugationQueue(pool, "preterite_strong", 2);
    expect(ids.length).toBe(2);
    const rows = await pool.query<{ lemma: string }>(
      `SELECT lemma FROM conjugation_reviews
        WHERE pattern='preterite_strong'
        ORDER BY id ASC`
    );
    // The two promoted should be the two with the lowest frequency_rank.
    const lemmas = rows.rows.map((r) => r.lemma);
    expect(lemmas).toContain("tener");
    expect(lemmas).toContain("venir");
    expect(lemmas).not.toContain("asir");
  });

  it("returns due rows first, then new rows, then promotions", async () => {
    await seedConjugationCells([
      { lemma: "tener", tense: "preterite", person: "yo", form: "tuve", pattern: "preterite_strong", rank: 2 },
      { lemma: "venir", tense: "preterite", person: "yo", form: "vine", pattern: "preterite_strong", rank: 15 },
    ]);
    // Seed one already-due review for tener; venir stays unpromoted.
    await pool.query(
      `INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern, state, due)
       VALUES ('tener','preterite','yo','tuve','preterite_strong','review', NOW() - INTERVAL '1 day')`
    );
    const ids = await buildConjugationQueue(pool, "preterite_strong", 2);
    expect(ids.length).toBe(2);
    // First should be the due tener row
    const firstRow = await pool.query<{ lemma: string }>(
      `SELECT lemma FROM conjugation_reviews WHERE id::text = $1`,
      [ids[0]]
    );
    expect(firstRow.rows[0].lemma).toBe("tener");
  });

  it("excludes suspended cells", async () => {
    await seedConjugationCells([
      { lemma: "tener", tense: "preterite", person: "yo", form: "tuve", pattern: "preterite_strong", rank: 2 },
    ]);
    await pool.query(
      `INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern, status, state, due)
       VALUES ('tener','preterite','yo','tuve','preterite_strong','suspended','review',NOW() - INTERVAL '1 day')`
    );
    const ids = await buildConjugationQueue(pool, "preterite_strong", 5);
    // The suspended one is filtered from due/new queries; the promote step
    // will see the row already exists in cr, so it won't be promoted either.
    expect(ids.length).toBe(0);
  });
});

describe("serveConjugationCard / rateConjugationCard", () => {
  it("race-safe: double rate returns false the second time", async () => {
    await seedConjugationCells([
      { lemma: "tener", tense: "preterite", person: "yo", form: "tuve", pattern: "preterite_strong", rank: 2 },
    ]);
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern)
       VALUES ('tener','preterite','yo','tuve','preterite_strong')
       RETURNING id::text`
    );
    const id = ins.rows[0].id;
    const sessionId = randomUUID();
    await serveConjugationCard(pool, { id, sessionId, chatId: "1" });
    const row = await getConjugationReviewById(pool, id);
    expect(row?.current_session_id).toBe(sessionId);

    const next = nextState(
      {
        due: row!.due,
        stability: row!.stability,
        difficulty: row!.difficulty,
        elapsed_days: row!.elapsed_days,
        scheduled_days: row!.scheduled_days,
        reps: row!.reps,
        lapses: row!.lapses,
        state: row!.state,
        last_review: row!.last_review,
      },
      3
    );
    const ok1 = await rateConjugationCard(pool, {
      id,
      sessionId,
      rating: 3,
      gradeKind: "exact",
      typedAnswer: "tuve",
      hintUsed: false,
      clozeSource: "corpus",
      next,
      chatId: "1",
    });
    expect(ok1).toBe(true);
    const ok2 = await rateConjugationCard(pool, {
      id,
      sessionId,
      rating: 3,
      gradeKind: "exact",
      typedAnswer: "tuve",
      hintUsed: false,
      clozeSource: "corpus",
      next,
      chatId: "1",
    });
    expect(ok2).toBe(false);

    const log = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM conjugation_review_log WHERE review_id::text = $1`,
      [id]
    );
    expect(Number(log.rows[0].count)).toBe(1);
  });

  it("rate fails when session_id doesn't match", async () => {
    await seedConjugationCells([
      { lemma: "tener", tense: "preterite", person: "yo", form: "tuve", pattern: "preterite_strong", rank: 2 },
    ]);
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern)
       VALUES ('tener','preterite','yo','tuve','preterite_strong')
       RETURNING id::text`
    );
    const id = ins.rows[0].id;
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    await serveConjugationCard(pool, { id, sessionId: sessionA, chatId: "1" });
    const row = await getConjugationReviewById(pool, id);
    const next = nextState(
      {
        due: row!.due,
        stability: row!.stability,
        difficulty: row!.difficulty,
        elapsed_days: row!.elapsed_days,
        scheduled_days: row!.scheduled_days,
        reps: row!.reps,
        lapses: row!.lapses,
        state: row!.state,
        last_review: row!.last_review,
      },
      3
    );
    const ok = await rateConjugationCard(pool, {
      id,
      sessionId: sessionB,
      rating: 3,
      gradeKind: "exact",
      typedAnswer: "tuve",
      hintUsed: false,
      clozeSource: "corpus",
      next,
      chatId: "1",
    });
    expect(ok).toBe(false);
  });
});

describe("getConjugationSessionCounts", () => {
  it("counts due / stalling / unpromoted with ranked-only filter", async () => {
    await seedConjugationCells([
      { lemma: "tener", tense: "preterite", person: "yo", form: "tuve", pattern: "preterite_strong", rank: 2 },
      { lemma: "tener", tense: "preterite", person: "tu", form: "tuviste", pattern: "preterite_strong", rank: 2 },
      { lemma: "asir", tense: "preterite", person: "yo", form: "así", pattern: "preterite_strong", rank: null },
    ]);
    await pool.query(
      `INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern, state, due, lapses, last_review)
       VALUES
         ('tener','preterite','yo','tuve','preterite_strong','review', NOW() - INTERVAL '1 day', 0, NULL),
         ('tener','preterite','tu','tuviste','preterite_strong','learning', NOW() - INTERVAL '2 day', 3, NOW() - INTERVAL '1 day')`
    );
    const counts = await getConjugationSessionCounts(pool);
    expect(counts.due).toBeGreaterThanOrEqual(1);
    expect(counts.stalling).toBeGreaterThanOrEqual(1);
    // asir is rank=null so excluded from unpromoted; tener rows are promoted → 0
    expect(counts.unpromoted).toBe(0);
  });
});

describe("getPatternBucketCounts", () => {
  it("groups promoted + due by pattern", async () => {
    await pool.query(
      `INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern, state, due)
       VALUES
         ('a','present_indicative','yo','x','present_regular_ar','review', NOW() - INTERVAL '1 day'),
         ('b','present_indicative','yo','y','present_regular_ar','new', NOW()),
         ('c','preterite','yo','z','preterite_strong','review', NOW() - INTERVAL '1 day')`
    );
    const counts = await getPatternBucketCounts(pool);
    const ar = counts.find((c) => c.pattern === "present_regular_ar")!;
    expect(ar.promoted).toBe(2);
    expect(ar.due).toBe(1);
    const strong = counts.find((c) => c.pattern === "preterite_strong")!;
    expect(strong.promoted).toBe(1);
    expect(strong.due).toBe(1);
  });
});

describe("cacheGeneratedSentence", () => {
  it("stores sentence + form on the row", async () => {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern)
       VALUES ('tener','preterite','yo','tuve','preterite_strong')
       RETURNING id::text`
    );
    await cacheGeneratedSentence(pool, ins.rows[0].id, "Yo tuve hambre.", "tuve");
    const row = await getConjugationReviewById(pool, ins.rows[0].id);
    expect(row?.generated_sentence).toBe("Yo tuve hambre.");
    expect(row?.generated_form).toBe("tuve");
  });
});

describe("getConjugationReviewById", () => {
  it("returns null for missing id", async () => {
    const r = await getConjugationReviewById(pool, "99999999");
    expect(r).toBeNull();
  });
});
