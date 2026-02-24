import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSendTelegramMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../src/telegram/client.js", () => ({
  sendTelegramMessage: mockSendTelegramMessage,
}));

const mockConfig = vi.hoisted(() => ({
  config: {
    telegram: { botToken: "test-bot-token", allowedChatId: "100" },
  },
}));

vi.mock("../../src/config.js", () => mockConfig);

import { notifyError, _resetDedupState } from "../../src/telegram/notify.js";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockSendTelegramMessage.mockReset().mockResolvedValue(undefined);
  _resetDedupState();
  mockConfig.config.telegram.botToken = "test-bot-token";
  mockConfig.config.telegram.allowedChatId = "100";
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

describe("notifyError", () => {
  it("sends error notification to Telegram", () => {
    notifyError("test context", new Error("something broke"));

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("something broke")
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("<b>Error:</b> test context")
    );
  });

  it("handles non-Error values", () => {
    notifyError("test", "string error");

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("string error")
    );
  });

  it("deduplicates identical errors within 60s", () => {
    notifyError("ctx", new Error("dup"));
    notifyError("ctx", new Error("dup"));

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("allows different error messages", () => {
    notifyError("ctx", new Error("error A"));
    notifyError("ctx", new Error("error B"));

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(2);
  });

  it("skips when no botToken", () => {
    mockConfig.config.telegram.botToken = "";
    notifyError("test", new Error("fail"));

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("skips when no allowedChatId", () => {
    mockConfig.config.telegram.allowedChatId = "";
    notifyError("test", new Error("fail"));

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("truncates long error messages", () => {
    const longMessage = "x".repeat(5000);
    notifyError("test", new Error(longMessage));

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    const sentText = mockSendTelegramMessage.mock.calls[0][1] as string;
    expect(sentText.length).toBeLessThanOrEqual(4096);
  });

  it("wraps error in HTML tags", () => {
    notifyError("test ctx", new Error("boom"));

    const sentText = mockSendTelegramMessage.mock.calls[0][1] as string;
    expect(sentText).toContain("<b>Error:</b> test ctx");
    expect(sentText).toContain("<pre>boom</pre>");
  });

  it("handles send failure gracefully", () => {
    mockSendTelegramMessage.mockRejectedValueOnce(new Error("send failed"));
    notifyError("test", new Error("fail"));

    // Should not throw — fire-and-forget
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("evicts oldest dedup entry when buffer overflows", () => {
    // Send 6 unique errors — buffer max is 5
    notifyError("ctx", new Error("e1"));
    notifyError("ctx", new Error("e2"));
    notifyError("ctx", new Error("e3"));
    notifyError("ctx", new Error("e4"));
    notifyError("ctx", new Error("e5"));
    notifyError("ctx", new Error("e6"));

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(6);

    // e1 was evicted, so it should send again
    notifyError("ctx", new Error("e1"));
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(7);
  });

  it("evicts expired entries after dedup window", () => {
    vi.useFakeTimers();

    notifyError("ctx", new Error("timed"));
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);

    // Same error within window — deduplicated
    notifyError("ctx", new Error("timed"));
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);

    // Advance past 60s window
    vi.advanceTimersByTime(61_000);

    // Now the entry has expired — should send again
    notifyError("ctx", new Error("timed"));
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(2);
  });
});
