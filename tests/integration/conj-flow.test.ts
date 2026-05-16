import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSend, mockGenerate } = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue(undefined),
  mockGenerate: vi.fn(),
}));

vi.mock("../../src/telegram/client.js", () => ({
  sendTelegramMessage: mockSend,
  editTelegramMessageText: vi.fn(),
  sendChatAction: vi.fn(),
  sendTelegramMessageReturningId: vi.fn(),
  sendTelegramVoice: vi.fn(),
  normalizeStreamSnapshot: (s: string) => s,
  createStreamEditor: () => ({ stop: vi.fn() }),
  answerCallbackQuery: vi.fn(),
}));

vi.mock("../../src/llm/cloze-gen.js", () => ({
  generateClozeSentence: mockGenerate,
}));

import { pool } from "../../src/db/client.js";
import {
  startConjFlow,
  continueConjFlow,
  endConjFlow,
} from "../../src/telegram/flows/conj.js";
import {
  setFlow,
  clearAllFlows,
  getFlow,
  type ConjFlowState,
} from "../../src/telegram/flow-state.js";
import { randomUUID } from "crypto";

async function seedCells(): Promise<void> {
  await pool.query(
    `INSERT INTO conjugations (lemma, tense, person, form, pattern, frequency_rank)
     VALUES
       ('ser','imperfect','yo','era','imperfect_irregular',1),
       ('ser','imperfect','tu','eras','imperfect_irregular',1),
       ('ser','imperfect','el','era','imperfect_irregular',1),
       ('ir','imperfect','yo','iba','imperfect_irregular',6),
       ('ir','imperfect','tu','ibas','imperfect_irregular',6),
       ('ver','imperfect','yo','veía','imperfect_irregular',7)
     ON CONFLICT (lemma,tense,person) DO UPDATE
       SET form=EXCLUDED.form, pattern=EXCLUDED.pattern, frequency_rank=EXCLUDED.frequency_rank`
  );
  await pool.query(
    `INSERT INTO knowledge_artifacts (kind, title, body)
     VALUES
       ('reference', 'cloze-1', 'Cuando era joven, vivía en Madrid con mi familia.'),
       ('reference', 'cloze-2', 'Mi padre era muy estricto en aquella época, no le gustaba el ruido.')`
  );
}

const CHAT_ID = "9999";

beforeEach(() => {
  clearAllFlows();
  mockSend.mockClear();
  mockGenerate.mockReset();
  mockGenerate.mockResolvedValue({ sentence: "Sentencia de respaldo.", form: "x" });
});

describe("conj flow lifecycle", () => {
  it("start serves first card with cloze + pattern announce", async () => {
    await seedCells();
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "3",
    });
    expect(mockSend).toHaveBeenCalled();
    const sentText = mockSend.mock.calls.map((c) => c[1] as string).join("\n");
    expect(sentText).toMatch(/cartas/);
    expect(sentText).toMatch(/___/);
    const state = getFlow(CHAT_ID);
    expect(state?.flow).toBe("conj");
    if (state?.flow === "conj") {
      expect(state.pattern).toBe("imperfect_irregular");
      expect(state.currentCardId).toBeTruthy();
      expect(state.currentExpected).toBeTruthy();
    }
  });

  it("correct typed answer rates exact=3 and advances", async () => {
    await seedCells();
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "2",
    });
    const stateAfterStart = getFlow(CHAT_ID) as ConjFlowState;
    const expected = stateAfterStart.currentExpected!;
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: expected,
    });
    const log = await pool.query<{ rating: number; grade_kind: string; typed_answer: string }>(
      `SELECT rating, grade_kind, typed_answer
         FROM conjugation_review_log
        ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].rating).toBe(3);
    expect(log.rows[0].grade_kind).toBe("exact");
    expect(log.rows[0].typed_answer).toBe(expected);
    const after = getFlow(CHAT_ID) as ConjFlowState;
    expect(after.reviewedCount).toBe(1);
    expect(after.queueIndex).toBe(1);
  });

  it("wrong answer rates grade=1 and renders ✗", async () => {
    await seedCells();
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "1",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "zzz",
    });
    const log = await pool.query<{ rating: number; grade_kind: string }>(
      `SELECT rating, grade_kind FROM conjugation_review_log ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].rating).toBe(1);
    expect(log.rows[0].grade_kind).toBe("wrong");
    const sent = mockSend.mock.calls.map((c) => c[1] as string).join("\n");
    expect(sent).toMatch(/✗/);
  });

  it("/easy grades 4 and advances", async () => {
    await seedCells();
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "1",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "/easy",
    });
    const log = await pool.query<{ rating: number; grade_kind: string }>(
      `SELECT rating, grade_kind FROM conjugation_review_log ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].rating).toBe(4);
    expect(log.rows[0].grade_kind).toBe("easy");
  });

  it("unknown slash does not grade and keeps card open", async () => {
    await seedCells();
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "1",
    });
    const stateBefore = getFlow(CHAT_ID) as ConjFlowState;
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "/whatevs",
    });
    const stateAfter = getFlow(CHAT_ID) as ConjFlowState;
    expect(stateAfter.reviewedCount).toBe(0);
    expect(stateAfter.queueIndex).toBe(0);
    expect(stateAfter.currentCardId).toBe(stateBefore.currentCardId);
  });

  it("non-slash garbage is graded as wrong", async () => {
    await seedCells();
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "1",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "🤔",
    });
    const log = await pool.query<{ grade_kind: string }>(
      `SELECT grade_kind FROM conjugation_review_log ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].grade_kind).toBe("wrong");
  });

  it("/done early exit emits Stopped summary and clears flow", async () => {
    await seedCells();
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "3",
    });
    const r = await endConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
    });
    expect(r.ended).toBe(true);
    expect(getFlow(CHAT_ID)).toBeUndefined();
    const sent = mockSend.mock.calls.map((c) => c[1] as string).join("\n");
    expect(sent).toMatch(/Stopped\./);
  });

  it("soft-blocks when another flow is active", async () => {
    await seedCells();
    setFlow(CHAT_ID, {
      flow: "practice",
      sessionId: "x",
      startedAt: Date.now(),
    });
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
    });
    const sent = mockSend.mock.calls.map((c) => c[1] as string).join("\n");
    expect(sent).toMatch(/Termina \/done primero/);
    expect(sent).toMatch(/practice/);
  });

  it("desynced state (currentCardId=null) replies with fail-loud and clears flow", async () => {
    await seedCells();
    // Manually plant a half-broken state
    setFlow(CHAT_ID, {
      flow: "conj",
      sessionId: randomUUID(),
      startedAt: Date.now(),
      pattern: "imperfect_irregular",
      queue: ["1"],
      queueIndex: 0,
      reviewedCount: 0,
      countsByGradeKind: {
        exact: 0,
        wrong: 0,
        easy: 0,
        hint_correct: 0,
        hint_wrong: 0,
        hint_easy: 0,
      },
      hintCount: 0,
      currentCardId: null,
      currentExpected: null,
      currentTense: null,
      currentPattern: null,
      currentPerson: null,
      currentLemma: null,
      currentSentence: null,
      currentClozeSource: null,
      hintUsed: false,
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "era",
    });
    expect(getFlow(CHAT_ID)).toBeUndefined();
    const sent = mockSend.mock.calls.map((c) => c[1] as string).join("\n");
    expect(sent).toMatch(/Card desincronizada/);
  });

  it("falls back to Haiku generation when no corpus hit exists", async () => {
    // Seed a cell but with NO matching corpus sentence for the form.
    await pool.query(
      `INSERT INTO conjugations (lemma, tense, person, form, pattern, frequency_rank)
       VALUES ('zucudir','present_indicative','yo','zucudo','present_regular_ir',null)
       ON CONFLICT (lemma,tense,person) DO UPDATE SET form=EXCLUDED.form`
    );
    mockGenerate.mockResolvedValueOnce({
      sentence: "Yo zucudo todos los días por la mañana.",
      form: "zucudo",
    });
    // Promote and start by inserting a review row directly to avoid pickPattern fallback.
    await pool.query(
      `INSERT INTO conjugation_reviews (lemma, tense, person, expected_form, pattern, due, state)
       VALUES ('zucudir','present_indicative','yo','zucudo','present_regular_ir', NOW() - INTERVAL '1 day', 'review')`
    );
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "1",
    });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const row = await pool.query<{ generated_sentence: string | null }>(
      `SELECT generated_sentence FROM conjugation_reviews WHERE lemma='zucudir'`
    );
    expect(row.rows[0].generated_sentence).toMatch(/zucudo/);
  });
});

describe("conj flow hint handling", () => {
  beforeEach(async () => {
    await seedCells();
  });

  it("/hint reveals hint, doesn't advance, sets hintUsed=true", async () => {
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "1",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "/hint",
    });
    const sent = mockSend.mock.calls.map((c) => c[1] as string).join("\n");
    expect(sent).toMatch(/💡 Pista/);
    const state = getFlow(CHAT_ID) as ConjFlowState;
    expect(state.hintUsed).toBe(true);
    expect(state.reviewedCount).toBe(0);
    const log = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM conjugation_review_log`
    );
    expect(Number(log.rows[0].count)).toBe(0);
  });

  it("hint then correct logs grade_kind='hint_correct' rating=2", async () => {
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "1",
    });
    const expected = (getFlow(CHAT_ID) as ConjFlowState).currentExpected!;
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "/hint",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "3",
      text: expected,
    });
    const log = await pool.query<{
      rating: number;
      grade_kind: string;
      hint_used: boolean;
    }>(
      `SELECT rating, grade_kind, hint_used FROM conjugation_review_log ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].rating).toBe(2);
    expect(log.rows[0].grade_kind).toBe("hint_correct");
    expect(log.rows[0].hint_used).toBe(true);
  });

  it("hint then wrong logs hint_wrong rating=1", async () => {
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "1",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "/hint",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "3",
      text: "zzz",
    });
    const log = await pool.query<{ rating: number; grade_kind: string }>(
      `SELECT rating, grade_kind FROM conjugation_review_log ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].rating).toBe(1);
    expect(log.rows[0].grade_kind).toBe("hint_wrong");
  });

  it("hint then /easy logs hint_easy rating=2", async () => {
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "1",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "/hint",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "3",
      text: "/easy",
    });
    const log = await pool.query<{ rating: number; grade_kind: string }>(
      `SELECT rating, grade_kind FROM conjugation_review_log ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].rating).toBe(2);
    expect(log.rows[0].grade_kind).toBe("hint_easy");
  });

  it("second /hint on same card returns rejection without logging", async () => {
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "1",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "/hint",
    });
    mockSend.mockClear();
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "3",
      text: "/hint",
    });
    const sent = mockSend.mock.calls.map((c) => c[1] as string).join("\n");
    expect(sent).toMatch(/Ya tienes una pista/);
    const state = getFlow(CHAT_ID) as ConjFlowState;
    expect(state.hintCount).toBe(1);
  });

  it("hintUsed resets to false on next card", async () => {
    await startConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "1",
      argText: "2",
    });
    const expected = (getFlow(CHAT_ID) as ConjFlowState).currentExpected!;
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "2",
      text: "/hint",
    });
    await continueConjFlow({
      pool,
      chatId: CHAT_ID,
      externalMessageId: "3",
      text: expected,
    });
    const state = getFlow(CHAT_ID) as ConjFlowState;
    expect(state.hintUsed).toBe(false);
  });
});
