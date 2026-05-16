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
import { routeMessage } from "../../src/telegram/router.js";
import { clearAllFlows, getFlow } from "../../src/telegram/flow-state.js";
import type { AssembledMessage } from "../../src/telegram/updates.js";

const CHAT_ID = 7777;

async function seedCells(): Promise<void> {
  await pool.query(
    `INSERT INTO conjugations (lemma, tense, person, form, pattern, frequency_rank)
     VALUES
       ('ser','imperfect','yo','era','imperfect_irregular',1),
       ('ser','imperfect','tu','eras','imperfect_irregular',1),
       ('ir','imperfect','yo','iba','imperfect_irregular',6)
     ON CONFLICT (lemma,tense,person) DO UPDATE
       SET form=EXCLUDED.form, pattern=EXCLUDED.pattern, frequency_rank=EXCLUDED.frequency_rank`
  );
  await pool.query(
    `INSERT INTO entries (uuid, text, created_at)
     VALUES ('e1', 'Cuando era joven, vivía en Madrid.', NOW())
     ON CONFLICT (uuid) DO UPDATE SET text=EXCLUDED.text`
  );
}

function makeMsg(
  text: string,
  messageId = 1,
  chatId = CHAT_ID
): AssembledMessage {
  return {
    chatId,
    messageId,
    date: Math.floor(Date.now() / 1000),
    text,
  };
}

beforeEach(() => {
  clearAllFlows();
  mockSend.mockClear();
  mockGenerate.mockReset();
  mockGenerate.mockResolvedValue({ sentence: "X", form: "x" });
});

describe("router: /conj registration", () => {
  it("/conj 3 routes to startConjFlow and sets conj state", async () => {
    await seedCells();
    await routeMessage({ pool }, makeMsg("/conj 3"));
    expect(getFlow(String(CHAT_ID))?.flow).toBe("conj");
  });

  it("/conj with no active flow proceeds (defaults cap=20)", async () => {
    await seedCells();
    await routeMessage({ pool }, makeMsg("/conj"));
    expect(getFlow(String(CHAT_ID))?.flow).toBe("conj");
  });

  it("typed answer while in conj flow routes to continueConjFlow (rates), NOT srs prose-nudge", async () => {
    await seedCells();
    await routeMessage({ pool }, makeMsg("/conj 1"));
    const expected = (getFlow(String(CHAT_ID)) as { currentExpected: string })
      .currentExpected;
    expect(expected).toBeTruthy();
    await routeMessage({ pool }, makeMsg(expected, 2));
    const log = await pool.query<{ grade_kind: string }>(
      `SELECT grade_kind FROM conjugation_review_log ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].grade_kind).toBe("exact");
  });

  it("/hint while in conj routes to continueConjFlow (sets hintUsed)", async () => {
    await seedCells();
    await routeMessage({ pool }, makeMsg("/conj 1"));
    await routeMessage({ pool }, makeMsg("/hint", 2));
    const state = getFlow(String(CHAT_ID));
    expect(state?.flow).toBe("conj");
    if (state?.flow === "conj") {
      expect(state.hintUsed).toBe(true);
    }
  });

  it("/done while in conj routes to endConjFlow (clears state)", async () => {
    await seedCells();
    await routeMessage({ pool }, makeMsg("/conj 3"));
    await routeMessage({ pool }, makeMsg("/done", 2));
    expect(getFlow(String(CHAT_ID))).toBeUndefined();
    const sent = mockSend.mock.calls.map((c) => c[1] as string).join("\n");
    expect(sent).toMatch(/Stopped\./);
  });

  it("/easy while in conj routes to continueConjFlow (rates easy=4)", async () => {
    await seedCells();
    await routeMessage({ pool }, makeMsg("/conj 1"));
    await routeMessage({ pool }, makeMsg("/easy", 2));
    const log = await pool.query<{ rating: number; grade_kind: string }>(
      `SELECT rating, grade_kind FROM conjugation_review_log ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].rating).toBe(4);
    expect(log.rows[0].grade_kind).toBe("easy");
  });
});
