import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAnswerCallbackQuery } = vi.hoisted(() => ({
  mockAnswerCallbackQuery: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/telegram/client.js", () => ({
  answerCallbackQuery: mockAnswerCallbackQuery,
}));

import {
  processUpdate,
  setMessageHandler,
  clearMessageHandler,
  isDuplicate,
  clearDedupCache,
  clearFragmentBuffers,
  clearMediaGroupBuffers,
  enqueue,
  getQueuePromise,
  type TelegramUpdate,
  type AssembledMessage,
} from "../../src/telegram/updates.js";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  clearDedupCache();
  clearFragmentBuffers();
  clearMediaGroupBuffers();
  clearMessageHandler();
  mockAnswerCallbackQuery.mockReset().mockResolvedValue(undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

function makeUpdate(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 100000),
    ...overrides,
  };
}

function makeTextUpdate(
  text: string,
  messageId = 1,
  chatId = 100
): TelegramUpdate {
  return makeUpdate({
    message: {
      message_id: messageId,
      chat: { id: chatId },
      from: { id: 42 },
      text,
      date: Math.floor(Date.now() / 1000),
    },
  });
}

describe("isDuplicate", () => {
  it("rejects duplicate update_id", () => {
    const update = makeUpdate({ update_id: 1 });
    expect(isDuplicate(update)).toBe(false);
    expect(isDuplicate(update)).toBe(true);
  });

  it("rejects duplicate callback query ID", () => {
    const update = makeUpdate({
      update_id: 1,
      callback_query: {
        id: "cb-123",
        message: { message_id: 1, chat: { id: 100 }, date: 0 },
        data: "yes",
      },
    });
    expect(isDuplicate(update)).toBe(false);

    const update2 = makeUpdate({
      update_id: 2, // different update_id
      callback_query: {
        id: "cb-123", // same callback_query id
        message: { message_id: 1, chat: { id: 100 }, date: 0 },
        data: "yes",
      },
    });
    expect(isDuplicate(update2)).toBe(true);
  });

  it("rejects duplicate (chat_id, message_id)", () => {
    const update = makeTextUpdate("hello", 5, 200);
    expect(isDuplicate(update)).toBe(false);

    const update2 = makeUpdate({
      update_id: update.update_id + 1,
      message: {
        message_id: 5,
        chat: { id: 200 },
        text: "hello",
        date: 0,
      },
    });
    expect(isDuplicate(update2)).toBe(true);
  });

  it("expires entries after TTL", () => {
    const update = makeUpdate({ update_id: 99 });
    expect(isDuplicate(update)).toBe(false);

    // Advance past TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(isDuplicate(update)).toBe(false);
  });

  it("evicts oldest entries when exceeding max size", () => {
    // Fill cache with 2000 entries
    for (let i = 0; i < 2000; i++) {
      isDuplicate(makeUpdate({ update_id: i }));
    }

    // Add one more — should evict oldest
    isDuplicate(makeUpdate({ update_id: 9999 }));

    // First entry should be evicted
    expect(isDuplicate(makeUpdate({ update_id: 0 }))).toBe(false);

    // Recent entry should still be there
    expect(isDuplicate(makeUpdate({ update_id: 1999 }))).toBe(true);
  });
});

describe("enqueue", () => {
  it("processes tasks sequentially within a chat", async () => {
    const order: number[] = [];

    enqueue("chat1", async () => {
      order.push(1);
    });
    enqueue("chat1", async () => {
      order.push(2);
    });
    enqueue("chat1", async () => {
      order.push(3);
    });

    await getQueuePromise("chat1");
    expect(order).toEqual([1, 2, 3]);
  });

  it("runs different chats independently", async () => {
    const order: string[] = [];

    enqueue("a", async () => {
      order.push("a1");
    });
    enqueue("b", async () => {
      order.push("b1");
    });
    enqueue("a", async () => {
      order.push("a2");
    });

    await Promise.all([getQueuePromise("a"), getQueuePromise("b")]);
    expect(order).toContain("a1");
    expect(order).toContain("a2");
    expect(order).toContain("b1");
  });

  it("logs errors and continues queue", async () => {
    const order: number[] = [];

    enqueue("chat1", async () => {
      order.push(1);
      throw new Error("fail");
    });
    enqueue("chat1", async () => {
      order.push(2);
    });

    await getQueuePromise("chat1");
    expect(order).toEqual([1, 2]);
    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram enqueue error:",
      expect.any(Error)
    );
  });
});

describe("processUpdate", () => {
  let handler: ReturnType<typeof vi.fn<(msg: AssembledMessage) => Promise<void>>>;

  beforeEach(() => {
    handler = vi.fn<(msg: AssembledMessage) => Promise<void>>().mockResolvedValue(undefined);
    setMessageHandler(handler);
  });

  it("ignores updates when no handler is set", () => {
    clearMessageHandler();
    processUpdate(makeTextUpdate("hello"));
    // No error thrown
  });

  it("processes a normal text message", async () => {
    const update = makeTextUpdate("hello world", 1, 100);
    processUpdate(update);

    await getQueuePromise("100");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 100,
        text: "hello world",
        messageId: 1,
      })
    );
  });

  it("deduplicates repeated updates", async () => {
    const update = makeTextUpdate("hello", 1, 100);
    processUpdate(update);
    processUpdate(update);

    await getQueuePromise("100");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("processes voice messages directly", async () => {
    const update = makeUpdate({
      message: {
        message_id: 1,
        chat: { id: 100 },
        from: { id: 42 },
        voice: { file_id: "voice-123", duration: 10 },
        caption: "transcribe this",
        date: 1000,
      },
    });

    processUpdate(update);
    await getQueuePromise("100");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 100,
        text: "transcribe this",
        messageId: 1,
        voice: { fileId: "voice-123", durationSeconds: 10 },
      })
    );
  });

  it("handles voice message without caption", async () => {
    const update = makeUpdate({
      message: {
        message_id: 1,
        chat: { id: 100 },
        from: { id: 42 },
        voice: { file_id: "voice-456", duration: 5 },
        date: 1000,
      },
    });

    processUpdate(update);
    await getQueuePromise("100");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        voice: { fileId: "voice-456", durationSeconds: 5 },
      })
    );
  });

  it("processes callback queries", async () => {
    const update = makeUpdate({
      callback_query: {
        id: "cb-1",
        message: { message_id: 5, chat: { id: 100 }, date: 1000 },
        data: "confirm_yes",
      },
    });

    processUpdate(update);
    await getQueuePromise("100");

    expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("cb-1");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 100,
        text: "confirm_yes",
        callbackData: "confirm_yes",
      })
    );
  });

  it("ignores callback query without message or data", async () => {
    const update = makeUpdate({
      callback_query: { id: "cb-2" },
    });

    processUpdate(update);
    expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("cb-2");
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores updates without message or callback_query", () => {
    processUpdate(makeUpdate());
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("text fragment reassembly", () => {
  let handler: ReturnType<typeof vi.fn<(msg: AssembledMessage) => Promise<void>>>;

  beforeEach(() => {
    handler = vi.fn<(msg: AssembledMessage) => Promise<void>>().mockResolvedValue(undefined);
    setMessageHandler(handler);
  });

  it("buffers consecutive long text fragments and flushes on timeout", async () => {
    const longText = "x".repeat(4000);

    // Fragment 1
    processUpdate(makeTextUpdate(longText + "-part1", 1, 100));
    expect(handler).not.toHaveBeenCalled();

    // Fragment 2 (consecutive message_id, within timeout)
    vi.advanceTimersByTime(500);
    processUpdate(makeTextUpdate(longText + "-part2", 2, 100));
    expect(handler).not.toHaveBeenCalled();

    // Flush after timeout
    vi.advanceTimersByTime(1500);
    await getQueuePromise("100");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        text: longText + "-part1\n" + longText + "-part2",
        messageId: 1,
      })
    );
  });

  it("buffers fragments from messages without from field", async () => {
    const longText = "y".repeat(4000);

    processUpdate(
      makeUpdate({
        message: {
          message_id: 1,
          chat: { id: 100 },
          text: longText,
          date: 1000,
        },
      })
    );

    vi.advanceTimersByTime(1500);
    await getQueuePromise("100");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ text: longText })
    );
  });

  it("does not buffer short messages", async () => {
    processUpdate(makeTextUpdate("short msg", 1, 100));

    await getQueuePromise("100");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ text: "short msg" })
    );
  });

  it("flushes existing buffer on non-consecutive message_id", async () => {
    const longText = "x".repeat(4000);

    // Start buffer
    processUpdate(makeTextUpdate(longText, 1, 100));

    // Non-consecutive id (gap)
    vi.advanceTimersByTime(500);
    processUpdate(makeTextUpdate("normal msg", 5, 100));

    await getQueuePromise("100");
    expect(handler).toHaveBeenCalledTimes(2);

    // First call: flushed buffer
    expect(handler.mock.calls[0][0].text).toBe(longText);
    // Second call: normal message
    expect(handler.mock.calls[1][0].text).toBe("normal msg");
  });

  it("flushes existing buffer when time gap exceeds threshold", async () => {
    const longText = "x".repeat(4000);

    processUpdate(makeTextUpdate(longText, 1, 100));

    // Advance past fragment timeout
    vi.advanceTimersByTime(2000);

    // Next message arrives after gap
    processUpdate(makeTextUpdate("next msg", 2, 100));

    await getQueuePromise("100");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("enforces hard cap on combined fragment length", async () => {
    const longText = "x".repeat(4000);

    // Start buffer
    processUpdate(makeTextUpdate(longText, 1, 100));

    // Add fragments until near the 50k cap
    for (let i = 2; i <= 12; i++) {
      vi.advanceTimersByTime(500);
      processUpdate(makeTextUpdate(longText, i, 100));
    }

    // Fragment 13 would exceed 50k — should flush and start new buffer
    vi.advanceTimersByTime(500);
    processUpdate(makeTextUpdate(longText, 13, 100));

    // Let first buffer flush
    await getQueuePromise("100");
    expect(handler).toHaveBeenCalled();

    // First call's text should be <= 50k
    const firstFlush = handler.mock.calls[0][0].text;
    expect(firstFlush.length).toBeLessThanOrEqual(50_000 + 100); // fragments joined with \n
  });
});

describe("media group buffering", () => {
  let handler: ReturnType<typeof vi.fn<(msg: AssembledMessage) => Promise<void>>>;

  beforeEach(() => {
    handler = vi.fn<(msg: AssembledMessage) => Promise<void>>().mockResolvedValue(undefined);
    setMessageHandler(handler);
  });

  it("buffers media group messages and flushes after timeout", async () => {
    processUpdate(
      makeUpdate({
        message: {
          message_id: 1,
          chat: { id: 100 },
          from: { id: 42 },
          media_group_id: "group-1",
          caption: "Photo 1",
          date: 1000,
        },
      })
    );

    processUpdate(
      makeUpdate({
        message: {
          message_id: 2,
          chat: { id: 100 },
          from: { id: 42 },
          media_group_id: "group-1",
          caption: "Photo 2",
          date: 1000,
        },
      })
    );

    expect(handler).not.toHaveBeenCalled();

    // Flush after 500ms
    vi.advanceTimersByTime(500);
    await getQueuePromise("100");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 100,
        text: "Photo 1\nPhoto 2",
        messageId: 1,
      })
    );
  });

  it("clears active timers when clearMediaGroupBuffers is called", async () => {
    processUpdate(
      makeUpdate({
        message: {
          message_id: 1,
          chat: { id: 100 },
          from: { id: 42 },
          media_group_id: "group-pending",
          caption: "pending",
          date: 1000,
        },
      })
    );

    // Clear before flush — handler should not be called
    clearMediaGroupBuffers();
    vi.advanceTimersByTime(1000);
    expect(handler).not.toHaveBeenCalled();
  });

  it("uses placeholder text when no captions in media group", async () => {
    processUpdate(
      makeUpdate({
        message: {
          message_id: 1,
          chat: { id: 100 },
          from: { id: 42 },
          media_group_id: "group-2",
          date: 1000,
        },
      })
    );

    vi.advanceTimersByTime(500);
    await getQueuePromise("100");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ text: "[media group]" })
    );
  });
});
