import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLogApiUsage, mockTranscriptionCreate, mockSpeechCreate, mockToFile } = vi.hoisted(() => ({
  mockLogApiUsage: vi.fn(),
  mockTranscriptionCreate: vi.fn(),
  mockSpeechCreate: vi.fn(),
  mockToFile: vi.fn().mockResolvedValue({ name: "voice.ogg" }),
}));

vi.mock("../../src/config.js", () => ({
  config: {
    telegram: {
      botToken: "123:ABC",
      voiceModel: "gpt-4o-mini-tts",
      voiceName: "alloy",
    },
    openai: { apiKey: "sk-test" },
    apiRates: { "whisper-1": { input: 0.006, output: 0 } },
  },
}));

vi.mock("../../src/db/client.js", () => ({
  pool: {},
}));

vi.mock("../../src/db/queries.js", () => ({
  logApiUsage: mockLogApiUsage,
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: mockTranscriptionCreate,
      },
      speech: {
        create: mockSpeechCreate,
      },
    },
  })),
  toFile: mockToFile,
}));

import {
  transcribeVoiceMessage,
  synthesizeVoiceReply,
  normalizeVoiceText,
} from "../../src/telegram/voice.js";

let fetchSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  mockLogApiUsage.mockReset();
  mockTranscriptionCreate.mockReset();
  mockSpeechCreate.mockReset();
  mockToFile.mockReset().mockResolvedValue({ name: "voice.ogg" });
});

afterEach(() => {
  fetchSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("transcribeVoiceMessage", () => {
  it("downloads and transcribes a voice message", async () => {
    // Mock getFile response
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "voice/file_123.ogg" } }),
        { status: 200 }
      )
    );

    // Mock file download
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("fake-ogg-data"), { status: 200 })
    );

    // Mock Whisper transcription
    mockTranscriptionCreate.mockResolvedValueOnce(
      "Hello, this is a voice message"
    );

    const text = await transcribeVoiceMessage("file_123", 5);

    expect(text).toBe("Hello, this is a voice message");

    // Verify Telegram getFile call
    expect(fetchSpy.mock.calls[0][0]).toContain("/getFile?file_id=file_123");

    // Verify file download
    expect(fetchSpy.mock.calls[1][0]).toContain("/file/bot123:ABC/voice/file_123.ogg");

    // Verify toFile was called with the buffer
    expect(mockToFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      "voice.ogg",
      { type: "audio/ogg" }
    );

    // Verify Whisper call
    expect(mockTranscriptionCreate).toHaveBeenCalledWith({
      model: "whisper-1",
      file: { name: "voice.ogg" },
      response_format: "text",
    });

    // Verify usage logging
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "openai",
        model: "whisper-1",
        purpose: "transcription",
        durationSeconds: 5,
        costUsd: expect.closeTo((5 / 60) * 0.006, 5),
      })
    );
  });

  it("throws when file path is not returned", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: {} }), { status: 200 })
    );

    await expect(transcribeVoiceMessage("bad_file", 3)).rejects.toThrow(
      "Failed to get file path"
    );
  });
});

describe("normalizeVoiceText", () => {
  it("strips Telegram HTML and normalizes whitespace", () => {
    const text = normalizeVoiceText("<b>Hello</b>\n\n&nbsp;world &amp; friends");
    expect(text).toBe("Hello world & friends");
  });
});

describe("synthesizeVoiceReply", () => {
  it("calls OpenAI speech API and returns audio bytes", async () => {
    mockSpeechCreate.mockResolvedValueOnce({
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("mp3-bytes")),
    });

    const audio = await synthesizeVoiceReply("<b>Hello there</b>");

    expect(Buffer.isBuffer(audio)).toBe(true);
    expect(mockSpeechCreate).toHaveBeenCalledWith({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "Hello there",
      response_format: "mp3",
    });
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o-mini-tts",
        purpose: "tts",
      })
    );
  });

  it("throws for empty text after normalization", async () => {
    await expect(synthesizeVoiceReply("<b> </b>")).rejects.toThrow(
      "Cannot synthesize an empty voice reply."
    );
  });

  it("returns audio even when usage logging fails", async () => {
    mockSpeechCreate.mockResolvedValueOnce({
      arrayBuffer: vi.fn().mockResolvedValue(Buffer.from("mp3-bytes")),
    });
    mockLogApiUsage.mockRejectedValueOnce(new Error("db down"));

    const audio = await synthesizeVoiceReply("Hello");

    expect(Buffer.isBuffer(audio)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      "TTS usage logging failed:",
      expect.any(Error)
    );
  });
});
