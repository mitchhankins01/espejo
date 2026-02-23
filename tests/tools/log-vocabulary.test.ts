import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  upsertSpanishVocabulary: vi.fn(),
  upsertSpanishProgressSnapshot: vi.fn(),
}));

const mockConfig = vi.hoisted(() => ({
  config: {
    timezone: "Europe/Madrid",
  },
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => mockConfig);

import { handleLogVocabulary } from "../../src/tools/log-vocabulary.js";

const mockPool = {} as any;

beforeEach(() => {
  mockQueries.upsertSpanishVocabulary.mockReset();
  mockQueries.upsertSpanishProgressSnapshot.mockReset();
});

describe("handleLogVocabulary", () => {
  it("creates a new vocabulary item", async () => {
    mockQueries.upsertSpanishVocabulary.mockResolvedValue({
      inserted: true,
      row: {
        id: 11,
        word: "maje",
        translation: "dude",
        region: "honduras",
        part_of_speech: "noun",
        state: "new",
      },
    });
    mockQueries.upsertSpanishProgressSnapshot.mockResolvedValue({});

    const result = await handleLogVocabulary(mockPool, {
      chat_id: "123",
      word: "maje",
      translation: "dude",
      region: "honduras",
    });
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe("created");
    expect(parsed.vocabulary.word).toBe("maje");
    expect(mockQueries.upsertSpanishVocabulary).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        chatId: "123",
        word: "maje",
      })
    );
    expect(mockQueries.upsertSpanishProgressSnapshot).toHaveBeenCalledWith(
      mockPool,
      "123",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    );
  });

  it("updates an existing vocabulary item", async () => {
    mockQueries.upsertSpanishVocabulary.mockResolvedValue({
      inserted: false,
      row: {
        id: 11,
        word: "maje",
        translation: "dude",
        region: "honduras",
        part_of_speech: "noun",
        state: "review",
      },
    });
    mockQueries.upsertSpanishProgressSnapshot.mockResolvedValue({});

    const result = await handleLogVocabulary(mockPool, {
      chat_id: "123",
      word: "maje",
      notes: "seen again",
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("updated");
    expect(parsed.vocabulary.state).toBe("review");
  });

  it("returns null region when vocabulary region is empty", async () => {
    mockQueries.upsertSpanishVocabulary.mockResolvedValue({
      inserted: true,
      row: {
        id: 12,
        word: "hola",
        translation: "hello",
        region: "",
        part_of_speech: "interjection",
        state: "new",
      },
    });
    mockQueries.upsertSpanishProgressSnapshot.mockResolvedValue({});

    const result = await handleLogVocabulary(mockPool, {
      chat_id: "123",
      word: "hola",
    });
    const parsed = JSON.parse(result);
    expect(parsed.vocabulary.region).toBeNull();
  });

  it("rejects missing chat id", async () => {
    await expect(
      handleLogVocabulary(mockPool, {
        word: "maje",
      })
    ).rejects.toThrow();
  });
});
