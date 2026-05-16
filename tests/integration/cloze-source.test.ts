import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import {
  findClozeSentence,
  looksSpanish,
  extractContaining,
} from "../../src/db/queries/cloze-source.js";

async function seedEntry(uuid: string, text: string): Promise<void> {
  await pool.query(
    `INSERT INTO entries (uuid, text, created_at) VALUES ($1, $2, NOW())
     ON CONFLICT (uuid) DO UPDATE SET text=EXCLUDED.text`,
    [uuid, text]
  );
}

async function seedArtifact(body: string): Promise<void> {
  await pool.query(
    `INSERT INTO knowledge_artifacts (kind, title, body) VALUES ('note', 'cloze-test', $1)`,
    [body]
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
    await seedEntry("e1", "Cuando era joven, viajé mucho por España.");
    const hit = await findClozeSentence(pool, {
      lemma: "ser",
      lang: "es",
      form: "era",
    });
    expect(hit).not.toBeNull();
    expect(hit!.sentence).toContain("era");
    expect(hit!.source).toBe("entries");
  });

  it("word-boundary: 'era' matches but 'verdadera' does not", async () => {
    await seedEntry(
      "e1",
      "Una pregunta verdadera me molesta porque siempre cuestiona la naturaleza."
    );
    const hit = await findClozeSentence(pool, {
      lemma: "ser",
      lang: "es",
      form: "era",
    });
    // No Spanish sentence has bare `era` in this entry — verdadera shouldn't match.
    expect(hit).toBeNull();
  });

  it("English homograph 'the modern era' is rejected by looksSpanish", async () => {
    await seedEntry("e1", "The modern era brings great changes.");
    const hit = await findClozeSentence(pool, {
      lemma: "ser",
      lang: "es",
      form: "era",
    });
    expect(hit).toBeNull();
  });

  it("compound forms: multi-word literal matches", async () => {
    await seedEntry("e1", "Ya he comido hoy con mucha hambre.");
    const hit = await findClozeSentence(pool, {
      lemma: "comer",
      lang: "es",
      form: "he comido",
    });
    expect(hit).not.toBeNull();
    expect(hit!.sentence.toLowerCase()).toContain("he comido");
  });

  it("English 'he went home' does not match Spanish 'he comido'", async () => {
    await seedEntry("e1", "He went home today after the long meeting.");
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
    await seedEntry(
      "e1",
      "Quiero que hables conmigo sobre la cena de mañana."
    );
    await seedEntry(
      "e2",
      "No hables tan rápido por favor, no entiendo bien."
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
    await seedEntry(
      "e1",
      "Cuando era joven, vivía en Madrid con mi familia."
    );
    await seedEntry(
      "e2",
      "Mi padre era muy estricto en aquella época de mi vida."
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

  it("examples take priority over entries", async () => {
    await seedExample("tener", "Yo tuve hambre ayer en la tarde.");
    await seedEntry(
      "e1",
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

  it("artifacts source fires when entries are empty", async () => {
    await seedArtifact("Yo tuve la sensación de que algo cambió esa noche en la cena.");
    const hit = await findClozeSentence(pool, {
      lemma: "tener",
      lang: "es",
      form: "tuve",
    });
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe("artifacts");
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
