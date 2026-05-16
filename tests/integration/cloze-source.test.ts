import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import {
  findClozeSentence,
  looksSpanish,
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

  it("deleted artifacts are excluded", async () => {
    await pool.query(
      `INSERT INTO knowledge_artifacts (kind, title, body, deleted_at)
       VALUES ('note', 'deleted', 'Yo tuve hambre ayer pero también frío toda la noche.', NOW())`
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
