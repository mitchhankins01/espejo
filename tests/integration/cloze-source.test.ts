import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import {
  findClozeSentence,
  looksSpanish,
  looksStructured,
  extractContaining,
} from "../../src/db/queries/cloze-source.js";

async function seedArtifact(body: string, title = "cloze-test"): Promise<void> {
  await pool.query(
    `INSERT INTO knowledge_artifacts (kind, title, body) VALUES ('reference', $1, $2)`,
    [title, body]
  );
}

async function seedExample(
  stem: string,
  example: string
): Promise<void> {
  await pool.query(
    `INSERT INTO vocab_reviews
       (stem, lang, sample_usage, sample_word, sample_source, first_seen_at, last_seen_at, examples)
     VALUES ($1, 'es', 'sample', $1, NULL, NOW(), NOW(), $2::jsonb)`,
    [stem, JSON.stringify([{ es: example, en: "" }])]
  );
}

describe("findClozeSentence", () => {
  it("returns a corpus sentence containing the form", async () => {
    await seedArtifact("Cuando era joven, viajé mucho por España.");
    const hit = await findClozeSentence(pool, {
      lemma: "ser",
      lang: "es",
      form: "era",
    });
    expect(hit).not.toBeNull();
    expect(hit!.sentence).toContain("era");
    expect(hit!.source).toBe("artifacts");
  });

  it("word-boundary: 'era' matches but 'verdadera' does not", async () => {
    await seedArtifact(
      "Una pregunta verdadera me molesta porque siempre cuestiona la naturaleza."
    );
    const hit = await findClozeSentence(pool, {
      lemma: "ser",
      lang: "es",
      form: "era",
    });
    // No Spanish sentence has bare `era` in this artifact — verdadera shouldn't match.
    expect(hit).toBeNull();
  });

  it("English homograph 'the modern era' is rejected by looksSpanish", async () => {
    await seedArtifact("The modern era brings great changes.");
    const hit = await findClozeSentence(pool, {
      lemma: "ser",
      lang: "es",
      form: "era",
    });
    expect(hit).toBeNull();
  });

  it("compound forms: multi-word literal matches", async () => {
    await seedArtifact("Ya he comido hoy con mucha hambre.");
    const hit = await findClozeSentence(pool, {
      lemma: "comer",
      lang: "es",
      form: "he comido",
    });
    expect(hit).not.toBeNull();
    expect(hit!.sentence.toLowerCase()).toContain("he comido");
  });

  it("English 'he went home' does not match Spanish 'he comido'", async () => {
    await seedArtifact("He went home today after the long meeting.");
    const hit = await findClozeSentence(pool, {
      lemma: "comer",
      lang: "es",
      form: "he comido",
    });
    expect(hit).toBeNull();
  });

  it("imperative_negative anchors on `no <form>` (Spanish only)", async () => {
    // Insert clearly Spanish sentences. "Quiero que hables" should NOT match
    // imperative_negative anchor; "No hables tan rápido por favor" should.
    await seedArtifact(
      "Quiero que hables conmigo sobre la cena de mañana.",
      "subj"
    );
    await seedArtifact(
      "No hables tan rápido por favor, no entiendo bien.",
      "neg"
    );
    const hit = await findClozeSentence(pool, {
      lemma: "hablar",
      lang: "es",
      form: "hables",
      tense: "imperative_negative",
    });
    expect(hit).not.toBeNull();
    expect(hit!.sentence.toLowerCase()).toContain("no hables");
  });

  it("rotates candidates by reps", async () => {
    await seedArtifact(
      "Cuando era joven, vivía en Madrid con mi familia.",
      "rot1"
    );
    await seedArtifact(
      "Mi padre era muy estricto en aquella época de mi vida.",
      "rot2"
    );
    const a = await findClozeSentence(pool, {
      lemma: "ser",
      lang: "es",
      form: "era",
      reps: 0,
    });
    const b = await findClozeSentence(pool, {
      lemma: "ser",
      lang: "es",
      form: "era",
      reps: 1,
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // With two candidates, reps=0 and reps=1 must surface different sentences.
    expect(a!.sentence).not.toBe(b!.sentence);
  });

  it("returns null when no corpus hits exist", async () => {
    const hit = await findClozeSentence(pool, {
      lemma: "tener",
      lang: "es",
      form: "tuve",
    });
    expect(hit).toBeNull();
  });

  it("examples take priority over artifacts", async () => {
    await seedExample("tener", "Yo tuve hambre ayer en la tarde.");
    await seedArtifact(
      "Cuando tuve el perro, era niño y vivía en el campo."
    );
    const hit = await findClozeSentence(pool, {
      lemma: "tener",
      lang: "es",
      form: "tuve",
    });
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe("examples");
  });

  it("entries.text is NOT a cloze source (regression: don't drill against the user's own errors)", async () => {
    await pool.query(
      `INSERT INTO entries (uuid, text, created_at)
       VALUES ('e-no-source', 'Yo tuve la sensación de que algo cambió.', NOW())
       ON CONFLICT (uuid) DO UPDATE SET text=EXCLUDED.text`
    );
    const hit = await findClozeSentence(pool, {
      lemma: "tener",
      lang: "es",
      form: "tuve",
    });
    expect(hit).toBeNull();
  });

  it("kind='insight' artifacts are NOT a cloze source (regression: 'Mitch has gone three days without weed' was an English insight body matched on 'has')", async () => {
    await pool.query(
      `INSERT INTO knowledge_artifacts (kind, title, body)
       VALUES ('insight', 'eng-insight', 'Mitch has gone three days without weed despite cravings, anchored by a no-weed-in-April agreement.')`
    );
    const hit = await findClozeSentence(pool, {
      lemma: "haber",
      lang: "es",
      form: "has",
    });
    expect(hit).toBeNull();
  });

  it("kind='note' artifacts are NOT a cloze source (regression: structured YAML note body matched on 'estoy')", async () => {
    await pool.query(
      `INSERT INTO knowledge_artifacts (kind, title, body)
       VALUES ('note', 'note-skip', 'Cuando estoy cansado en la oficina hablamos de descansar.')`
    );
    const hit = await findClozeSentence(pool, {
      lemma: "estar",
      lang: "es",
      form: "estoy",
    });
    expect(hit).toBeNull();
  });

  it("kind='reference' artifacts are allowed", async () => {
    await pool.query(
      `INSERT INTO knowledge_artifacts (kind, title, body)
       VALUES ('reference', 'ref-ok', 'Cuando era niño, jugaba mucho en el parque con amigos.')`
    );
    const hit = await findClozeSentence(pool, {
      lemma: "ser",
      lang: "es",
      form: "era",
    });
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe("artifacts");
  });

  it("rejects YAML/structured artifact segments even when kind='reference'", async () => {
    await pool.query(
      `INSERT INTO knowledge_artifacts (kind, title, body)
       VALUES ('reference', 'yaml-skip',
               'common_traps:\n  - sabía vs supe\n  - estoy vs soy\n  - ser vs estar')`
    );
    const hit = await findClozeSentence(pool, {
      lemma: "estar",
      lang: "es",
      form: "estoy",
    });
    expect(hit).toBeNull();
  });

  it("rejects attributed-journal blockquote panels even inside kind='reference' (regression: Thyroid History leaked 'Pero tiene sentido…\"* — 2026-04-04')", async () => {
    // This mirrors the actual artifact body that triggered the 2026-05-18
    // incident: a `kind='reference'` artifact (Thyroid History) that quotes
    // three dated Day One entries inside a blockquote panel. The cloze
    // candidate spans paragraph boundaries and carries the citation tail.
    await pool.query(
      `INSERT INTO knowledge_artifacts (kind, title, body)
       VALUES ('reference', 'thyroid-panel',
               $$Sample April 2026 quotes:

> *"sentía dopamine drained y brainsoup, no podía pensar bien"* — 2026-04-22
> *"aún estoy dopamine drained y my cerebro está lento. Pero tiene sentido porque tuve nicotina y hierba varias veces esta semana"* — 2026-04-04
> *"Wired and tired simultaneously — the dopamine trough after a genuinely big week"* — 2026-03-09

These have a clear competing explanation.$$)`
    );
    const hit = await findClozeSentence(pool, {
      lemma: "tener",
      lang: "es",
      form: "tiene",
    });
    // We may surface a fallback from elsewhere if the corpus has one — but the
    // panel-derived candidate must NOT come back with citation/blockquote
    // residue.
    if (hit) {
      expect(hit.sentence).not.toMatch(/—\s*\d{4}-\d{2}-\d{2}/);
      expect(hit.sentence).not.toMatch(/(^|\n)\s*>\s/);
      expect(hit.sentence).not.toMatch(/["'][\s]*\*[\s]*—/);
    }
  });

  it("examples carry the English gloss when available", async () => {
    await pool.query(
      `INSERT INTO vocab_reviews
         (stem, lang, sample_usage, sample_word, sample_source, first_seen_at, last_seen_at, examples)
       VALUES ('ser','es','s','ser',NULL,NOW(),NOW(), $1::jsonb)`,
      [JSON.stringify([{ es: "Somos amigos desde hace años.", en: "We've been friends for years." }])]
    );
    const hit = await findClozeSentence(pool, {
      lemma: "ser",
      lang: "es",
      form: "somos",
    });
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe("examples");
    expect(hit!.gloss).toBe("We've been friends for years.");
  });

  it("deleted artifacts are excluded", async () => {
    await pool.query(
      `INSERT INTO knowledge_artifacts (kind, title, body, deleted_at)
       VALUES ('reference', 'deleted', 'Yo tuve hambre ayer pero también frío toda la noche.', NOW())`
    );
    const hit = await findClozeSentence(pool, {
      lemma: "tener",
      lang: "es",
      form: "tuve",
    });
    expect(hit).toBeNull();
  });
});

describe("looksSpanish", () => {
  it("accepts sentences with accents", () => {
    expect(looksSpanish("Tuvé que esperar.")).toBe(true);
    expect(looksSpanish("¿Cómo estás?")).toBe(true);
  });

  it("accepts sentences with multiple Spanish function tokens", () => {
    expect(looksSpanish("el perro y la casa")).toBe(true);
    expect(looksSpanish("cuando me dijo que no podía")).toBe(true);
  });

  it("rejects English-only sentences", () => {
    expect(looksSpanish("the modern era brings change")).toBe(false);
    expect(looksSpanish("he went home today")).toBe(false);
  });

  it("rejects English passages with a stray accented Spanish token (regression: insight matched on 'has')", () => {
    expect(
      looksSpanish(
        "Mitch has gone three days without weed despite cravings, anchored by an agreement with Nicolás."
      )
    ).toBe(false);
  });
});

describe("looksStructured", () => {
  it("flags YAML mapping rows", () => {
    expect(looksStructured("common_traps:")).toBe(true);
    expect(looksStructured("    - sabía vs supe")).toBe(true);
  });

  it("flags markdown bullets and headings", () => {
    expect(looksStructured("# Heading")).toBe(true);
    expect(looksStructured("* bullet item")).toBe(true);
  });

  it("flags multi-line non-prose blocks", () => {
    expect(looksStructured("line one\nline two\nline three")).toBe(true);
  });

  it("flags markdown blockquote markers", () => {
    expect(looksStructured("> *\"esto sí lo entiendo\"* — 2026-04-04")).toBe(true);
    expect(looksStructured("Pero tiene sentido aquí.\n> y luego algo más")).toBe(true);
  });

  it("flags citation-date suffixes", () => {
    expect(
      looksStructured("Pero tiene sentido porque tuve hambre — 2026-04-04")
    ).toBe(true);
  });

  it("flags attribution suffixes", () => {
    expect(looksStructured('aún estoy aquí"* — 2026-04-04')).toBe(true);
  });

  it("does not flag a normal sentence", () => {
    expect(looksStructured("Somos amigos desde hace años.")).toBe(false);
  });
});

describe("extractContaining", () => {
  it("returns the segment containing the form", () => {
    const out = extractContaining(
      "Hello world. Cuando era joven, viajé mucho. Final segment.",
      "era"
    );
    expect(out).toContain("era");
    expect(out).not.toContain("Final");
  });

  it("truncates long segments at SENTENCE_MAX_LEN", () => {
    const long = "Era una vez " + "x".repeat(200);
    const out = extractContaining(long, "era");
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(140);
  });

  it("returns null when form not in any segment", () => {
    const out = extractContaining("nothing here. nope.", "zzz");
    expect(out).toBeNull();
  });
});
