import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockTranscriptionCreate, mockSpeechCreate, mockToFile } = vi.hoisted(() => ({
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
    models: { openaiTranscribe: "whisper-1" },
  },
}));

vi.mock("../../src/db/client.js", () => ({
  pool: {},
}));

vi.mock("../../src/db/queries.js", () => ({}));

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
  normalizeVoiceText,
} from "../../src/telegram/voice.js";

let fetchSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

    // Verify toFile was called with the buffer + the real filename derived
    // from the Telegram file_path.
    expect(mockToFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      "file_123.ogg",
      { type: "audio/ogg" }
    );

    // Verify Whisper call
    expect(mockTranscriptionCreate).toHaveBeenCalledWith({
      model: "whisper-1",
      file: { name: "voice.ogg" },
      response_format: "text",
    });

  });

  it("labels a forwarded .m4a audio file with its real extension", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ result: { file_path: "music/file_99.m4a" } }),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(Buffer.from("fake-m4a-data"), { status: 200 })
    );
    mockTranscriptionCreate.mockResolvedValueOnce("transcribed audio");

    const text = await transcribeVoiceMessage(
      "file_99",
      39,
      "AUDIO-2026-05-23-16-04-48.m4a"
    );

    expect(text).toBe("transcribed audio");
    // Hint name wins over file_path, and the m4a extension drives the type.
    expect(mockToFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      "AUDIO-2026-05-23-16-04-48.m4a",
      { type: "audio/m4a" }
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

