import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { pool } from "../../src/db/client.js";
import {
  upsertLookup,
  getDueQueue,
  serveCard,
  rateCard,
  getSessionCounts,
  getReviewById,
  getVocabStateForStems,
  setGlossPack,
  getRowsNeedingGloss,
} from "../../src/db/queries/vocab-reviews.js";
import { emptyCard, nextState } from "../../src/fsrs/scheduler.js";

async function findIdByStem(stem: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "SELECT id::text FROM vocab_reviews WHERE LOWER(stem) = LOWER($1)",
    [stem]
  );
  return result.rows[0].id;
}

async function bumpDuePast(id: string): Promise<void> {
  await pool.query(
    "UPDATE vocab_reviews SET state = 'review', due = NOW() - INTERVAL '1 day' WHERE id = $1",
    [id]
  );
}

describe("vocab-reviews queries", () => {
  it("upsertLookup is idempotent and preserves FSRS state on conflict", async () => {
    const t1 = new Date("2026-05-01T10:00:00Z");
    const t2 = new Date("2026-05-05T10:00:00Z");

    await upsertLookup(pool, {
      stem: "peldaño",
      lang: "es",
      sampleUsage: "primer peldaño",
      sampleWord: "peldaño",
      sampleSource: "Tomo 0001",
      lookedUpAt: t1,
    });

    const id = await findIdByStem("peldaño");

    // Simulate FSRS state on the row.
    await pool.query(
      `UPDATE vocab_reviews
          SET state='review', stability=100, difficulty=5, reps=3, lapses=0
        WHERE id = $1`,
      [id]
    );

    // Re-upsert with case difference + later timestamp.
    await upsertLookup(pool, {
      stem: "PELDAÑO",
      lang: "es",
      sampleUsage: "segundo peldaño",
      sampleWord: "peldaños",
      sampleSource: "Tomo 0002",
      lookedUpAt: t2,
    });

    const after = await pool.query<{
      id: string;
      state: string;
      stability: number;
      sample_usage: string;
      sample_word: string;
      sample_source: string;
      lookups_count: number;
    }>(
      "SELECT id::text, state, stability::float AS stability, sample_usage, sample_word, sample_source, lookups_count FROM vocab_reviews WHERE LOWER(stem) = LOWER($1)",
      ["peldaño"]
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].id).toBe(id);
    expect(after.rows[0].state).toBe("review");
    expect(after.rows[0].stability).toBe(100);
    expect(after.rows[0].sample_usage).toBe("segundo peldaño");
    expect(after.rows[0].sample_word).toBe("peldaños");
    expect(after.rows[0].sample_source).toBe("Tomo 0002");
    expect(after.rows[0].lookups_count).toBe(2);
  });

  it("upsertLookup keeps the latest sample by last_seen_at", async () => {
    const newer = new Date("2026-05-05T10:00:00Z");
    const older = new Date("2026-05-01T10:00:00Z");

    await upsertLookup(pool, {
      stem: "umbral",
      lang: "es",
      sampleUsage: "primer uso",
      sampleWord: "umbral",
      sampleSource: "Tomo 0001",
      lookedUpAt: newer,
    });
    // Re-insert an older one — should NOT clobber sample fields.
    await upsertLookup(pool, {
      stem: "umbral",
      lang: "es",
      sampleUsage: "uso antiguo",
      sampleWord: "umbral",
      sampleSource: "Tomo 0000",
      lookedUpAt: older,
    });
    const row = await pool.query<{
      sample_usage: string;
      lookups_count: number;
    }>(
      "SELECT sample_usage, lookups_count FROM vocab_reviews WHERE LOWER(stem) = LOWER($1)",
      ["umbral"]
    );
    expect(row.rows[0].sample_usage).toBe("primer uso");
    expect(row.rows[0].lookups_count).toBe(2);
  });

  it("getDueQueue caps TOTAL queue size, due first then new", async () => {
    // 3 new cards
    for (const stem of ["aaa", "bbb", "ccc"]) {
      await upsertLookup(pool, {
        stem,
        lang: "es",
        sampleUsage: stem,
        sampleWord: stem,
        sampleSource: null,
        lookedUpAt: new Date("2026-05-01T10:00:00Z"),
      });
    }
    // 2 due cards
    for (const stem of ["due-old", "due-new"]) {
      await upsertLookup(pool, {
        stem,
        lang: "es",
        sampleUsage: stem,
        sampleWord: stem,
        sampleSource: null,
        lookedUpAt: new Date("2026-05-01T10:00:00Z"),
      });
    }
    const oldId = await findIdByStem("due-old");
    const newId = await findIdByStem("due-new");
    await pool.query(
      "UPDATE vocab_reviews SET state='review', due=NOW() - INTERVAL '2 days' WHERE id=$1",
      [oldId]
    );
    await pool.query(
      "UPDATE vocab_reviews SET state='review', due=NOW() - INTERVAL '1 day' WHERE id=$1",
      [newId]
    );

    // totalCap=4 → 2 due (priority, oldest first) + 2 new
    const q = await getDueQueue(pool, 4);
    expect(q.length).toBe(4);
    expect(q[0].id).toBe(oldId);
    expect(q[1].id).toBe(newId);
    expect(q[2].state).toBe("new");
    expect(q[3].state).toBe("new");

    // totalCap=1 → just the oldest due card, no new
    const q1 = await getDueQueue(pool, 1);
    expect(q1.length).toBe(1);
    expect(q1[0].id).toBe(oldId);

    // totalCap=2 → both due cards, no new
    const q2 = await getDueQueue(pool, 2);
    expect(q2.length).toBe(2);
    expect(q2.every((r) => r.state === "review")).toBe(true);
  });

  it("excludes status='suspended' from queue and counts", async () => {
    await upsertLookup(pool, {
      stem: "blocked",
      lang: "es",
      sampleUsage: "blocked",
      sampleWord: "blocked",
      sampleSource: null,
      lookedUpAt: new Date(),
    });
    const id = await findIdByStem("blocked");
    await pool.query(
      "UPDATE vocab_reviews SET status='suspended' WHERE id=$1",
      [id]
    );
    const queue = await getDueQueue(pool, 10);
    expect(queue.find((r) => r.id === id)).toBeUndefined();
    const counts = await getSessionCounts(pool);
    expect(counts.newCards).toBe(0);
  });

  it("rateCard succeeds with matching session_id, double-call is a no-op", async () => {
    await upsertLookup(pool, {
      stem: "racey",
      lang: "es",
      sampleUsage: "racey",
      sampleWord: "racey",
      sampleSource: null,
      lookedUpAt: new Date(),
    });
    const id = await findIdByStem("racey");
    const sessionId = randomUUID();
    await serveCard(pool, { id, sessionId, chatId: "chat-1" });

    const card = emptyCard();
    const next = nextState(card, 3);

    const first = await rateCard(pool, {
      id,
      sessionId,
      rating: 3,
      next,
      chatId: "chat-1",
    });
    expect(first).toBe(true);

    // Re-running with same session — already rated → no-op.
    const second = await rateCard(pool, {
      id,
      sessionId,
      rating: 3,
      next,
      chatId: "chat-1",
    });
    expect(second).toBe(false);

    // Confirm only one log row was written.
    const logRows = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM vocab_review_log WHERE review_id::text = $1",
      [id]
    );
    expect(Number(logRows.rows[0].count)).toBe(1);
  });

  it("rateCard with stale session_id is a no-op (race guard)", async () => {
    await upsertLookup(pool, {
      stem: "stale",
      lang: "es",
      sampleUsage: "stale",
      sampleWord: "stale",
      sampleSource: null,
      lookedUpAt: new Date(),
    });
    const id = await findIdByStem("stale");
    const realSession = randomUUID();
    await serveCard(pool, { id, sessionId: realSession, chatId: "chat-1" });
    const fakeSession = randomUUID();
    const next = nextState(emptyCard(), 3);
    const ok = await rateCard(pool, {
      id,
      sessionId: fakeSession,
      rating: 3,
      next,
      chatId: "chat-1",
    });
    expect(ok).toBe(false);
    // Card untouched.
    const row = await getReviewById(pool, id);
    expect(row?.state).toBe("new");
  });

  it("getSessionCounts reports due/stalling/new", async () => {
    // 1 due-review
    await upsertLookup(pool, {
      stem: "dueOne",
      lang: "es",
      sampleUsage: "u",
      sampleWord: "w",
      sampleSource: null,
      lookedUpAt: new Date(),
    });
    await bumpDuePast(await findIdByStem("dueOne"));

    // 1 stalling (learning)
    await upsertLookup(pool, {
      stem: "stallOne",
      lang: "es",
      sampleUsage: "u",
      sampleWord: "w",
      sampleSource: null,
      lookedUpAt: new Date(),
    });
    await pool.query(
      "UPDATE vocab_reviews SET state='learning' WHERE LOWER(stem) = LOWER($1)",
      ["stallOne"]
    );

    // 2 new
    for (const s of ["newOne", "newTwo"]) {
      await upsertLookup(pool, {
        stem: s,
        lang: "es",
        sampleUsage: "u",
        sampleWord: "w",
        sampleSource: null,
        lookedUpAt: new Date(),
      });
    }

    const counts = await getSessionCounts(pool);
    // Both dueOne (review) and stallOne (learning, due defaults to NOW())
    // satisfy `state<>'new' AND due<=NOW()`.
    expect(counts.due).toBe(2);
    expect(counts.stalling).toBeGreaterThanOrEqual(1);
    expect(counts.newCards).toBe(2);
  });

  it("getVocabStateForStems maps by lowercased stem", async () => {
    await upsertLookup(pool, {
      stem: "Cuesta",
      lang: "es",
      sampleUsage: "Cuesta arriba",
      sampleWord: "cuesta",
      sampleSource: null,
      lookedUpAt: new Date(),
    });
    const map = await getVocabStateForStems(pool, ["CUESTA", "missing"]);
    expect(map.get("cuesta")).toBeDefined();
    expect(map.get("missing")).toBeUndefined();
  });

  it("getVocabStateForStems returns empty for empty input", async () => {
    const map = await getVocabStateForStems(pool, []);
    expect(map.size).toBe(0);
  });

  it("setGlossPack + getRowsNeedingGloss writes all three enrichment fields", async () => {
    await upsertLookup(pool, {
      stem: "needGloss",
      lang: "es",
      sampleUsage: "needGloss",
      sampleWord: "needGloss",
      sampleSource: null,
      lookedUpAt: new Date(),
    });
    const rowsBefore = await getRowsNeedingGloss(pool, 10);
    const target = rowsBefore.find((r) => r.stem === "needGloss");
    expect(target).toBeDefined();
    await setGlossPack(pool, target!.id, {
      gloss: "test gloss (noun)",
      pronunciation: "/test/",
      examples: [
        { es: "Una prueba.", en: "A test." },
        { es: "Otra prueba aquí.", en: "Another test here." },
      ],
    });
    const rowsAfter = await getRowsNeedingGloss(pool, 10);
    expect(rowsAfter.find((r) => r.stem === "needGloss")).toBeUndefined();

    const row = await getReviewById(pool, target!.id);
    expect(row?.gloss).toBe("test gloss (noun)");
    expect(row?.pronunciation).toBe("/test/");
    expect(row?.examples).toHaveLength(2);
    expect(row?.examples[0].es).toBe("Una prueba.");
  });

  it("getRowsNeedingGloss flags rows missing pronunciation or examples", async () => {
    await upsertLookup(pool, {
      stem: "partial",
      lang: "es",
      sampleUsage: "partial",
      sampleWord: "partial",
      sampleSource: null,
      lookedUpAt: new Date(),
    });
    const id = await findIdByStem("partial");
    // Gloss-only row (pre-054 state) — should still be flagged.
    await pool.query(
      "UPDATE vocab_reviews SET gloss='just gloss' WHERE id=$1",
      [id]
    );
    const rows = await getRowsNeedingGloss(pool, 50);
    expect(rows.find((r) => r.stem === "partial")).toBeDefined();
  });
});
