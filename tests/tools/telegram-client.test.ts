import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  config: {
    telegram: {
      botToken: "123:ABC",
    },
  },
}));

vi.mock("../../src/config.js", () => mockConfig);

import {
  sendTelegramMessage,
  sendTelegramVoice,
  sendChatAction,
  answerCallbackQuery,
} from "../../src/telegram/client.js";

let fetchSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  fetchSpy.mockRestore();
  errorSpy.mockRestore();
  vi.useRealTimers();
});

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function parseErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      description: "Bad Request: can't parse entities",
    }),
    { status: 400 }
  );
}

function otherErrorResponse(): Response {
  return new Response(
    JSON.stringify({ ok: false, description: "Bad Request: chat not found" }),
    { status: 400 }
  );
}

describe("sendTelegramMessage", () => {
  it("sends a message with HTML parse mode", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    await sendTelegramMessage("12345", "Hello");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain("/bot123:ABC/sendMessage");
    const body = JSON.parse(opts!.body as string);
    expect(body.chat_id).toBe("12345");
    expect(body.text).toBe("Hello");
    expect(body.parse_mode).toBe("HTML");
  });

  it("falls back to plain text on HTML parse error", async () => {
    fetchSpy
      .mockResolvedValueOnce(parseErrorResponse())
      .mockResolvedValueOnce(okResponse());

    await sendTelegramMessage("12345", "<b>broken<b>");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
    expect(secondBody.parse_mode).toBeUndefined();
  });

  it("does not retry on non-parse API errors", async () => {
    fetchSpy.mockResolvedValueOnce(otherErrorResponse());

    await sendTelegramMessage("12345", "Hello");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram API error [chat:12345]: Bad Request: chat not found"
    );
  });

  it("logs status code when API error has no description", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false }), { status: 500 })
    );

    await sendTelegramMessage("12345", "Hello");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram API error [chat:12345]: 500"
    );
  });

  it("retries on recoverable network errors with backoff", async () => {
    const econnreset = new Error("fetch failed");
    (econnreset as NodeJS.ErrnoException).code = "ECONNRESET";

    fetchSpy
      .mockRejectedValueOnce(econnreset)
      .mockResolvedValueOnce(okResponse());

    const promise = sendTelegramMessage("12345", "Hello");
    // Advance past 1s backoff (attempt 0: 1000ms)
    await vi.advanceTimersByTimeAsync(1100);
    await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up after max retries on network errors", async () => {
    const err = new TypeError("fetch failed");

    fetchSpy
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);

    const promise = sendTelegramMessage("12345", "Hello");
    // Advance timers for all retries: 1s + 2s + 4s
    await vi.advanceTimersByTimeAsync(8000);
    await promise;

    // 1 initial + 3 retries = 4 attempts
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram send failed [chat:12345]:",
      expect.any(TypeError)
    );
  });

  it("does not retry on non-recoverable errors", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("SyntaxError"));

    await sendTelegramMessage("12345", "Hello");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram send failed [chat:12345]:",
      expect.any(Error)
    );
  });

  it("chunks long messages at paragraph boundaries", async () => {
    fetchSpy.mockResolvedValue(okResponse());

    const paragraph1 = "A".repeat(3000);
    const paragraph2 = "B".repeat(3000);
    const longText = `${paragraph1}\n\n${paragraph2}`;

    await sendTelegramMessage("12345", longText);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    const body2 = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
    expect(body1.text).toBe(paragraph1);
    expect(body2.text).toBe(paragraph2);
  });

  it("chunks at line boundaries when no paragraph break", async () => {
    fetchSpy.mockResolvedValue(okResponse());

    const line1 = "A".repeat(3000);
    const line2 = "B".repeat(3000);
    const longText = `${line1}\n${line2}`;

    await sendTelegramMessage("12345", longText);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("hard-breaks when no boundaries found", async () => {
    fetchSpy.mockResolvedValue(okResponse());

    const longText = "A".repeat(5000);

    await sendTelegramMessage("12345", longText);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body1.text.length).toBe(4096);
  });

  it("does not chunk short messages", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    await sendTelegramMessage("12345", "Short message");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("attaches reply_markup only to the final chunk", async () => {
    fetchSpy.mockResolvedValue(okResponse());

    const longText = `${"A".repeat(3000)}\n\n${"B".repeat(3000)}`;
    const markup = {
      inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]],
    };

    await sendTelegramMessage("12345", longText, markup);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
    expect(firstBody.reply_markup).toBeUndefined();
    expect(secondBody.reply_markup).toEqual(markup);
  });
});

describe("sendChatAction", () => {
  it("posts typing action to the correct endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    await sendChatAction("12345", "typing");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain("/bot123:ABC/sendChatAction");
    const body = JSON.parse(opts!.body as string);
    expect(body.chat_id).toBe("12345");
    expect(body.action).toBe("typing");
  });
});

describe("sendTelegramVoice", () => {
  it("posts voice payload to sendVoice endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const ok = await sendTelegramVoice("12345", Buffer.from("voice-bytes"));

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain("/bot123:ABC/sendVoice");
    const form = opts!.body as FormData;
    expect(form.get("chat_id")).toBe("12345");
    expect(form.get("voice")).toBeTruthy();
  });

  it("includes caption when provided for voice replies", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const ok = await sendTelegramVoice(
      "12345",
      Buffer.from("voice-bytes"),
      "quick note"
    );

    expect(ok).toBe(true);
    const form = fetchSpy.mock.calls[0][1]!.body as FormData;
    expect(form.get("caption")).toBe("quick note");
  });

  it("returns false when Telegram API rejects voice send", async () => {
    fetchSpy.mockResolvedValueOnce(otherErrorResponse());

    const ok = await sendTelegramVoice("12345", Buffer.from("voice-bytes"));

    expect(ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram voice API error [chat:12345]: Bad Request: chat not found"
    );
  });

  it("logs status code when voice API error has no description", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false }), { status: 502 })
    );

    const ok = await sendTelegramVoice("12345", Buffer.from("voice-bytes"));

    expect(ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram voice API error [chat:12345]: 502"
    );
  });

  it("retries voice send on recoverable network errors", async () => {
    const recoverable = new Error("fetch failed");
    (recoverable as NodeJS.ErrnoException).code = "ECONNRESET";
    fetchSpy
      .mockRejectedValueOnce(recoverable)
      .mockResolvedValueOnce(okResponse());

    const promise = sendTelegramVoice("12345", Buffer.from("voice-bytes"));
    await vi.advanceTimersByTimeAsync(1100);
    const ok = await promise;

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns false after max retries on recoverable network errors", async () => {
    const recoverable = new Error("fetch failed");
    (recoverable as NodeJS.ErrnoException).code = "ECONNRESET";
    fetchSpy
      .mockRejectedValueOnce(recoverable)
      .mockRejectedValueOnce(recoverable)
      .mockRejectedValueOnce(recoverable)
      .mockRejectedValueOnce(recoverable);

    const promise = sendTelegramVoice("12345", Buffer.from("voice-bytes"));
    await vi.advanceTimersByTimeAsync(8000);
    const ok = await promise;

    expect(ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram voice send failed [chat:12345]:",
      expect.any(Error)
    );
  });
});

describe("answerCallbackQuery", () => {
  it("posts to the correct endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    await answerCallbackQuery("cb-123");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain("/answerCallbackQuery");
    const body = JSON.parse(opts!.body as string);
    expect(body.callback_query_id).toBe("cb-123");
  });
});
